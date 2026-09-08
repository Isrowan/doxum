# Doxum 统一 Draft 与净变化协议重构方案

状态：阶段 A-E 已完成。实现与验收记录更新于 2026-09-08；性能限制见第 11 节。

## 1. 目标与决策

将 Doxum 收敛为一条主路径：

```text
schema 访问对象 / 外部 ChangeSet
  -> 同一个 mutation session
  -> canonical document 即时修改
  -> 事务首次旧状态记录
  -> 提交时生成净变化 ChangeSet
  -> impact / history / local-sync
```

优先级依次为：协议统一、职责清晰、复杂度低、正确性可验证、实际性能。
不为减少文件数把不同领域算法塞进同一个模块，也不为性能假设增加平行协议。

明确决定：

1. 不需要迁移方案、兼容层、弃用期、旧格式转换器或双版本运行。
2. 全面替换公开 reader/writer 访问协议，不新增一层包装保留旧实现。
3. `object()` 是可编辑结构；`field<T>()` 是只允许整体替换的原子值。
4. draft 只在同步事务中有效，修改立即可读；不使用全量 copy-on-write 或提交时全量 diff。
5. commit 只发布事务最终净变化，不保留逐次赋值和原始操作顺序。
6. 一个可逆 ChangeSet 同时服务提交、history 和同步重放。
7. 一个事务变更记录拥有首次旧状态；删除每次写入生成的正向/逆向操作日志及 journal 对 inverse 的反向解析。
8. 不自动追踪 projection processor 依赖。既有显式依赖、调度及通知顺序继续成立。
9. 不修改 whiteboard 等外部使用方；本仓库 core、React、同步模块、测试、示例和技能文档直接切换到最终协议。
10. `update` 只接收单参数 draft 回调，不保留 tx 控制对象。预期业务拒绝
    使用 `TransactionRejected`；业务提示通过回调返回值表达，不设 reports 通道。
11. 删除 `dict()`，统一为 `map(valueSchema, { key })`。容器统一管理键项存在性，
    value schema 决定条目是原子值还是可编辑结构，不保留独立 dictionary 协议。
12. 删除没有生产使用方的 prepare 能力，不移动到 integration，也不保留隐藏实现。
13. 删除公开 schema() 构造器及 DocumentSchema 包装，直接以根 object 定义文档：
    `createDocument({ schema: model, initial })`。根节点承担数据定义身份，runtime 承担实例身份。
14. 保留 table/list 的现有存储与身份区别；容器统一用 value schema 解释值、校验和快照。
15. variant 判别字段只读，分支切换只能整体替换。回滚允许必要的内部恢复顺序；
    ChangeSet 使用规范化形式，不追求任意排列可执行或全局最小 patch。
16. 常用入口直接表达修改、读取、订阅和集合投影。不公开 document.target()，
    路径在消费入口解析，目标对象及匹配协议留在内部。

本文记录本次重构的决策与最终协议。`docs/value-boundaries.md`、README、
architecture、COLLABORATION_DESIGN、AGENTS 和随包技能指南已同步更新；
原 API/projection migration 文档已删除，不保留旧协议使用说明。

## 2. 重构前问题与替换范围

重构前 `access/reader.ts` 和 `access/writer.ts` 分别创建访问树。字段经过
`get/set/update` 方法访问，事务持有 `read/write` 两个入口。最近的优化已减少
writer 闭包、共享最近父路径，并对纯字段 journal 延迟建树，但仍存在两套访问表示。

`mutation/session.ts` 为变化维护公开 forward 和 inverse 日志；journal 又保存首次
before、处理父子吸收和净变化。结构 journal 通过识别 inverse operation 恢复变化语义。
`history.ts` 保存正逆 operation batch，`prepare` 返回同类数组和独立 footprint，
`local-sync` 的 timeline/session 持久化、重放 `commit.operations`。

这些重复不是改成 Proxy 就会自然消失。必须从访问、执行记录、提交协议和消费者同时替换。

| 当前表示或入口                      | 角色和 owner                       | 最终处理                                                  |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| canonical document                  | `createDocument`，唯一写入权威     | 保留，所有写入由 mutation session 控制                    |
| `DocumentReader` / `DocumentWriter` | 两套 schema 访问对象               | 删除，替换为同一实现的只读访问和事务 draft 类型           |
| `tx.read` / `tx.write`              | 事务访问边界                       | 删除，更新回调只接收 draft                                |
| `tx.report/reject`、结果 `reports`  | 事务控制及业务诊断通道             | 删除；回调返回业务结果，TransactionRejected 表达预期拒绝  |
| `ResolvedAddress`、schema selector  | 解析事实、地址身份                 | 保留单一地址语义，由 address/schema owner 管理            |
| 每次执行的 forward/inverse 数组     | session 中间表示                   | 删除，写入时不创建公开操作对象                            |
| journal subject 与 inverse 解析     | 事务旧状态和净变化                 | 重构为唯一 ChangeRecorder，直接接收执行器提供的变化事实   |
| `DocumentOperation` 联合            | 外部命令及内部执行协议混用         | 删除公开及内部旧操作协议，外部统一接收 ChangeSet          |
| `commit.operations/inverse`         | 提交边界                           | 删除，改为 `commit.changes`                               |
| `CommandFootprint`                  | 从 operations 推导的另一套地址目标 | 删除，冲突范围从 ChangeSet 经同一 target 规则推导         |
| `DocumentImpact`                    | 增量查询                           | 保留能力，只从 ChangeSet 派生，不暴露 operations          |
| history operation batches           | 本地撤销数据                       | 保存可逆 ChangeSet，按方向应用                            |
| prepare、PreparedUpdateResult       | 当前未使用的预执行能力             | 删除 API、实现、导出、权限分支及专属结果                  |
| schema() / DocumentSchema 包装      | 额外的根定义与身份表示             | 删除；根 ObjectNode 直接用于 createDocument、Infer、parse |
| local-sync operation codec          | 持久化边界                         | 切换到新的 ChangeSet codec；不读取或转换旧日志            |

## 3. 统一的公开访问模型

### 3.1 事务与只读访问

目标调用形式：

```ts
document.update(draft => {
  const task = draft.tasks[taskId];
  if (!task) {
    throw new TransactionRejected({
      code: 'missing-task',
      message: 'Task does not exist.',
    });
  }

  task.position.x += 1;
  task.position.y = task.position.x + 2;
  task.payload = { ...task.payload, x: task.payload.x + 1 };
});

const x = select(document, state => state.tasks[taskId]?.position.x);
const tasks = select(document, state => snapshot(state.tasks));
```

不传入第二个 tx 参数，也不给 draft 注入事务控制方法。
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

### 3.1.1 含集合的赋值类型

TypeScript 的映射属性不能同时表达“读取为集合工具、赋值为普通 Infer 数据”两个类型。
最终保留直接属性赋值作为常用入口；含 table/list/tree 的 map 项、variant 整体替换、
optional 容器初始化使用独立的 `assign(container, key, value)`：

```ts
const model = object({
  entries: map(object({ rows: table(object({ n: field<number>() })) })),
});
const document = createDocument({ schema: model, initial: { entries: {} } });
document.update(draft => {
  assign(draft.entries, 'a', { rows: { ids: [], byId: {} } });
  draft.entries.a!.rows.create({ id: 'x', value: { n: 1 } });
});
```

assign 的 key/value 由作用域对应 Infer 推导，不增加 writer 或第二种执行协议；
它也不能修改只读作用域、绕过普通 object 的替换约束或直接改 variant tag。
没有向 schema object 注入保留方法名。

`snapshot(scope)` 按 schema 调用字段 copier。单独原子值没有 schema 元数据，
`snapshot(rawAtomic)` 使用通用复制；自定义 opaque copier 应通过所属结构快照触发。

### 3.2 节点访问规则

| schema 节点        | 读取                                                     | draft 修改                                     |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| `field<T>()`       | 返回深只读的原子 T                                       | 只能整体赋值；optional 支持删除属性            |
| `object()`         | 返回结构访问对象                                         | 对声明字段赋值；不支持整个普通 object 隐式替换 |
| `map(valueSchema)` | 领域键索引；缺失为 undefined，存在项按 value schema 读取 | 键赋值、删除；仅结构值支持内部字段编辑         |
| `variant()`        | 当前分支的判别联合访问对象                               | 编辑普通字段；判别字段只读，整体替换切换分支   |
| `table()`          | 实体访问和显式顺序视图                                   | 保留 create/remove/move 等结构能力             |
| `list()`           | 按稳定键读取原子 item，显式顺序                          | 插入、删除、移动、整体替换 item                |
| `tree()`           | 节点值及拓扑只读访问                                     | 显式插入、删除、移动、替换节点原子值           |

list 的独立值保持普通数组，table 保持 ids/byId，tree 保持现有拓扑表示。
本轮不新增数组式 draft splice、任意数字索引写入或直接修改 parentId/children 来绕过
身份、顺序和树约束。集合工具属于集合能力，不给每个
schema object 注入工具方法。具体结构方法名称可按现有 anchor/key API 收敛，不能
保留一套旧 writer 再由 draft 转发。

map 对已有键的赋值定义为条目值替换，schema 驱动产生对应净变化；不存在的键赋值
是创建。重复写入和替换的含义必须唯一，不能同时保留 create/upsert/set 三套语义
重叠入口。键只表达容器内的寻址身份；值是 object 不意味着自动拥有额外实体生命周期
规则。删除后键是否可复用、协同时是否需要 generation，属于显式领域或同步约束。

统一 map 的声明与使用：

```ts
const model = object({
  scores: map(field<number>()),
  positions: map(field<{ x: number; y: number }>()),
  tasks: map(object({ title: field<string>(), done: field<boolean>() }), { key: taskIdValidator }),
});
const document = createDocument({ schema: model, initial });

document.update(draft => {
  draft.scores[playerId] = 10;
  delete draft.scores[otherPlayerId];

  draft.positions[positionId] = { x: 1, y: 2 };
  // draft.positions[positionId].x++ 禁止：条目是原子值。

  const task = draft.tasks[taskId];
  if (task) task.done = true;
  draft.tasks[newTaskId] = { title: 'New task', done: false };
  delete draft.tasks[oldTaskId];
});
```

统一规则：

- `field` 条目只能整体替换；`object/variant` 条目的内部访问由对应结构 schema 决定。
- key validator 只负责键，值校验通过 value schema；删除独立的 dict value-validator 配置。
- 键缺失属于容器存在性，不由 value schema 的 optional 代替。已存在条目是否允许
  undefined 由值 schema 决定，赋值 undefined 不等于删除；使用存在性查询区分两者。
- 所有 map 共享 added/removed/updated impact、领域键类型、snapshot 和 projection
  collection 能力，原子值条目不再走单独的 dictionary 分支。
- 本轮开放 field/object/variant 作为直接 value schema。已有 object 内嵌集合能力继续
  保留；不因容器合并而额外承诺任意直接 map(table/tree/map(...)) 组合。
- table 仍保留明确顺序语义，不在本次 dict 合并中顺带删除或改变其契约。

table/list 不在本轮合并，也不新增 array。保留 table 的外部键与 ids/byId 布局，
保留 list 的普通数组和 keyOf 身份规则；二者共享适用的键项与顺序算法即可。
无稳定键的 points 或其他简单数组可先用 `field<readonly Point[]>()` 整体替换。
支持无 key 的局部数组编辑是独立能力，不作为本次协议重构的隐含范围。

所有容器接收 value schema，不再直接接收 value validator。例如：

```ts
map(field(numberValidator));
list(field(pointValidator), { keyOf: point => point.id });
tree(field(nodeValueValidator));
```

以上 list 示例要求元素本身具有稳定 id；不是给无身份的手写 point 强行分配 key。
list/tree 的现有原子值能力使用 field 包装，删除其独立 validator 配置。map/table
已有结构值能力继续通过 object/variant 表达。统一值解释规则不等于同时扩展所有
容器允许的节点种类；list/tree 的结构值编辑及任意嵌套容器本轮不额外开放。
字段校验、copier、原子值相等和 Infer 由同一 value schema 实现。

variant 的判别字段在 Read/Draft 中均只读，运行时也拒绝直接赋值或删除：

```ts
draft.content.title = 'Updated'; // 当前分支声明的普通字段
draft.content = { kind: 'empty' }; // 原子切换分支
// draft.content.kind = 'empty'; // 禁止，不能产生不完整分支
```

分支替换先验证完整新值再写入，不隐式补字段，也不允许事务中暂存非法分支。

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

### 3.5 拒绝、异常与业务返回值

统一对外提供一种预期业务拒绝信号 `TransactionRejected`。构造参数为一条或多条
结构化 issue，包含 code、message 和可选 address；运行时复制并固定 issue 数据。
它替换内部既有业务拒绝异常与 tx.reject，不新增平行拒绝协议。
业务 issue 与引擎 MutationIssue 继续保持可区分来源，但不再有独立 report 收集器。

| 退出方式                 | update 行为                                               |
| ------------------------ | --------------------------------------------------------- |
| 抛出 TransactionRejected | 完整回滚，返回 rejected、issues 和当前 revision           |
| schema、键或结构校验失败 | 完整回滚，返回相同 rejected 结果形状，issues 保留引擎来源 |
| 普通 Error 或其他抛出值  | 完整回滚后原样向外抛出，不转换成业务拒绝                  |
| 正常返回                 | 根据净变化返回 committed 或 unchanged，保留回调返回值     |

拒绝不递增 revision、不生成 history、不通知观察者。异常只在事务入口捕获和分类，
执行器不把任意异常包装成 TransactionRejected。已提交后的 observerErrors 仍独立
返回，不能触发回滚或重新分类为 rejected。

删除 tx.report、tx.reject、DocumentTransaction 控制对象及结果中的 reports 字段。
不阻止提交的提示、警告和业务结果由回调返回值表达：

```ts
const result = document.update(draft => {
  const task = draft.tasks[taskId];
  if (!task)
    throw new TransactionRejected({ code: 'missing-task', message: 'Task does not exist.' });
  task.done = true;
  return { warnings: ['Some related tasks are still pending.'] };
});

if (result.status === 'committed' || result.status === 'unchanged') {
  consumeWarnings(result.value.warnings);
}
```

返回业务值不是取消事务。写入前即可判断的业务分支可以直接返回；若已发生修改且
需要放弃整笔事务，必须抛出 TransactionRejected 或其他异常。正常返回 false、
undefined 或带 error 字段的对象都不具有隐式回滚含义。

update 结果仅保留：committed 的 value/commit/observerErrors，unchanged 的
value/revision，以及 rejected 的 issues/revision。不再提供 prepared 结果或预执行
生命周期。普通异常经恢复后继续向外抛出，异步回调仍被拒绝。

### 3.6 根节点只定义一次

object 是唯一对象结构定义入口。删除公开 schema() 构造器，createDocument 直接接收
根 ObjectNode。schema 仍是数据定义的概念及配置参数名，不再是一层包装对象：

```ts
const model = object({ tasks: map(task), settings });
type DocumentValue = Infer<typeof model>;
const document = createDocument({ schema: model, initial });
const value = parse(model, input);
```

保留两种身份：

| 身份         | 来源                          | 负责范围                                           |
| ------------ | ----------------------------- | -------------------------------------------------- |
| 数据定义身份 | 根 model 节点引用             | schema 解析、selector 归属、静态访问计划与类型推导 |
| 文档实例身份 | createDocument 创建的 runtime | canonical 状态、revision、事务、订阅与 history     |

多个 document 可以共享同一个 model 及其解析计划；它们的状态、作用域和订阅仍然
隔离。内部已解析目标绑定 model，可在同一定义下复用解析信息，订阅仍绑定实际
document。分别创建的两个根节点即使结构相同，也属于不同定义，不得误用彼此的
已解析目标。公开路径回调在每个消费入口按该入口的 model 解析，不作为预绑定目标。
不进行 schema 深比较，也不增加 wrapper token 作为第三种身份。

schema 节点创建后不可变。内部以根节点引用作为缓存 key，缓存由解析和访问 owner
管理，不要求使用方手动创建编译包装。document.schema 直接指向 model。
运行时、schema path、parse、snapshot 和 draft 都解释同一个节点树。

删除 schema 构造器、DocumentSchema 包装类型、schemaRoot 及其合成缓存、仅为包装
存在的泛型和转发函数。不保留 definition.root/shape 兼容访问层；ObjectNode 自身的
shape 仍是结构定义的一部分。Infer 直接从节点推导，parse 直接接收节点。

### 3.7 Selector 入口与归属

删除 schema.value/collection 等依赖包装对象的方法，不将这些方法移植到 object()
节点上，也不公开 document.target() 或同义的 target 构造入口。常用体验固定为：

```ts
document.update(draft => {
  const task = draft.tasks[taskId];
  if (task) task.done = true;
});

const title = select(document, state => state.tasks[taskId]?.title);
const tasks = select(document, state => snapshot(state.tasks));

const stopAll = document.subscribe(commit => {
  consumeCommit(commit);
});

const stopTitle = document.subscribe(
  path => path.tasks.item(taskId).title,
  commit => consumeCommit(commit)
);

const source = projection.document(document);
const taskSource = source.collection(path => path.tasks);
const titles = projection.map(taskSource, (id, task) => ({ id, title: task.title }));
```

subscribe 的单参数形式订阅完整 commit，双参数形式按路径过滤。多个路径使用
`subscribe([pickA, pickB], listener)`，不增加 target.union 等公开组合对象。
路径只在注册或 source 创建时解析一次；每次通知不重新执行路径回调。

所有消费入口共用一个 schema 路径解析器。解析结果绑定根 model，只持有位置描述，
不捕获 canonical 值；订阅条目和 source 另行持有实际 document。目标的归属、地址
相等和匹配继续由 schema/address/impact-target 管理，不能在各入口复制解析逻辑。
目标类、构造器及仅为内部传递所需的类型不再通过根入口公开。

必须区分两类回调：

| 回调                                | 执行含义                                   | 生命周期                |
| ----------------------------------- | ------------------------------------------ | ----------------------- |
| `state => state.tasks[id]?.title`   | 读取真实数据，可计算、分支和返回默认值     | select 或派生读取作用域 |
| `path => path.tasks.item(id).title` | 描述 schema 位置，即使该实体尚不存在也有效 | 消费入口注册时解析      |

路径中的 item 不是残留 reader/writer，它用于表达键寻址。路径回调不执行任意数据
计算；字段不存在不能导致路径解析提前终止。select/React 的数据读取使用真实值和
既有读取依赖机制，不能把 subscribe 的路径过滤暗中改为“重新计算任意 selector 并
比较结果”。projection processor 依赖仍然显式声明，不随入口简化改成自动追踪。

公开 impact 查询若需要指定位置，同样接受路径选择器，由 commit 绑定的 model 解析；
内部高频匹配直接复用已解析目标。集合查询保留精确键类型，不强制调用方先创建 target。
不在本轮增加目标序列化、跨文档目标注册器或 document 创建前的 selector 构造 API。
未来只有明确的复用或集成需求才能增加不可变目标边界，不能恢复一个必经包装步骤。

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
- map 的原子条目和结构条目共用键项存在性记录：前者记录整个值的变化，后者允许
  记录子字段变化。创建、删除及父级吸收不再各写一套 dictionary/entity 算法。
- presence 与 value 分开表达；缺失和存在但值为 undefined 不等价。
- 创建实体时记 absent，之后的内部字段修改由创建记录覆盖。
- 删除实体前保存事务起始实体值，吸收此前已改字段的 before。
- 删除后重建同 id，最终按起始与最终实体值比较，不能仅因执行过删除就通知全部字段。
- variant 或其他真实子树替换吸收旧子记录。最终 seal 时如仍属同一结构，可在该已触及
  子树中生成精确差异；不得扩大到其他实体或整个文档。
- 回滚使用首次状态，不再执行用户校验器，也不运行用户 updater 或重放业务回调。
- recorder 可以保存首次触及顺序及必要的局部结构恢复步骤，由对应执行器解释；
  不保留逐次字段赋值日志，也不从公开 ChangeSet 反推回滚过程。

### 4.2 顺序与树结构

简单字段首次状态不足以恢复所有结构。表、列表顺序和树拓扑必须有明确的结构记录。

先采用可解释的策略：第一次改变某个顺序序列时保存该序列，后续修改不再重复保存；
seal 比较 before/after。树记录被触及节点的存在性、原子值、parent 和受影响的 child
顺序；不复制未触及的兄弟子树。子树删除的成本允许与被删除子树规模成正比。

一个长度为 N 的数组序列重排可能需要 O(N) 工作和一次 O(N) 快照，这个成本必须在
基准和文档中明示；不能把字段单点更新也拖入此路径。只有基准证明真实结构工作负载
需要时，再在 anchor/tree owner 内改进存储，不预先叠加链表、位置 token 和多级缓存。

回滚由各 owner 明确所需恢复顺序：例如先恢复必要容器，再恢复字段，或逆序执行
首次记录的局部恢复步骤。允许有限的结构恢复信息，但旧状态事实只能保存一份。
不为了“完全无序回滚”引入通用依赖排序器。树的 reciprocal links、单根、连通、
无环由 tree owner 保证；不通过在临时无效树上反复完整校验来完成恢复。

## 5. ChangeSet 与提交协议

### 5.1 一份双向状态转换

commit 的核心为不可变、可逆的 `ChangeSet`。基本事实是某个 schema 位置的
`before -> after`，不是用户执行过哪些方法。

目标公开结构示意：

```ts
type DocumentCommit<S> = {
  readonly revision: number;
  readonly source: CommitSource;
  readonly changes: ChangeSet;
  readonly impact: DocumentImpact<S>;
};
```

ChangeSet 区分以下实际语义，不用通用 JSON Patch 路径模拟全部结构：

| 变化事实   | 最小必要内容                                                                    |
| ---------- | ------------------------------------------------------------------------------- |
| 原子值     | schema 地址、before presence/value、after presence/value                        |
| 键项存在性 | 容器地址、稳定键、before/after 项；原子条目整体比较，结构条目优先输出子字段差异 |
| 顺序       | 集合地址、必要的 before/after 顺序数据                                          |
| 树拓扑     | 树地址、被触及节点身份及 before/after 拓扑事实                                  |
| 根替换     | 显式 reset 转换；允许全量成本                                                   |

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

### 5.3 应用与替换

- `apply(changes, { expectedRevision })` 接收 unknown，在一个边界完成 decode、格式归一、schema 和结构校验，
  通过相同 mutation session 原子应用；拒绝旧 DocumentOperation 数组。
- 输入中的 before 不是可信的本地 undo 数据。应用端记录自己的真实首次状态并生成
  本地 commit，不能直接把来包 before 填进 history。
- 公开 apply 必须提供匹配当前 runtime 的 expectedRevision，缺失或过期均拒绝。
  不对来包 before 做对象引用或深相等前置校验。本地同步另由连续 durable seq 和
  独占 Web Lock 控制基线；未来协同的服务端版本、前置条件属于 adapter。
- ChangeSet 采用唯一规范化形式与明确应用顺序，输入在边界规范化后交给领域 owner。
  不承诺任意条目排列都能直接执行；重叠、重复和矛盾条目拒绝，不用排列决定覆盖优先级。
  树拓扑仍按结构单元原子校验和安装，不对外暴露临时非法状态。
- `replace` 保留显式 reset 能力，使用同一提交结果和 ownership 边界。全量替换成本
  与 history 是否清空应保持明确规则，不伪装成普通增量字段写入。

规范化只要求无净零项、无重复事实、无已被父级覆盖的子项，输出确定、可逆、可重放。
不寻找全局最少条目集合，不引入最小 diff 求解器或为所有节点构建通用执行计划。
规范顺序由既有容器和拓扑语义决定，不能形成第二套地址或 mutation 协议。

### 5.4 删除 Prepare

当前 prepare 只有实现、测试和未来设计引用，没有生产调用方，local-sync 不依赖它。
删除 runtime.prepare、PreparedUpdateResult、导出、driver 权限分支及专属测试；
不移动到 integration，不保留隐藏入口、prepared token 或未使用的基线锁机制。

将 prepare 测试中有价值的混合修改恢复断言转成失败事务、history 和外部 apply 测试。
重写 COLLABORATION_DESIGN 中依赖 prepare 的未来步骤，标记严格“先持久化后可见”
协议为尚未设计的独立需求；不承诺可通过 update 后回滚已通知 commit 来模拟它。

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

本地 replace 作为一个可撤销的根 value fact 记录；remote commit 使本地 history 失效。
根 reset 仍采用全量复制与发布成本。未来协作撤销由 adapter 处理，
不能直接回填 before 覆盖他人的后续修改。

### 6.3 Local Sync

完整替换 `local-sync/timeline.ts`、`session.ts`、JSON codec 和相关契约：

- leader 持久化 sealed ChangeSet，follower 按连续 durable seq 应用，单写者由 Web Lock 保证。
- 保留当前单写者、先内存可见后异步落盘、flush 和错误状态语义。
- codec 校验值、大小、schema/协议版本；拒绝不支持的 opaque 值。
- 新持久化协议使用 IndexedDB version 3、record formatVersion 1，旧格式明确报错，
  中止 upgrade 并保留原数据，不自动清库、覆盖或转换。
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

schema 与键项协议同步合并：删除 DictNode、dict 构造器、DictionaryReader/Writer、
dict 专属校验配置、dictionary impact/footprint 分支和旧 dict operation 编解码。
扩展 MapNode 的值节点约束及 Infer/Read/Draft 推导，让字段、结构值共享键项执行和
记录。table 可以复用键项存在性算法，但顺序仍由 anchor owner 管理；不得以删除
dict 名称为名，在内部继续维护按“原子字典/对象实体”分开的重复协议。

| 目标构造            | 表示角色、生命周期                    | owner / 消费者                                   | 替换或删除                                                 |
| ------------------- | ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 统一 schema access  | scoped resolved view                  | access；select、draft、React、projection         | 两套 reader/writer 工厂、字段 get/set/update、双缓存       |
| Draft/Read 类型     | 权限边界                              | schema/access 公共入口                           | DocumentReader/Writer 及节点级旧公开类型                   |
| TransactionRejected | 业务拒绝边界值；单次失败              | runtime；update、调用方                          | tx.reject、旧业务拒绝异常；删除 report 收集与 reports 输出 |
| ChangeRecorder      | session；仅一次事务                   | mutation；字段及结构执行器                       | journal inverse 解析、每操作 forward/inverse 日志          |
| ChangeSet           | sealed boundary value                 | mutation；commit、history、同步                  | DocumentOperation、独立 inverse、operation footprint       |
| ChangeSet 边界模块  | decode/validate/seal                  | mutation；外部 apply、codec                      | operation.ts 的旧 envelope 协议                            |
| ChangeSet impact    | 派生查询；一次 commit                 | impact/impact-target                             | operations 派生路径、独立 footprint 地址规则               |
| 根 ObjectNode       | 数据定义；节点生命周期                | schema；runtime、解析、访问、类型推导            | schema()、DocumentSchema 包装、schemaRoot 与转发泛型       |
| 消费入口内联路径    | 注册时解析的内部目标；无 canonical 值 | schema/address/impact-target；订阅、impact、投影 | schema.value/collection、公开 target 构造与组合 API        |
| 容器 value schema   | 值定义                                | schema-value；各容器、parse、snapshot、draft     | list/tree 专属 value validator 配置                        |

prepare 属于直接删除项，没有替代构造。table/list 不合并，apply/replace 也不在本轮
移动到其他导出入口。impact、history、projection 保留各自职责，不强行合成一个对象。

最终边界模块是 `mutation/changes.ts`，事务事实源是 `mutation/recorder.ts`。
旧 operation、journal、execute-*、footprint 和无消费者的 mutation contract 均删除，
不保留 re-export。`mutation/tree.ts`、`anchor.ts` 继续拥有结构算法。
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

- [x] 定义 Draft/Read、节点操作表、作用域和原子字段所有权语义。
- [x] 固定统一 map 的 value schema、键存在性、领域键类型与集合 impact 规则，删除 dict 目标 API。
- [x] 固定根 ObjectNode 与 runtime 身份、内联路径消费入口及内部目标归属、容器 value schema 和 variant 判别字段只读规则。
- [x] 固定单参数回调、TransactionRejected、普通异常回抛和业务 value 结果规则。
- [x] 定义最小 ChangeSet 联合、presence、顺序、拓扑和 reset 规则。
- [x] 固定实际 apply 基线规则及 history group 行为，移除 prepare 的目标契约。
- [x] 为当前基线保留可重复运行脚本和结构操作基准。

### 阶段 B：先替换事务事实源

- [x] 执行器在写入前直接记录首次旧状态，失败恢复不重新运行用户代码。
- [x] 字段、map 键项、table、variant、list、tree 全部改用同一 recorder。
- [x] 合并原 dictionary/entity 的键项执行与记录，保留 value schema 和有序结构的必要区别。
- [x] 实现父子吸收、结构恢复和 seal 净变化。
- [x] 保留必要的首次恢复顺序和局部结构步骤，不引入通用依赖排序器或最小 diff 算法。
- [x] 删除 forward/inverse 执行日志、journal inverse 解析和重复索引。

### 阶段 C：切换提交与全部消费者

- [x] commit、apply、replace 切换规范化 ChangeSet，定义领域安装顺序。
- [x] 删除 prepare 实现、类型、导出、权限分支和专属测试，保留失败回滚覆盖。
- [x] impact、history、footprint 消费统一变化事实，删除旧操作协议。
- [x] local-sync codec、timeline、follower replay 切换新格式并验证恢复。
- [x] 更新同步设计文档和 AGENTS 所有权要求，删除旧格式兼容假设。

### 阶段 D：统一 Draft 与读取

- [x] 实现同一 schema access 的只读和事务权限模式。
- [x] createDocument、Infer、parse、snapshot、draft 直接使用根节点，删除 schema()、DocumentSchema 包装、schemaRoot 及转发泛型。
- [x] schema.value/collection 切换为 subscribe、impact 和 collection source 内联路径入口，共用解析器，不公开 document.target。
- [x] 单路径/多路径订阅在注册时完成解析，删除公开 target 构造、组合及仅内部需要的类型导出。
- [x] 接通赋值、删除、成员访问、variant、集合领域操作和 snapshot。
- [x] 切换 select、projection、React 及仓库内所有示例。
- [x] list/tree 值校验配置改为 field(valueValidator)，复用 value schema 的快照与推导。
- [x] 拒绝 variant 判别字段直接赋值或删除，分支切换仅接受完整替换。
- [x] 所有 dict 声明直接替换成 map(field(...))，校验器移入 value schema，删除旧节点与导出。
- [x] 删除 tx 控制对象、report/reject 方法、reports 结果及旧诊断收集代码，统一拒绝异常。
- [x] 删除 reader/writer 公共类型、旧工厂、get/set/update 协议和适配包装。

### 阶段 E：验证、清理与性能收敛

- [x] 随机模型测试覆盖事务提交、回滚和 ChangeSet 双向重放。
- [x] 建立 draft 与旧基线相同数据/操作规模的测量，报告均值、P95、GC 和分配。
- [x] 搜索并删除旧 API、旧 operation envelope、旧 inverse 消费者及重复地址规则。
- [x] 更新文档、技能、包导出，运行 check/build/bench/profile 和 ESM/CJS smoke。

## 10. 验收标准

### 语义

- 原子字段内部修改在类型层面被拒绝，整体替换可校验、回滚和撤销。
- absent/undefined、NaN、-0、对象引用相等、optional 删除均有明确测试。
- map(field)、map(object)、map(variant) 的新增、替换、删除、缺失查询和重放遵循
  同一键项协议；原子条目内部写入及错误领域键索引在类型层面被拒绝。
- 原 dict 对应的 map(field) 支持 collection projection 和 added/removed/updated impact，
  snapshot、校验、history、local-sync 均不依赖已删除的 dictionary 特殊分支。
- 字段重复写、新建后编辑/删除、删除重建、variant 往返不会产生虚假净变化。
- 保留的子 draft 在结构变化后不会访问失效 canonical 对象。
- 事务内即时读取、嵌套写入限制、异步 callback 拒绝、scope 失效行为正确。
- 任意晚期拒绝恢复完整起始状态，不产生 revision、history 或通知。
- TransactionRejected 返回结构化 rejected，普通 Error 和非 Error 抛出值在回滚后
  原样抛出；update 覆盖晚期失败，观察者错误不进入拒绝分支。
- 回调正常返回的业务值不触发隐式回滚，警告通过 value 返回；公开类型和结果中
  不存在 tx 参数、report/reject 方法或 reports 字段。
- 对合法状态 A 和 B，seal(A -> B) 向前重放得到 B，向后重放得到 A。
- history group、tree 父子恢复、list/table 顺序和 root reset 都通过模型测试。
- variant tag 在类型及运行时禁止直接修改，完整分支替换失败不留下临时非法值。
- document.schema 直接持有 model，Infer/parse/snapshot 使用同一节点；共享 model 的
  document 可复用内部解析信息，但状态和订阅隔离。不同根节点不能误用已解析目标。
- schema()、DocumentSchema 包装、schemaRoot 及兼容别名均已删除；不公开 document.target，
  ObjectNode 没有新增 selector 工具方法，消费入口不要求用户先创建目标对象。
- 单路径/多路径订阅覆盖不存在实体、创建删除、无关字段及重复目标；每个注册路径
  只解析一次，不在通知时调用路径回调，同一 listener 每个 commit 至多触发一次。
- 数据读取与路径描述在类型和运行时可区分，collection source 与 impact 保留领域键类型，
  React/projection 继续使用统一只读访问，processor 显式依赖不变。
- table/list 的布局与身份语义保持明确，list/tree 原子值的校验和 copier 来自 field，
  无独立 value-validator 实现或新增的无 key 数组协议。
- 伪造 ChangeSet、冲突条目、非法树、非法键、错误基线整批拒绝。
- ChangeSet 规范化输出确定且遵守领域安装顺序，不要求全局最小 patch；结构恢复
  使用唯一旧状态事实源，不借规范化引入通用依赖排序或第二个执行器。

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
- prepare、PreparedUpdateResult 及隐藏替代入口均已删除；未来设计不再假设该能力存在。

完成的判据是上述统一模型和全部消费者一致，而不是仅让 draft 示例运行或只优化字段
快路径。结构语义的必要复杂度保留在对应 owner，重复表示与协议转换必须删除。

## 11. 实施结果与验收记录

### 11.1 工程验证

- `pnpm run check` 通过：format、lint、typecheck 和 12 个测试文件中的 145 项测试。
- 固定种子模型覆盖 1,000 组 table 操作序列，以及 200 组 list/tree/root reset/history
  分组序列；独立状态模型验证提交、晚期拒绝恢复、重放和双向 history。
- 大集合回归覆盖 100 万次同字段写入只保留一个事实、10 万实体稀疏修改、
  13 万项 table 批量插入/删除、15 万项 list 顺序撤销/重做和 1 万层树删除恢复。
- 外部边界覆盖格式错误、重复/重叠事实、稀疏地址/顺序数组、list 键不匹配、
  过期基线、非法拓扑和部分执行后的完整回滚。
- `pnpm run build`、`pnpm run bench --run`、`pnpm run profile` 通过。
- 构建后的 root/integration/local-sync/react 均通过 ESM/CJS 加载与运行 smoke；
  两种模块格式的发布声明通过独立 NodeNext TypeScript 编译验证。
- 旧 API 活跃引用已清理；保留在本设计中的旧名称仅用于说明删除项。
  不包含 whiteboard 等外部使用方修改。

### 11.2 性能实测

Node v24.11.1/macOS；最终 `test.mjs` 每种场景三轮，每轮预热 20 帧、测量 60 帧，
每项修改 position.x/y 两字段，保留提交结果、通知次数和最终值断言。
记录全部 180 个测量样本，不筛选最好一轮；本轮加入 GC 事件观测和每轮堆净变化记录。

|  总实体 | 每帧修改 | 额外字段订阅 | 平均 ms/帧 | P95 ms |
| ------: | -------: | -----------: | ---------: | -----: |
|   1,000 |    1,000 |            0 |       2.67 |   7.74 |
|  10,000 |   10,000 |            0 |      29.87 |  46.22 |
|  10,000 |      100 |            0 |       0.24 |   0.21 |
| 100,000 |    1,000 |            0 |       2.59 |   6.25 |
|  10,000 |      100 |        1,000 |       0.22 |   0.26 |

10,000 全量场景三轮均值为 28.97、31.11、29.53ms。该场景 180 帧共观察到
152 次 GC 事件，事件 duration 总计约 1,196ms；不同 GC 阶段的事件时长不能简单
等同于额外墙钟暂停时间。三轮 heapUsed 净变化约 +17.8MB、-38.5MB、-120.4MB，
这是 GC 时机影响下的堆净变化，不能当作分配量或泄漏量。少量长帧可使平均值高于 P95。

对照重构前 read+set 的 29.57ms，最终平均值接近，但 P95 更高；对照旧 field.update
的 21.22ms，平均值仍慢约 41%。因此本次完成协议统一与复杂度收敛，**不声称全量
帧性能全面提升，也不满足 16.7ms 的帧预算**。稀疏场景仍按实际触及实体工作。

已经删除无消费者的逐路径 hash/collection 链，合并 scope 代理与解析缓存，保留共享
Proxy handler、就近父解析与首次旧值记录。未引入跨事务池或恢复旧 writer 快路径。

profile 的文档加映射投影场景显示：10 万实体只修改 1,000 项时，记录 2,000 个
首次字段事实、发布 2,000 条变化、映射 1,000 项；不扫描 collection ids，
不复制无关容器、不建顺序快照。该帧两个访问 scope 合计创建 4,003 个结构代理。
这些分配计数与全量场景的 40,003 个代理说明，后续性能工作主要仍在作用域对象、
地址分配和净变化发布成本，不能仅靠减少事实数量解决。

其他基准：1 万次同字段赋值约 1.68ms；10 万项投影只修改一项、不读取 all 约
0.011ms；主动读取全量 all 约 0.85ms。基准数据规模和操作不同，不能与上述帧耗时
直接相减或混用。
