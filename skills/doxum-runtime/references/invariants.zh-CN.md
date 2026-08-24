# Doxum Runtime 不变量

修改或审查 mutation、addressing、impact、notification、history、tree 或 projection 前应阅读本页。这些是设计边界，而不是可选的代码风格。

## 唯一的 canonical 写入权威

`createDocument` 拥有 canonical mutable document state。新的 mutation 行为只能通过 `runtime.update`、`runtime.apply` 或 `runtime.replace`。writer 只是向 mutation session 产生 operation，而不是绕过 runtime 修改对象的出口。

绝不能新增：

- 并行的可写 document cache；
- 在 runtime 外编辑 document state 的 reducer；
- 由调用方手工同步的 view；
- 绕过 decode、normalization、inverse 记录、rollback、impact、history 或 notification 的 operation 执行路径。

## Transaction 生命周期与原子性

transaction callback 必须同步。reader 与 writer 只在 callback 执行期间有效。`async` callback、保存 reader/writer 供后续使用、嵌套写入，以及 notification 期间写入都会破坏 runtime 边界。

每个 session 都是原子的。若一个 operation 在之前已有状态变更后被拒绝，session 之前的全部工作都必须回滚。callback 抛错也会回滚，然后将原始错误继续抛出。预期中的拒绝应该通过返回结果表示，而不是异常协议。

## 保持引擎问题与应用问题分离

| 问题                                      | 所有者           | 结果形状                                        | 正确处理方式                                 |
| ----------------------------------------- | ---------------- | ----------------------------------------------- | -------------------------------------------- |
| malformed、无法解析或语义无效的 operation | Doxum engine     | `source: 'mutation'` 的 `MutationIssue`         | 检查 rejected operation/transaction result。 |
| 应用业务规则或校验                        | Application      | `source: 'application'` 的 `DocumentDiagnostic` | 使用 `tx.report` 或 `tx.reject`。            |
| callback 缺陷或意外失败                   | Application code | rollback 后抛出的 error                         | 在 transaction 外修复或处理异常。            |
| processor、flush 或 listener 失败         | Observer         | committed result 上的 `observerErrors`          | 修复 observer；不要重放已提交的 write。      |

不要再创建笼统的 `invalid` status，不要把全部 error 字符串化为同一个形状，也不要将 notification failure 变成 mutation rejection。Mutation issue code 是封闭的公共词汇，必须保持精确。

## Schema 拥有 addressing 与 selector

schema 定义 operation 与 selector 的合法语义地址。address resolution 结合 schema 结构和当前 document state，这对于 collection entry 和 variant branch 都是必要的。

长期使用的 target 应由 `schema.value(...)` 与 `schema.collection(...)` 创建。runtime 的地址域使用 `runtime.address`；target 的 identity 与 bucket 使用导出的 `target` namespace。不要新增 string-path parser、另一种 address type、自定义 selector ID 或独立的 impact-target equality helper。

## Operation 只有一条 pipeline

外部 operation 输入遵循如下顺序：

```text
decode -> normalize -> resolve -> execute -> inverse + journal -> publish
```

`apply` 是不可信 operation envelope 的边界。executor code 看到输入前必须完成 decode；随后要归一为唯一 canonical operation shape、按 schema resolve，并且只能整体 publish 或整体 rollback。每个 committed operation 都需要精确的 inverse data 与精确的 impact。

本地应用行为应使用 writer，而不是手工拼 operation object。直接构造 operation 适用于边界 adapter、fixture、migration 和有意的 replay。

## 所有权必须明确

- `initial` 在成为 canonical state 前会被 clone。
- 普通 operation 中的结构化 payload 会转移到 canonical state。提交后仍修改它，可能会修改 canonical data。
- commit 与 history 的 operation payload 是不可变 snapshot。
- 已发布的 diagnostic 与 selector address 会被复制并冻结。
- tree replacement snapshot 会先校验并 clone。

不要承诺 Doxum 有意进行 payload transfer 的地方存在深度不可变性。调用方若要保留可变所有权，应在提交前自行 clone。

## Tree 完整性是整个 document 的完整性

每个存在的 tree 必须为空，或恰好只有一个 root；从 root 可完整到达所有节点、无环、无重复 child 引用，且 parent/child 双向一致。initial state 与 replacement snapshot 会完整检查，本地 tree operation 则增量维持它。

不能接受不连通 forest、orphan node、非 root move 到无 parent、将 root 挂到另一节点之下，或直接编辑 tree 的内部 record。tree operation 被拒绝时，整个 transaction 必须保持不变。

## Impact 与 notification 描述已提交状态

每次 commit 都发布一个 `DocumentImpact`；它不是让调用方修改的 mutable change log。value impact 使用 `affects(target)` 判断；collection impact 精确报告 added、removed、updated 和 order change，或在 replacement/subtree reset 后报告 `reset`。

notification 顺序是可观察行为：

```text
commit -> materialized processors -> processor flushes -> targeted listeners -> root listeners
```

update 与 notification 窗口中禁止写入。processor、flush 和 listener error 会被收集，但 committed document、revision 与 history 必须保持稳定。

## 派生状态应声明，而不是由调用方同步

`CollectionView` 从一个已声明的 collection 派生，并增量维护 ids、keyed values 和惰性 aggregate array。`MaterializedView` 从 document read、跟踪到的 impact dependency 和可选的更早 materialized source 派生一个值。materialized view 只能依赖同一 runtime 中比它更早创建的 view。

不要把 derived value 缓存在 canonical document state 中，除非它本来就是领域数据。不要让 UI 手工将变更推入 view。view 与 subscription 都应随 owner dispose。

## Framework 与产品边界

`core` 必须保持 framework-neutral。`doxum/react` 是从 core 到 React 的单向 adapter；core 不能 import React 或 UI 概念。Doxum 有意不决定 persistence format、网络同步、authorization、retry、acknowledgement、ordering 或 conflict resolution。应用必须在 apply operation 或 replace snapshot 前做出这些决策。

## 改动检查清单

runtime 相关改动交付前检查：

- 每一次 canonical write 是否仍经由 `createDocument`？
- 适用时，是否测试了成功、rejected rollback、inverse history 与 impact/subscription 行为？
- tree 与 collection 路径是否避免了意外的全量 document copy 或 traversal？
- 公共生命周期语义变化时，是否更新了 README 与 architecture guide？
- 过时的 protocol type、局部 helper 和重复的 address/target 解释是否被删除，而不是为了兼容继续保留？
