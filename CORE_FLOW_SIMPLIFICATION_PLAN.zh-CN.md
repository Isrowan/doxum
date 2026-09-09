# 核心调用链收敛实施清单

审查基线：`ea8fb80`，2026-09-09。本文记录实施清单与验证结果；代码阶段已完成，性能结果及限制见第 8 节。

## 1. 目标与范围

目标：让一个操作沿着“取得当前操作对象 → 校验修改意图 → 捕获首次修改前状态 → 写入 → 发布净变化”完成。已解析事实由一个对象携带，业务输入显式传入，调用者不负责拼装下层实现细节。

优先级依次为正确性、稳定的性能与 GC、职责清晰、代码体积。减少参数和函数数量是手段，不能以增加每次写入的包装对象、重复解析或扩大失效范围为代价。

本次审查覆盖：`address`、`access/scope`、mutation 全链、runtime 发布与通知，以及直接消费它们的 projection、integration、React 入口。local-sync 核对 ChangeSet 和写入权限边界，不据此宣称已审计其全部持久化实现。

最终调用关系：

```text
update / apply / history / replace
  → runtime.mutate：授权、同步事务、异常回滚
  → scope 的当前目标 / replay 的地址解析
  → 领域操作：成员、列表、表、顺序、树
  → session 写入内核 + recorder 首次状态捕获
  → recorder 输出完整容器组
  → ChangeSet 发布登记
  → commit / history / processors / listeners
```

这里的领域操作仍在当前 session 内写入，不建立第二个状态存储。纯读取、树验证、顺序计算继续由各自领域模块负责。

## 2. 表示与所有权

| 当前表示                     | 性质与所有者                          | 当前问题                                                       | 最终处理                                                      |
| ---------------------------- | ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `CanonicalState`             | canonical；runtime 持有，session 写入 | access 通过额外 schema/root 参数重新描述同一来源               | access 引用同一个 state，避免每个 scope 的 root 转发闭包      |
| `Target`                     | scope 内的派生缓存                    | 同一目标另有 snapshot 解析路径；集合写入又拆装上下文           | 保留代理身份、惰性地址、generation 和子节点缓存；统一目标刷新 |
| `ResolvedContainer`          | session 当前代的解析事实              | 混入树节点存储，且消费者重复传 at/node/value                   | 明确普通成员容器与树容器，操作消费对应类型                    |
| `CompiledMember`             | schema 编译结果                       | 定义和物理位置由多个调用点手工组合                             | 定义解析集中在写入内核；已解析的定义直接复用                  |
| `MemberFact` / `MemberGroup` | recorder 的事务前状态                 | group 持有带 generation 的即时句柄；顺序另外保存、发布后再合并 | group 保存恢复所需的稳定事实，有序组同时拥有 order baseline   |
| `TreeFact`                   | recorder 的树前状态                   | 捕获依赖数组和多层回调传递                                     | 树操作直接请求首次节点捕获，不生成 per-write 日志             |
| `ChangeSet`                  | readonly publication / 外部输入边界   | 内部发布仍输出待合并的容器片段                                 | recorder 输出完整组；decode 继续独立校验未知输入              |
| projection source binding    | 派生来源绑定                          | targets、record、receiver 分散在数组和 Map 中                  | 每个 binding 自己持有接收行为及其来源事实                     |
| projection item              | 派生成员可读句柄                      | handle、revision、listeners 按同一 key 分成三个 Map            | 按成员归属合并记录；活跃订阅索引仍允许独立存在                |

不要把 `Target` 与 `ResolvedContainer` 强行合一：前者拥有代理与访问缓存，后者是当前 session 的写入定位事实，生命周期和消费者不同。也不要为了保留旧签名增加兼容转发层。

## 3. 按领域实施

### A. Address：先纠正操作对象的模型

#### A1. 分离树容器与普通成员容器 [P0]

证据：`core/src/address.ts` 的 `resolveContainer` 把 `tree.nodes` 作为 `parent`，却把 payload 的 `node.value` 当作每个节点的成员 schema。`operations/replay.ts` 的 members 分支因此能够绕过树拓扑规则。

已用源码入口运行最小复现：空树接收下面的输入，结果为 `committed`、revision 变为 1，随后 `snapshot()` 抛出 `TypeError: n.children is not iterable`。

```ts
{
  changes: [{
    kind: 'members',
    at: ['outline'],
    members: [{ kind: 'added', key: 'r', after: 7 }],
  }],
}
```

最终设计：

- [x] `address.ts` 的容器解析结果明确区分成员容器和树容器。成员容器保留 storage/layout；树容器只携带真实 tree schema、tree value、地址和 session 定位信息。
- [x] 普通 member kernel、`memberKey` 和 recorder.member 只能接收成员容器。禁止给树构造伪造的动态成员 layout。
- [x] replay 根据 ChangeSet kind 取得对应容器；members 指向树、tree 指向非树时，在写入前通过 `MutationIssue` 拒绝。
- [x] 树 payload 校验与节点拓扑校验分开表达，不能用 payload schema 校验整个 `{parentId, children, value}` 节点。

删除项：树在普通 `MemberLayout` 中的分支及相应强制断言。新增的树解析类型属于真实领域差异，复用已有解析入口，不新增地址模型。

验收：覆盖上面的复现、非空树、已有成员先写入后出现错误组的整批回滚、revision/history/通知不变，以及合法 tree replay 和逆向历史。

#### A2. 确定解析与刷新责任 [P1]

证据：scope.resolve、writableContainer、session.refresh 同时参与新鲜度维护；assign/remove 会 refresh，list/table/order 的 located 路径直接消费 container，tree 又在 editTree 中 refresh。

- [x] 将协议写清：scope 在命令入口刷新 Target 并绑定本代 container；replay 在每组入口解析 container。领域命令消费已经取得的当前对象，不在内部再次从根解析。
- [x] session 的普通成员入口保留一个统一的当前句柄检查点；已定位内核不再次刷新。禁止调用方在一次命令内部交错执行任意用户操作后继续使用旧句柄。
- [x] 批量命令允许持有同一成员存储完成整组操作；每次字段写入不能因为 generation 改变而重新走完整路径。区分“跨命令重新使用句柄”与“同一命令局部持有引用”。
- [x] 合法的同 callback 保留代理、同 schema 整体替换、variant 换分支、删除后重建继续正确。保留这些缓存失效规则，不能用 reader 不逃逸约定删除它们。

验收：现有 repeated-field、same-schema replacement、variant retained-method 和批量集合性能用例；增加跨命令旧句柄与同命令批量路径的针对性验证。

### B. Mutation：容器事实与修改意图分开

#### B1. 删除重复参数，收窄成员内核暴露面 [P1]

证据：`operations/{table,list,order,tree}.ts` 都同时接收 `container` 和 `at`；`recorder.order(at,node,value)` 又拆开容器事实。`writeLocatedMember` 调用点多次拼 `session.definition(container,key)`。

- [x] 集合命令删除独立 `at`，从 container 取得地址、schema 和当前值。
- [x] recorder 的 order/tree 捕获入口消费对应容器及真正的操作输入，不让调用者分别传入地址与值。
- [x] 普通成员写入将 definition/key 定位收进 session 的现有成员入口。assign 的替换规则校验与实际写入复用同一次 definition 结果。
- [x] list 已经为存在性检查得到的 index 直接传到低层内核；不要为了签名整齐再次查 key，也不为每次写入创建 `ResolvedMember` 对象。
- [x] 高层默认调用成员入口；确实已经定位的 list/bulk 路径才调用低层内核。内部保留有意义的长参数列表，不把它们扩散到其他领域。

最终命令形态：

```ts
list.set(session, container, id, value);
table.remove(session, container, ids);
order.move(session, container, id, position);
tree.move(session, container, id, position);
recorder.order(container);
```

保留：成员 `id/key`、批量 `ids`、新值、anchor；保留列表逻辑 key 与物理 index 的区别；保留不存在与存在但值为 undefined 的区别。`container.owner` 是身份 token，不能改为 session 引用来隐藏显式 session 参数。

验收：全仓搜索不再出现容器命令的独立 at；字段热路径不增加对象、schema lookup 或列表 index lookup。删参数本身不宣称有可测加速。

#### B2. 树命令去除高阶回调链 [P1]

证据：目前 `operations/tree → session.editTree → run callback → tree.set/insert/... → capture callback → recorder.tree`。这些写算法只有 operations 层调用；`editTree` 在无变化和单纯 payload set 后也总是 invalidate。

- [x] 将树修改协调及写算法收敛到 `mutation/operations/tree.ts`。`mutation/tree.ts` 继续拥有树类型、验证、只读查询和遍历算法；如果提取遍历，必须是实际领域算法。
- [x] 树命令直接消费 A1 的树容器，校验意图后调用 recorder，再写 canonical tree。
- [x] 删除 `MutationSession.editTree`、仅转发的树操作薄层、`run/capture` 闭包协议。replay 的树分支直接使用同一捕获与安装规则。
- [x] recorder 提供逐节点首次捕获入口并在首个节点捕获时记录 root baseline，替代仅为传参创建的 `[id]`、`[id,parentId]` 和 replay 的 `nodes.map(...)`。
- [x] 删除节点本来就需要的子树遍历数组保留；不引入可变全局 scratch 数组或对象池。
- [x] 树 set 同值直接结束；原子 payload 替换不使结构目标重新解析。真实结构修改继续由命令维护失效，先不扩大到通用的细粒度 generation 系统。

验收：root/孤儿/环/父子互反、移除深树、重复父节点捕获去重、局部失败回滚、历史 inverse；连续树 payload 更新不随写次数刷新 scope。单节点修改只捕获涉及的节点。

#### B3. 顺序捕获去重，写入副作用就近表达 [P1]

证据：list.remove、table create/remove 和 replay 先捕获 order，成员 kernel 在 membershipChanged 时再次捕获；recorder 虽然幂等，仍有重复调用和索引查询。

- [x] 普通成员 kernel 负责成员增删导致的首次 order baseline，覆盖 replay 与底层成员路径。
- [x] 纯 move、直接 list insert、以及显式 replay order 保留自己的顺序捕获，因为它们可能不经过成员增删路径。
- [x] 删除既走成员 kernel 又无其他必要性的前置 recorder.order 调用。
- [x] 保留“捕获在第一次真实修改之前”；不能为了集中调用把 order baseline 延迟到成员已变化之后。
- [x] 失效仍跟随拥有实际结构写入的操作，不引入 `beginWrite/endWrite` 或由调用者维护的 dirty flag 矩阵。暂不做通用批量延迟失效协议。

验收：create/remove/move 混合、纯 order、order roundtrip、replay 中途失败；每个容器只产生一个初始顺序快照。计数器同时检查尝试捕获次数，不能只看快照数量。

### C. Access：一个目标，一条解析链

#### C1. 去掉临时写入包装，复用已有上下文 [P1]

证据：`writableCollection` 每次返回 `{session,container}`，随后所有调用点立即拆开；`AccessContext` 又通过 schema/root 重新表达 runtime 已有 state。

- [x] `AccessContext` 引用现有 canonical state；读取通过 state.document 获取最新根值。update、readWith、projection source 同步修改，删除逐 scope 的 `root: () => state.document` 转发闭包。
- [x] 在 scope 内沿用已有 session 引用；集合写准备只返回 container，删除临时 `{session,container}` 结果对象。
- [x] 保留 readonly 写保护及 projection reader 的 active 检查；不要给每个 Target 添加 session、recorder 或完整 context。
- [x] list/tree replace 直接使用目标地址或已解析的父成员执行替换，不先绑定一个随即丢弃的“自身成员容器”。根替换保持独立语义；非根替换仍经 owning parent 捕获。
- [x] 方法分发按 table/list/tree/ordered 职责留在 scope，采用普通分支；不新建每个代理的 method table 或每次 get 的工具对象。

验收：只读写入拒绝、更新后读到当前值、projection dispose/过期 reader、replace 回滚。关注每次集合命令的临时分配，不仅统计代理数量。

#### C2. snapshot 与 collectionAccess 共享目标解析 [P1]

证据：snapshot 已经由 WeakMap 找到 Target，却另外调用 `resolveValue`，失败时再调用 nodeAt；collectionAccess 创建 access 后再 nodeAt 判断 table/map。

- [x] 将 Target 刷新实现整理为 scope 内可复用的同一函数，proxy 和 snapshot 都消费刷新后的 node/value。必要时把闭包内实现提升到同模块，显式接收现有 context，不新增每代理闭包。
- [x] collectionAccess 在创建时复用已经解析的节点种类；避免紧接着再从根解析 schema。
- [x] 地址继续惰性生成。无 dependency 的普通读不能为了统一传参而提前生成全部路径数组。
- [x] 缺失父节点与 schema 地址无效仍须区分；保留必要的 schema-only 解析分支，不能简单删除所有 nodeAt fallback。
- [x] 不缓存结构 snapshot 的返回值。每次 snapshot 的可编辑结构隔离与原子 payload 共享继续遵守所有权协议。

验收：同 callback 内删除/恢复父对象后对保留子代理 snapshot；variant 切换；deep snapshot 的定位工作不重复，结构复制范围不变。

#### C3. 检查、依赖记录、无消费者 API 各归其位 [P2]

- [x] `collect` 只负责依赖记录；active 检查集中在每个可被独立调用的访问入口。不能仅在 Proxy.get 时检查，返回的方法可能随后才执行。
- [x] assign 的写权限检查与 setter 的检查收敛到同一个写入入口。只有确实复用现有 setter 实现时才绕开 Reflect.set，不能新增一份 assignment 逻辑或给每个代理分配写 closure。
- [x] 删除当前无消费者的 `MutationSession.resolveValue` 及仅供它调用的 resolver.read、runtime/access 的 schemaOf/documentOf、ResolvedAddress.parentNode。
- [x] `DependencyTracker` 只保留当前消费者需要的 record/snapshot；删除 clear/size/some。保留目标去重语义，不借此引入新的依赖树模型。
- [x] 清理 tree.ts 的 `hasOwnProperty.call` 转发，使用标准 `Object.hasOwn`。独立领域查询如 tree.parent、tree.children 不因短小而删除。

验收：删除前复核生产代码、测试、bench、integration exports 的引用；更新后全仓搜索无旧 API。当前 public projection 生命周期检查必须继续通过。

### D. Recorder：从首次状态直接发布完整容器组

#### D1. 成员与顺序由同一个 recorder group 拥有 [P1，高风险]

证据：`MemberGroup` 和 `OrderFact` 分开捕获、索引、seal；sealOrder 输出 `members: []` 片段，`mutation/changes.ts` 的 mergeContainers 再恢复成完整组。diffMember 对 table 同样先发 members、再发 order。

- [x] 有序容器的 group 同时拥有成员首次状态和可选 order baseline。order-only group 不强制创建无用成员 Map；固定字段组保持 slot 存储。
- [x] group 保留必要的地址、schema 和 canonical storage 引用，不保留带 owner/generation 的即时解析句柄。captured state 的生命周期由 recorder 管理，不能误用 session.refresh 刷新历史前状态。
- [x] 首次捕获、覆盖吸收、组删除、回滚、seal 按同一 group 生命周期处理。祖先替换必须吸收被覆盖的成员和顺序；不能遗留 order-only 组。
- [x] seal 一次输出完整 members + optional order。递归 diff 对 table 在本地完成 members/order 后一次发布。
- [x] 删除独立 OrderFact、sealOrder 片段发布路径、mergeContainers 及内部“先拆开再合并”的协议。
- [x] 保留恢复时“先恢复成员、再恢复顺序”的必要阶段；这是数组安装的依赖关系，不等于恢复公共 apply 的全局顺序遍历。
- [x] sealChanges 只承担排序和有效 publication 身份登记；未知输入仍由 decodeChanges 检查、规范化和拒绝重复组。

验收：完整 recorder-model 与 mutation-scaling 测试；祖先/后代覆盖、删除重建、order-only、值变化抵消、多个容器回滚、root reset、实际 local before、history inverse；稀疏修改不扫描无关容器或成员。

#### D2. 保留真正的 diff 算法，避免参数包装反优化 [P2]

证据：transition/diffMember 的 before/after、present、schema、地址参数较多，但递归子成员并没有现成的 MemberFact；机械封装会为每个比较节点分配对象。

- [x] sealMembers 已有 MemberFact 时直接从 fact 读取前状态，避免在多个协调层重复解包转发。
- [x] diffMember 保持纯算法，不依赖 session/recorder。参数按输出、schema/位置、before、after 顺序一致排列，变量名称统一为 beforePresent/afterPresent 等有明确含义的名称。
- [x] 不创建每节点 BeforeAfter/ValueState 包装，不用 tuple 和数字下标隐藏含义。必要的标量参数只留在该私有算法内部。
- [x] 将仅拆包再调用一次的私有协调函数就近合并；保留实际递归、排序、恢复算法。

验收：比较输出完全相同，递归替换不新增按节点数量增长的临时包装对象。

### E. Projection：把同一主体的状态收回所属领域

#### E1. Source binding 自己拥有接收行为 [P2]

证据：`projection/source.ts` 将 `{handle,targets,record}` 放进 bindings，再用 `Map<SourceRecord,receiver>` 查回同一绑定的接收函数。`make(targets,collection?)` 还要求集合 selector 同时出现在两个参数中。

- [x] binding 内直接保存接收行为，删除 receivers Map 和每次 capture 的二次查找。
- [x] 集合 binding 从 collection selector 得到 target；普通 targets binding 接收 targets。入口以真实来源类别区分，避免调用方构造 `[selector], selector`。
- [x] commits、reset、候选 keys 与 orderDirty 继续属于该 binding 的未结算状态，clear 一次清理。只在发布 context 时生成 readonly 数组，不在每个 commit 重建候选数组。
- [x] 保留 scheduler 的 source registry 和集合能力验证；它们服务图依赖与输入能力，不因也有 handle 就盲目删除。

验收：同一文档多 target 绑定复用、多个提交 batch、fromReadable、故障恢复和 disposal；source candidate 只覆盖相关成员。

#### E2. Projection item 按成员拥有句柄、版本和监听器 [P2]

证据：`projection/collection.ts` 的 items、itemVersions、itemListeners 都以相同 key 描述一个成员可读对象，其创建、发布和 release 分散维护。

- [x] 用一个成员记录持有 readable、revision 和惰性 listeners。记录仅在 item(key) 首次被请求时创建，不为全量 canonical 成员分配记录。
- [x] 发布命中变化的成员记录后就地更新版本；item.current 仍从 projection values 读取，不在成员记录中复制 value。
- [x] 保持只遍历有订阅成员的故障/重建通知路径。必要的活跃记录 Set 属于派生索引，不能为了“只有一个 Map”退化成遍历所有历史 item 句柄。
- [x] clear/release 与订阅注销归入现有 collection owner。删除分散的版本 Map 和按 key 重新查找同一记录的调用。

验收：item 引用稳定、删除后重建、同值不通知、初始 revision、故障恢复；大量已请求但无订阅 item 不拖慢广播路径。

#### E3. 每次 evaluate 共享一个 scope predicate [P2]

证据：`projection/node.ts` 在 entries.map 中为每个 source 创建 `() => active`，然后再为 behavior 创建一份相同闭包。

- [x] 每次 evaluate 只创建一个 active predicate，传给所有 source context 和 behavior。
- [x] 保留跨 evaluate 的隔离：不能复用上次 predicate 并重新激活旧 reader。
- [x] 保留 Object.fromEntries 等结构化 API，除非 profile 证明它是热点且替换能保留特殊属性键的正确语义。不把“减少调用”当作手写对象构造的理由。

验收：旧 context 永远不会因下一次 evaluate 再次有效，多 source 依赖、异常 finally 与 callback 结束检查通过。

### F. Runtime 与适配边界：保留清楚的生命周期

- [x] 保留 runtime.mutate 的统一授权/执行/回滚/seal 主链，以及回滚边界之外的 publish。不为减少一层函数把 observer 错误混入事务失败。
- [x] 保留 history 的方向、source、记录策略；它们是操作意图，不是能从 container 推导的事实。暂不新建 CommitContext/MutationContext 包装对象。
- [x] 保留 notification 的 capture → settle → flush → listeners 阶段和调用期间的订阅快照语义。不合成一个通用 callback runner。
- [x] 保留 impact-target 对身份、schema、匹配规则的唯一所有权；React 不自行解包 selector。select/track/asReadable 是稳定消费边界，不因实现短小而删除。
- [x] 保留 local-sync 的写入权限与 durable replay 边界；此次内部收敛不改变 expectedRevision 和历史失效语义。

本域主要作为所有前述阶段的集成约束，不要求为了“整体优化”强行修改已清楚的代码。

### G. 文档、命名与最终清理

- [x] 更新 `docs/architecture.md`：容器类别、解析责任、树命令、recorder 完整组、callback 生命周期。
- [x] 更新 `docs/value-boundaries.md` 中笼统的“structural access expires”，明确 Draft/select/track 的 borrowed contract 与 projection callback 的显式检查。
- [x] 修改 AccessContext.active 的注释：省略检查的主体包括 Draft，不能只写 trusted readers。
- [x] 删除 `value-boundaries.test.ts`、`mutation-flow.test.ts` 中 callback 结束后对 escaped draft 行为的确定性断言。保留 callback 内 schema 换分支与删除重建断言，不把未定义行为变成测试契约。
- [x] 按实际变化更新 README、AGENTS.md、运行时技能引用文档。公共 API 如果没有变化，不制造无意义的示例改写。
- [x] 命名按域和职责组织：`list.set`、`recorder.order`、`source binding`、`item record`。不新增平铺的 writeHelper/getContext/resolveInfo/utils 等名字。
- [x] 不新增 Barrel、Manager、万能 Context 或兼容 overload。内部所有调用方直接迁移到最终协议。

## 4. 永久改动与删除配对

| 最终构造或变化               | 所属领域 / 生命周期                          | 替代或删除                                 | 必要消费者                          |
| ---------------------------- | -------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| 成员/树容器的明确类别        | address + session / 当前解析代               | tree 的伪 member layout、下游断言          | scope、commands、replay、recorder   |
| AccessContext 引用已有 state | access / callback                            | schema/root 重复来源和 root closure        | update、readWith、projection source |
| scope 内共享 Target 刷新函数 | access / scope                               | snapshot/collectionAccess 重走根路径       | proxy、snapshot、collection reader  |
| recorder 逐节点 tree 捕获    | mutation / 当前事务                          | capture callback、短 ids 数组              | tree commands、tree replay          |
| 完整的有序 recorder group    | recorder / 首次捕获至 seal/rollback          | 独立 OrderFact、片段 seal、mergeContainers | capture、absorb、restore、seal      |
| source binding 接收职责      | projection source / binding                  | receivers Map、重复 selector 参数          | document capture、source context    |
| 成员可读记录                 | projection collection / 首次 item 至 dispose | 分离的 handle/version/listener 存储协议    | item、publish、emit、release        |

不新增 canonical owner、session 类型、per-write command、per-member wrapper、统一全局 registry 或缓存失效协议。

## 5. 实施顺序

每阶段完成全部调用方迁移和旧路径删除，再进入下一阶段。下面的阶段是依赖顺序，A-G 是职责归属，二者不要混成平铺的文件清单。

1. [x] **基线与模型**：记录 check/profile/test.mjs 基线；完成 A1 并新增拒绝/回滚回归测试；确定 A2 解析协议。
2. [x] **命令入口**：完成 B1、C1；同步更新 scope、session、全部 operations、replay、测试和 bench 调用。
3. [x] **树与副作用**：完成 B2、B3；删除 editTree/capture 回调层；验证无变化与纯 payload 更新路径。
4. [x] **访问链与死代码**：完成 C2、C3；snapshot 与 access 共用刷新；删除无消费者 API。
5. [x] **首次状态与发布**：完成 D1、D2；完整组从 recorder 一次产出；删除 mergeContainers 旧协议。
6. [x] **派生消费者**：完成 E1-E3，按 F 核对 runtime、history、notifications、React、local-sync 集成。
7. [x] **文档与验收**：完成 G、执行下列验证矩阵、更新本文各项状态和实测结果，确认无双轨实现。

## 6. 验证与性能门槛

### 行为验证

| 改动域              | 重点用例                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| 成员与 replay       | 成功、部分写入后失败、真实 local before、undefined 与 absent、非法类型、重复/覆盖 ChangeSet       |
| schema 与 scope     | 同 callback 保留代理、换分支、同 schema 替换、父节点消失/重建、只读拒绝、projection reader 过期   |
| 树                  | 错误 members 组拒绝、空树与根、孤儿与环、深树移除、父子互反、set 无变化、历史逆向                 |
| recorder            | first-touch 去重、fixed slots、祖先吸收、order-only、顺序和值抵消、root reset、rollback           |
| 通知与历史          | 精确 impact、订阅增删期间顺序、processor 先 settle、observerErrors、不重新抛成 mutation rejection |
| projection 与 React | 稀疏 candidates、batch、多 source、引用稳定、动态依赖、item revision、故障与 dispose              |
| local-sync          | remote 历史失效、expectedRevision、写入权限、已接纳记录在更小限额下仍可 replay                    |

### 实测要求

- [x] 每阶段运行相关 Vitest 用例与 typecheck；完成时执行 `pnpm run check` 和 `pnpm run build`。
- [x] mutation/address/projection 改动执行 `pnpm run profile`，必要时 `pnpm run bench`；不以函数行数代替性能验证。
- [x] `test.mjs` 从包的 dist 入口运行，必须先 build，再执行 `node --expose-gc test.mjs`。记录 Node 版本、基线提交和工作区状态。
- [x] 同机交替比较基线与最终版本的多次结果，记录各工作负载 mean/p50/p95、GC 次数与时间、heap delta。heap delta 受 GC 时机影响，不把它等同于分配量。
- [x] `test.mjs` 主要覆盖 map 字段写入，不能代表集合命令、树和 projection。补充同 schema replacement、反复树 set/no-op、order-only、稀疏 item 通知等 focused workload。
- [x] 结构性门槛：重复字段写入不新增根路径解析；普通无跟踪读取不生成地址；树单值修改不全树扫描；order 首次快照只一次；稀疏修改不扫描无关集合；通知不为过滤构建 commit impact index。
- [x] 检查 allocation profile 或受控计数，确认删除的写入包装、树回调/短数组、重复 source predicate 确实减少。不得以每个字段的新对象换取更短签名。
- [x] 对性能变化明显超过基线波动的项目逐项解释；不能让主路径稳定变慢，再用其他 workload 的平均收益掩盖。必要时调整实现形态，但必须保持单一最终协议。

## 7. 完成定义

- [x] 树与成员 schema 边界正确，A1 最小复现被完整拒绝且原状态不变。
- [x] 已解析容器事实不再以平行参数跨领域传播；真正的成员身份、物理下标、存在性和修改意图仍清楚可见。
- [x] 每个命令只有一处定义当前定位事实的入口，写入内核不重复解析。
- [x] 每个 recorder owning group 直接发布完整 ChangeSet group，旧的内部片段合并协议消失。
- [x] 没有新增第二写入 authority、无约束上下文对象、per-write wrapper 或外部手动失效协议。
- [x] 无消费者 API、旧回调协议、旧文档和依赖未定义行为的测试一并删除。
- [x] 所有永久新增项都有明确 owner、生命周期、消费者和删除配对；格式、lint、类型、行为、构建与性能证据齐全。

最终验收以职责和数据流更容易解释、重复工作实际减少为准，不以参数最少或代码行数最少为准。

## 8. 实施结果（2026-09-09）

已完成 A-G 全部阶段。运行时最终调用链已收敛到 `container` 携带地址、schema、canonical storage 的解析事实；tree 使用独立 `ResolvedTreeContainer`，普通 members ChangeSet 不能写入树；集合操作、tree commands、replay 不再传递重复的容器地址；`MutationSession.editTree`、tree capture callback、`OrderFact`、`sealOrder`、`mergeContainers`、`schemaOf`、`documentOf`、DependencyTracker 无消费者方法和 source receivers Map 已删除。Recorder 的有序成员组直接持有首次 order baseline 并一次发布完整 members group。Projection item 记录合并 readable、revision 和惰性监听器。

验证结果：`pnpm run check` 通过，17 个测试文件、231 个测试通过；`pnpm run build` 通过；`pnpm run profile` 通过；`git diff --check` 通过。新增覆盖树 members 越界拒绝及回滚、树重复 payload/no-op、snapshot 定位复用、列表顺序捕获、projection item 删除重建、跨 session 容器拒绝。

性能证据：Node `v24.11.1`，基线 `ea8fb80`，最终为当前未提交工作区。前三轮有 GC 波动，第三轮还与检查进程重叠，不据此宣称优化收益。第四轮两版本串行运行且未并行运行检查，结果如下（单位 ms）：

| 总实体 / 修改实体 / 监听器 | 基线 mean | 最终 mean | 基线 p50 | 最终 p50 | 基线 p95 | 最终 p95 | 基线 / 最终 GC 次数 | 基线 / 最终 GC 时间 |
| -------------------------- | --------- | --------- | -------- | -------- | -------- | -------- | ------------------- | ------------------- |
| 1000 / 1000 / 0            | 2.216     | 2.386     | 1.306    | 1.378    | 2.717    | 6.535    | 9 / 8               | 130.4 / 94.5        |
| 10000 / 10000 / 0          | 24.882    | 23.591    | 13.296   | 13.160   | 107.512  | 109.786  | 64 / 62             | 1975.2 / 1793.5     |
| 10000 / 100 / 0            | 0.119     | 0.130     | 0.117    | 0.125    | 0.136    | 0.150    | 0 / 0               | 0 / 0               |
| 100000 / 1000 / 0          | 2.363     | 2.425     | 1.255    | 1.239    | 2.501    | 2.339    | 7 / 6               | 162.8 / 172.0       |
| 10000 / 100 / 1000         | 0.160     | 0.161     | 0.131    | 0.131    | 0.170    | 0.168    | 1 / 1               | 4.3 / 3.9           |

没有证据支持全面耗时/GC 下降。全量 10k 本轮约快 5%，小规模无监听场景约慢 8-9%，后者绝对差约 0.01ms/0.17ms，跨轮 mean 受 GC 时机影响；将此明确保留为性能限制，不能把删参数等同于加速。代码没有引入每写入包装对象，原有 100k 重复字段写入和稀疏集合计数门槛继续通过。

Profile 中 tree repeated 的 resolution 从 `1000` 降到 `1`，generation invalidation 从 `1000` 降到 `0`；table/list membership 的 documentSteps 从 `1` 降到 `0`；列表单次删除的 orderCaptures/orderSnapshots 都为 `1`。新结构测试验证 snapshot 复用定位，不增加根地址遍历。

原始数据保存在本机 `/tmp/doxum-flow-ab-{baseline,final}-{1,2,3,4}.log`，每份包括三次 trial、p50/p95、GC 和 heapDeltaBytes；profile 为 `/tmp/doxum-flow-{baseline,final}-profile.log`。这些是本次验证临时产物，不属于包内容。分配减少的结论限于已删除的对象/数组/回调构造点和受控工作计数；没有把 heap delta 当成总分配量。

长期约束：Draft、select、track/readWith reader 按同步借用约定，不对逃逸行为建立测试契约；projection source reader 仍保留 active 检查；输入 payload 外部不可变更的所有权协议继续成立。dist 由 build 生成，未手工编辑。
