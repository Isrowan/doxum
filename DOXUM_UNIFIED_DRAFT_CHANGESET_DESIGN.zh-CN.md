# Doxum 统一 Draft 与净变化协议重构方案

状态：待实施的目标设计。本文不表示这些能力已经落地。

## 1. 目标与决策

将 Doxum 收敛为一条主路径：

```text
schema 访问对象 / 外部 ChangeSet
  -> 同一个 mutation session
  -> canonical document 即时修改
  -> 事务首次旧状态记录
  -> 提交时生成净变化 ChangeSet
  -> impact / history / prepare / local-sync
```

优先级依次为：协议统一、职责清晰、复杂度低、正确性可验证、实际性能。
不为减少文件数把不同领域算法塞进同一个模块，也不为性能假设增加平行协议。

明确决定：

1. 不需要迁移方案、兼容层、弃用期、旧格式转换器或双版本运行。
2. 全面替换公开 reader/writer 访问协议，不新增一层包装保留旧实现。
3. `object()` 是可编辑结构；`field<T>()` 是只允许整体替换的原子值。
4. draft 只在同步事务中有效，修改立即可读；不使用全量 copy-on-write 或提交时全量 diff。
5. commit 只发布事务最终净变化，不保留逐次赋值和原始操作顺序。
6. 一个可逆 ChangeSet 同时服务提交、history、prepare 和同步重放。
7. 一个事务变更记录拥有首次旧状态；删除每次写入生成的正向/逆向操作日志及 journal 对 inverse 的反向解析。
8. 不自动追踪 projection processor 依赖。既有显式依赖、调度及通知顺序继续成立。
9. 不修改 whiteboard 等外部使用方；本仓库 core、React、同步模块、测试、示例和技能文档直接切换到最终协议。

本文是后续重构的决策依据。与 `docs/value-boundaries.md`、旧 API 说明及
`COLLABORATION_DESIGN.md` 中 operation-batch 协议冲突的内容，以本文目标为准。
实施时必须同步重写这些文档和相关 AGENTS 约束，不长期保留相互矛盾的规范。

## 2. 当前问题与替换范围

目前 `access/reader.ts` 和 `access/writer.ts` 分别创建访问树。字段经过
`get/set/update` 方法访问，事务持有 `read/write` 两个入口。最近的优化已减少
writer 闭包、共享最近父路径，并对纯字段 journal 延迟建树，但仍存在两套访问表示。

`mutation/session.ts` 为变化维护公开 forward 和 inverse 日志；journal 又保存首次
before、处理父子吸收和净变化。结构 journal 通过识别 inverse operation 恢复变化语义。
`history.ts` 保存正逆 operation batch，`prepare` 返回同类数组和独立 footprint，
`local-sync` 的 timeline/session 持久化、重放 `commit.operations`。

这些重复不是改成 Proxy 就会自然消失。必须从访问、执行记录、提交协议和消费者同时替换。

| 当前表示或入口                      | 角色和 owner                       | 最终处理                                                |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| canonical document                  | `createDocument`，唯一写入权威     | 保留，所有写入由 mutation session 控制                  |
| `DocumentReader` / `DocumentWriter` | 两套 schema 访问对象               | 删除，替换为同一实现的只读访问和事务 draft 类型         |
| `tx.read` / `tx.write`              | 事务访问边界                       | 删除，更新回调直接接收 draft，诊断上下文单独传入        |
| `ResolvedAddress`、schema selector  | 解析事实、地址身份                 | 保留单一地址语义，由 address/schema owner 管理          |
| 每次执行的 forward/inverse 数组     | session 中间表示                   | 删除，写入时不创建公开操作对象                          |
| journal subject 与 inverse 解析     | 事务旧状态和净变化                 | 重构为唯一 ChangeRecorder，直接接收执行器提供的变化事实 |
| `DocumentOperation` 联合            | 外部命令及内部执行协议混用         | 删除公开及内部旧操作协议，外部统一接收 ChangeSet        |
| `commit.operations/inverse`         | 提交边界                           | 删除，改为 `commit.changes`                             |
| `CommandFootprint`                  | 从 operations 推导的另一套地址目标 | 删除，冲突范围从 ChangeSet 经同一 target 规则推导       |
| `DocumentImpact`                    | 增量查询                           | 保留能力，只从 ChangeSet 派生，不暴露 operations        |
| history operation batches           | 本地撤销数据                       | 保存可逆 ChangeSet，按方向应用                          |
| prepare operation arrays            | 未提交转换                         | 返回同一个 ChangeSet 及起始 revision                    |
| local-sync operation codec          | 持久化边界                         | 切换到新的 ChangeSet codec；不读取或转换旧日志          |

## 3. 统一的公开访问模型

### 3.1 事务与只读访问

目标调用形式：

```ts
document.update((draft, tx) => {
  const task = draft.tasks[taskId];
  if (!task) tx.reject({ code: 'missing-task', message: 'Task does not exist.' });

  task.position.x += 1;
  task.position.y = task.position.x + 2;
  task.payload = { ...task.payload, x: task.payload.x + 1 };
});

const x = select(document, state => state.tasks[taskId]?.position.x);
const tasks = select(document, state => snapshot(state.tasks));
```

`tx` 仅保留 `report/reject` 等事务控制，不再持有数据访问树。
schema 业务字段可以叫 `get`、`set`、`update`、`report`，不会与对象工具属性冲突。

同一个访问实现接收只读或事务上下文。对外类型分别表达 `Read` 和 `Draft`，
这只是权限差异，不是两套访问算法或缓存。保留 `Infer` 表达独立数据值；不把
`Draft`、`Read` 与 `Infer` 混同，也不增加每种节点的多套公开 helper 类型。

只读访问中写入会运行时拒绝。结构对象、集合访问对象及 draft 在作用域结束后失效，
不得作为可持久保存的值从 callback 返回；需要保留数据时使用 `snapshot`。
逃逸后的失效检查必须存在，不能仅靠 TypeScript 约束。

细粒度读取保留为普通属性读取。读取依赖记录发生在实际读取的位置：字段值、
实体存在性、集合成员及顺序分别记录；不能因为访问父代理就自动订阅整个子树。
`snapshot` 明确记录对应子树依赖。React 和 projection 的读取回调使用同一实现。

### 3.2 节点访问规则

| schema 节点  | 读取                                   | draft 修改                                     |
| ------------ | -------------------------------------- | ---------------------------------------------- |
| `field<T>()` | 返回深只读的原子 T                     | 只能整体赋值；optional 支持删除属性            |
| `object()`   | 返回结构访问对象                       | 对声明字段赋值；不支持整个普通 object 隐式替换 |
| `map()`      | 领域键索引得到实体访问对象或 undefined | 新增/删除键；编辑已有实体字段                  |
| `dict()`     | 领域键索引得到原子值                   | 键赋值、删除；值内部不可编辑                   |
| `variant()`  | 当前分支的判别联合访问对象             | 编辑当前分支字段，或整体赋值切换分支           |
| `table()`    | 实体访问和显式顺序视图                 | 保留 create/remove/move 等结构能力             |
| `list()`     | 按稳定键读取原子 item，显式顺序        | 插入、删除、移动、整体替换 item                |
| `tree()`     | 节点值及拓扑只读访问                   | 显式插入、删除、移动、替换节点原子值           |

不把 table/list/tree 伪装成普通数组，不支持用 `splice`、任意数字索引或修改
`parentId/children` 来绕过身份、顺序和树约束。集合工具属于集合能力，不给每个
schema object 注入工具方法。具体结构方法名称可按现有 anchor/key API 收敛，不能
保留一套旧 writer 再由 draft 转发。

map 对已有 id 的整体赋值定义为该实体值替换，schema 驱动产生对应净变化；不存在的
id 赋值是创建。重复写入和替换的含义必须唯一，不能同时保留 create/upsert/set 三套
语义重叠入口。实体生命周期身份若将来需要超出键本身，应由领域模型显式携带。

领域键类型贯穿索引、结构操作、selector、ChangeSet 查询及 impact。对 branded key
的错误索引必须有类型测试，不能为了方便退化为 `[key: string]`。若某种 TypeScript
索引表达无法维持该保证，应使用集合专属的类型化访问方法，而不是牺牲键类型。

### 3.3 原子字段边界

`field<{ x: number; y: number }>()` 永远不支持 `draft.payload.x++`。
它也不支持在内部数组调用 push、修改嵌套 Map、Date 等。修改必须先在字段外构造新值，
再整体赋值。类型层面提供深只读视图；不为 payload 创建深层 draft Proxy。

本轮沿用既有原子 payload 的所有权契约：使用方不得修改从字段读取或已交给运行时的
对象。这是明确的修改边界，不新增全量冻结、每次读取复制或防御性代理系统。
因此“禁止内部修改”不宣称能在 JavaScript 层拦截所有违规行为；特别是
`Object.freeze` 也不能禁止 Map/Date 内部修改。只读类型与文档必须准确表达此边界。

`snapshot` 继续返回独立值，沿用 schema copier 和 opaque 类型规则；对独立快照的
修改不会改变 canonical。外部解析与字段校验规则继续由 schema-value 统一拥有。

### 3.4 Proxy 行为必须明确

- 同一作用域、同一有效地址访问得到稳定代理；不跨事务复用。
- 子代理是地址访问器。实体删除后读取返回不存在或按当前 API 明确报错，写入拒绝；
  同 id 重建后重新解析新实体，不能写回已脱离文档的旧对象。
- variant 切换后旧分支访问必须重新经过当前 schema，不能绕过新分支字段约束。
- `in`、键枚举和迭代分别记录存在性或成员依赖；枚举成本按结果规模计算。
- 拒绝 `defineProperty`、原型修改、未声明结构属性写入等无法映射到 schema 的操作。
- 结构 Proxy 使用独立代理 target，不拿 frozen canonical 作为 target，遵守 Proxy invariant。
- `snapshot` 是结构值导出入口，不把代理 JSON 序列化作为持久化协议。

## 4. 唯一事务记录与即时修改

`mutation/session` 继续是唯一写入协调者。引入的 ChangeRecorder 替换现有 journal
和执行日志，而不是第三份数据结构。它拥有事务开始以来被触及位置的首次旧状态。

```text
1. 解析当前 schema 和地址
2. 校验输入、键及结构规则
3. 相等或无效果则结束
4. 在写入前捕获首次旧状态，必要时吸收子记录
5. 执行 canonical 修改
6. 成功结束时从被触及位置读取最终状态并 seal
7. 任意失败则从记录恢复，关闭整个作用域
```

执行器直接告诉 recorder 修改的是字段、实体存在性、顺序或树拓扑。
recorder 不接收 inverse operation，不再解析 operation.type 来猜测 before。
字段值、存在性、顺序分别有单一 owner，禁止 executor、recorder、impact 各自重新推导。

### 4.1 首次旧状态与吸收

- 同一字段多次赋值只保存一次 before，不追加公开 operation 或 inverse。
- presence 与 value 分开表达；缺失和存在但值为 undefined 不等价。
- 创建实体时记 absent，之后的内部字段修改由创建记录覆盖。
- 删除实体前保存事务起始实体值，吸收此前已改字段的 before。
- 删除后重建同 id，最终按起始与最终实体值比较，不能仅因执行过删除就通知全部字段。
- variant 或其他真实子树替换吸收旧子记录。最终 seal 时如仍属同一结构，可在该已触及
  子树中生成精确差异；不得扩大到其他实体或整个文档。
- 回滚使用首次状态，不再执行用户校验器，也不运行用户 updater 或重放业务回调。
- 记录、写入和结构恢复顺序由 recorder 与对应领域执行器明确配合，不依赖原始赋值顺序。

### 4.2 顺序与树结构

简单字段首次状态不足以恢复所有结构。表、列表顺序和树拓扑必须有明确的结构记录。

先采用可解释的策略：第一次改变某个顺序序列时保存该序列，后续修改不再重复保存；
seal 比较 before/after。树记录被触及节点的存在性、原子值、parent 和受影响的 child
顺序；不复制未触及的兄弟子树。子树删除的成本允许与被删除子树规模成正比。

一个长度为 N 的数组序列重排可能需要 O(N) 工作和一次 O(N) 快照，这个成本必须在
基准和文档中明示；不能把字段单点更新也拖入此路径。只有基准证明真实结构工作负载
需要时，再在 anchor/tree owner 内改进存储，不预先叠加链表、位置 token 和多级缓存。

回滚按依赖恢复：先恢复必要容器和节点存在性，再恢复值与拓扑/顺序，再清理应缺失的
对象。树的 reciprocal links、单根、连通、无环由 tree owner 保证。不能通过逐条套用
公开变更、在临时无效树上反复做完整校验来实现恢复。

## 5. ChangeSet 与提交协议

### 5.1 一份双向状态转换

commit 的核心为不可变、可逆的 `ChangeSet`。基本事实是某个 schema 位置的
`before -> after`，不是用户执行过哪些方法。

目标公开结构示意：

```ts
type DocumentCommit<S> = {
  readonly revision: number;
  readonly source: CommitSource;
  readonly changes: ChangeSet<S>;
  readonly impact: DocumentImpact<S>;
};
```

ChangeSet 区分以下实际语义，不用通用 JSON Patch 路径模拟全部结构：

| 变化事实         | 最小必要内容                                                  |
| ---------------- | ------------------------------------------------------------- |
| 原子值           | schema 地址、before presence/value、after presence/value      |
| 实体或键项存在性 | 容器地址、稳定键、before/after 项；保留的实体优先输出字段差异 |
| 顺序             | 集合地址、必要的 before/after 顺序数据                        |
| 树拓扑           | 树地址、被触及节点身份及 before/after 拓扑事实                |
| 根替换           | 显式 reset 转换；允许全量成本                                 |

此表定义语义，不要求公开五套冗余容器类。实现时最小 tagged union 即可；同一 fact
不能既写在实体记录又写在子字段记录中。schema 地址仍由 address/schema 解析，
tree node id、list key 等结构身份由各自领域模型解释，不增加另一套字符串路径格式。

不单独存一份 `inverse`。向前应用取 after，向后应用取 before。跨序列化边界的
ChangeSet 不包含 canonical 引用、Proxy、Map 缓存、schema 对象或可执行函数。
opaque payload 的编解码能力属于 adapter，core 不假设所有字段都能 JSON 序列化。

### 5.2 净变化与相等规则

| 事务行为                       | 最终结果                     |
| ------------------------------ | ---------------------------- |
| 字段 0 -> 1 -> 3               | 一条 0 -> 3                  |
| 字段 0 -> 1 -> 0               | 没有变化                     |
| absent -> undefined（present） | 存在性变化，不能删掉         |
| 创建后编辑实体                 | 一条最终实体创建             |
| 创建后删除                     | 没有变化                     |
| 修改后删除                     | 删除及事务开始时的恢复值     |
| 删除重建并恢复原数据和顺序     | 没有变化                     |
| 同一项多次移动                 | 最终顺序变化，不保留移动过程 |

原子字段继续使用其既有值相等契约，默认 Object.is；不为了“净变化”对每个对象字段
进行深比较。结构节点按 schema/身份/顺序比较。序列化场景需由 codec 定义传输值等价，
不能拿跨进程对象引用相等作为 before 前置条件。

ChangeSet 非空才递增 revision、记录 history、通知外部。处理器仍先于普通观察者完成；
观察者异常属于已提交结果，不允许重新解释为事务失败。

### 5.3 应用、替换和 Prepare

- `apply(changes)` 接收 unknown，在一个边界完成 decode、格式归一、schema 和结构校验，
  通过相同 mutation session 原子应用；拒绝旧 DocumentOperation 数组。
- 输入中的 before 不是可信的本地 undo 数据。应用端记录自己的真实首次状态并生成
  本地 commit，不能直接把来包 before 填进 history。
- 基线匹配由 prepare revision、本地同步 seq/epoch 或协同前置条件明确控制；
  不增加默认静默覆盖冲突的 fallback。
- 多条结构事实作为一个原子转换验证和安装。禁止任意外部条目顺序影响最终语义，
  重叠、重复、相互矛盾的条目必须拒绝。
- `prepare((draft, tx) => ...)` 执行后恢复 canonical，返回 baseRevision、changes、
  reports/value；不递增 revision，不通知。后续应用必须检查基线仍匹配。
- `replace` 保留显式 reset 能力，使用同一提交结果和 ownership 边界。全量替换成本
  与 history 是否清空应保持明确规则，不伪装成普通增量字段写入。

## 6. Impact、History 与同步

### 6.1 Impact 与 Projection

impact 只从 sealed ChangeSet 派生，不再读取逐次操作或维护第二套独立 changes 数组。
集合的 added/removed/updated/orderChanged 和字段 affects 由同一事实索引解释。
字段索引、集合索引按查询需要创建；集合查询不应强制为所有字段建树。

projection 仍由声明的 source/dependency 驱动。读取回调改用统一只读访问；动态切换
声明依赖、稳定引用、dispose、显式 batch 的发布时机保持测试覆盖。订阅、React 和
同步的冲突范围都通过 impact-target/address owner 理解地址，不就地解包路径形状。

### 6.2 本地 History

每个历史条目持有一个或多个完整 commit ChangeSet。undo 逆序按 before 应用，redo
顺序按 after 应用；一组 history 的旅行仍是一次原子事务和一次对外提交。

history group 可以先保留 commit ChangeSet 序列，不急于新增跨事务 compose 算法。
这里保留的是独立事务的状态转换，不是每次赋值日志。压缩长历史是独立存储策略，
不能让主 mutation 路径承担未经验证的合并复杂度。

本地 history 继续对 remote/reset 按明确策略失效。未来协作撤销由 adapter 处理，
不能直接回填 before 覆盖他人的后续修改。

### 6.3 Local Sync

完整替换 `local-sync/timeline.ts`、`session.ts`、JSON codec 和相关契约：

- leader 持久化 sealed ChangeSet，follower 按严格 seq/epoch 应用。
- 保留当前单写者、先内存可见后异步落盘、flush 和错误状态语义。
- codec 校验值、大小、schema/协议版本；拒绝不支持的 opaque 值。
- 新持久化协议使用新的格式版本，旧格式明确报错，不自动清库、覆盖或转换旧数据。
- checkpoint + 新 ChangeSet tail 必须重放得到同一文档；不能根据旧 operations 重建。

### 6.4 未来 Collab

净变化足够表达已接受事务的状态转换，不代表保留了业务意图。两个并发 `x += 1`
都得到 x=1，单凭 before/after 无法推出 increment 语义。文本编辑、计数器、并发排序
如有要求，应使用明确领域能力或 adapter 协议，不反向恢复逐次字段赋值日志。

服务端排序、base revision、冲突拒绝/合并、actor、幂等 commandId 和协作撤销属于
协同边界。接受一个候选转换后，应基于服务端真实旧状态生成 accepted ChangeSet；
不能让 stale before 成为撤销依据。只做写集合 overlap 也不足以防止读取依赖失效，
条件业务命令需要前置条件或显式意图，不能声称净变化 footprint 是完整冲突检测。

本轮只重写已有协同设计中与净变化协议冲突的部分，不凭空实现完整 collab 系统。

## 7. 模块归属与删除清单

| 目标构造           | 表示角色、生命周期    | owner / 消费者                           | 替换或删除                                           |
| ------------------ | --------------------- | ---------------------------------------- | ---------------------------------------------------- |
| 统一 schema access | scoped resolved view  | access；select、draft、React、projection | 两套 reader/writer 工厂、字段 get/set/update、双缓存 |
| Draft/Read 类型    | 权限边界              | schema/access 公共入口                   | DocumentReader/Writer 及节点级旧公开类型             |
| ChangeRecorder     | session；仅一次事务   | mutation；字段及结构执行器               | journal inverse 解析、每操作 forward/inverse 日志    |
| ChangeSet          | sealed boundary value | mutation；commit、prepare、history、同步 | DocumentOperation、独立 inverse、operation footprint |
| ChangeSet 边界模块 | decode/validate/seal  | mutation；外部 apply、codec              | operation.ts 的旧 envelope 协议                      |
| ChangeSet impact   | 派生查询；一次 commit | impact/impact-target                     | operations 派生路径、独立 footprint 地址规则         |

优先改造已有模块。边界模块可将 `mutation/operation.ts` 直接重命名为
`mutation/change.ts`；`journal.ts` 可改名为 `recorder.ts`。重命名代表职责变化，
不能保留旧模块 re-export。`mutation/tree.ts`、`anchor.ts` 继续拥有结构算法。
外部输入的解析必须先于执行器，领域执行器不承担 JSON envelope 解析。

跨仓库内部范围包括：core 根入口、integration、local-sync、react、对应 dist 声明、
README、architecture、旧 migration 文档、COLLABORATION_DESIGN、技能指南和示例。
旧 migration 文档中不再适用的 API 指引删除或改为当前契约说明，不增加迁移章节。
构建产物只能重建，不能手改。

## 8. 性能策略

已测当前基线：Node v24.11.1/macOS，test.mjs 三轮，每轮预热 20 帧、测量 60 帧。
10,000 实体全量更新两字段，read+set 平均 29.57ms/P95 38.48ms，update 平均
21.22ms/P95 26.59ms。独立运行与同进程运行存在 JIT/GC 差异，不能只取最好结果。

新设计的合理收益来源：

1. 一个结构代理承担读写，不再生成标量字段访问对象和方法闭包。
2. 父结构定位就近复用；不建立跨事务 canonical 缓存。
3. 同字段首次记录一次，提交时只发布最终值，删除逐次操作构造和冻结。
4. recorder 直接收到变化事实，不从 inverse 重建语义。
5. impact/history/sync 共享 sealed ChangeSet，不复制成各自的操作表示。

Proxy trap、作用域检查、按键缓存和枚举本身有成本，不能预先承诺比现有访问器快。
20,000 个不同字段各改一次时仍有 20,000 个净变化，不能靠压缩数字掩盖成本。
不关闭 profiler 计数、校验、undo 或订阅来制造对比，不以每帧整体替换 entity/map
缩短操作数量。短路必须在必要校验后进行。

默认不实现对象池、动态代码生成、跨事务代理池、worker、异步提交、自动依赖图、
完整 Immer 引擎或 CRDT。只在数据支持且无法通过减少表示解决时考虑额外机制。

## 9. 实施阶段

各阶段是一次目标改造的内部工作顺序，不是对外兼容版本。允许开发分支临时未完成，
不允许最终同时发布新旧协议。

### 阶段 A：锁定协议与行为样例

- [ ] 定义 Draft/Read、节点操作表、作用域和原子字段所有权语义。
- [ ] 定义最小 ChangeSet 联合、presence、顺序、拓扑和 reset 规则。
- [ ] 固定 apply/prepare 基线规则及 history group 行为。
- [ ] 为当前基线保留可重复运行脚本和结构操作基准。

### 阶段 B：先替换事务事实源

- [ ] 执行器在写入前直接记录首次旧状态，失败恢复不重新运行用户代码。
- [ ] 字段、实体、variant、dict、list、tree 全部改用同一 recorder。
- [ ] 实现父子吸收、结构恢复和 seal 净变化。
- [ ] 删除 forward/inverse 执行日志、journal inverse 解析和重复索引。

### 阶段 C：切换提交与全部消费者

- [ ] commit、apply、prepare、replace 切换 ChangeSet。
- [ ] impact、history、footprint 消费统一变化事实，删除旧操作协议。
- [ ] local-sync codec、timeline、follower replay 切换新格式并验证恢复。
- [ ] 更新同步设计文档和 AGENTS 所有权要求，删除旧格式兼容假设。

### 阶段 D：统一 Draft 与读取

- [ ] 实现同一 schema access 的只读和事务权限模式。
- [ ] 接通赋值、删除、成员访问、variant、集合领域操作和 snapshot。
- [ ] 切换 select、projection、React、prepare 及仓库内所有示例。
- [ ] 删除 reader/writer 公共类型、旧工厂、get/set/update 协议和适配包装。

### 阶段 E：验证、清理与性能收敛

- [ ] 随机模型测试覆盖事务提交、回滚和 ChangeSet 双向重放。
- [ ] 建立 draft 与旧基线相同数据/操作规模的测量，报告均值、P95、GC 和分配。
- [ ] 搜索并删除旧 API、旧 operation envelope、旧 inverse 消费者及重复地址规则。
- [ ] 更新文档、技能、包导出，运行 check/build/bench/profile 和 ESM/CJS smoke。

## 10. 验收标准

### 语义

- 原子字段内部修改在类型层面被拒绝，整体替换可校验、回滚和撤销。
- absent/undefined、NaN、-0、对象引用相等、optional 删除均有明确测试。
- 字段重复写、新建后编辑/删除、删除重建、variant 往返不会产生虚假净变化。
- 保留的子 draft 在结构变化后不会访问失效 canonical 对象。
- 事务内即时读取、嵌套写入限制、异步 callback 拒绝、scope 失效行为正确。
- 任意晚期拒绝恢复完整起始状态；prepare 无 revision、通知或 canonical 泄漏。
- 对合法状态 A 和 B，seal(A -> B) 向前重放得到 B，向后重放得到 A。
- history group、tree 父子恢复、list/table 顺序和 root reset 都通过模型测试。
- 伪造 ChangeSet、冲突条目、非法树、非法键、错误基线整批拒绝。

### 增量与同步

- unrelated commit 不触发无关订阅/投影；稳定引用、依赖切换、dispose 和 batch 行为不变。
- 处理器先 settle 后通知外部，观察者异常不会造成 canonical 回滚。
- local-sync checkpoint + tail、leader/follower 切换、落盘失败及旧格式拒绝有测试。
- 不泄露第二套 footprint/地址解析或手工同步的物化缓存。

### 性能与工程

- 大集合单字段更新不遍历、复制其他实体；无变化 typed/draft 写不创建公开变更项。
- 同字段写 M 次仅保留一个首次旧状态及最终变化，内存不随 M 线性增长。
- 结构快照只发生在实际结构变化路径，相关 O(N) 成本可测且已记录。
- 保留全量、稀疏、重复写、无变化、字段订阅零/部分/全命中和 impact 查询基准。
- 不设未经实测保证的 16.7ms 承诺；如 Proxy 或净变化构造退化，先修访问/记录表示，
  不把旧 reader/writer 作为第二套永久性能入口恢复。
- `pnpm run check`、`build`、`bench`、`profile`、包级类型及 ESM/CJS 验证通过。
- 仓库内不存在旧协议活跃调用、兼容别名、旧格式回退和手改 dist。

完成的判据是上述统一模型和全部消费者一致，而不是仅让 draft 示例运行或只优化字段
快路径。结构语义的必要复杂度保留在对应 owner，重复表示与协议转换必须删除。
