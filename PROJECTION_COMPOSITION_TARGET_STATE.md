# Projection Processor Composition 最终目标态与实施方案

> 本文定义 Projection 的多输出 processor composition 目标态。
> 范围包括多命名 keyed output、嵌套命名空间、同一 causal batch 的原子发布、
> 下游 processor 组合、Runtime/scope 所有权、scheduler 结算和测试实施。
>
> 本文是设计与实施合同；本文定义的最终目标态已经完成落地。实现不保留兼容
> API、平行协议或临时适配层。

## 0. 决策摘要

最终只新增一个公共 processor 入口：

```ts
incremental.group(dependencies, defineOutputs, processor);
```

它建立一个 processor group，并返回一个静态的 output record。每个 output
叶子都是普通 Projection：

```ts
Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>;
```

因此下游仍然通过显式 Projection 依赖组合：

```ts
const render = incremental.group(
  [graph.nodes, graph.edges, graph.mindmaps],
  define => ({
    node: {
      shell: define.collection<NodeId, NodeShell>(),
      content: define.collection<NodeId, NodeContent>(),
    },
    edge: {
      shell: define.collection<EdgeId, EdgeShell>(),
      path: define.collection<EdgeId, EdgePath>(),
    },
    labels: define.collection<LabelId, Label>(),
  }),
  ({ sources, changes, outputs }) => {
    // outputs.node.shell.set(...)
    // outputs.edge.path.remove(...)
  }
);
```

最终规则：

- 一个 group 只执行一次 processor，但可以产生多个命名 keyed output。
- 所有 output 在同一个 publication barrier 中提交。
- 每个 output 独立生成现有 `CollectionChange`。
- 下游依赖 output Projection，不直接订阅事件。
- 嵌套命名只表示静态 namespace，不产生嵌套 Runtime、scheduler 或事务。
- processor state、fault、rebuild 和 disposal 归整个 group 所有。
- public API 不新增 `OutputRuntime`、`OutputHandle`、event bus 或第二套 change 协议。

## 1. 现有基础与问题边界

当前 Projection 已经具备本能力所需的大部分基础：

| 现有能力                 | 当前责任                                           | 继续保留          |
| ------------------------ | -------------------------------------------------- | ----------------- |
| `Projection<T, C>`       | 惰性定义，不持有物化状态                           | 是                |
| `ProjectionRuntime`      | materialization、缓存、batch、readable、dispose    | 是                |
| `incremental.collection` | 一个 processor 对一个 collection output 的增量处理 | 扩展，不另起协议  |
| `CollectionRead`         | callback 内借用的 keyed 只读读取                   | 是                |
| `CollectionDraft`        | callback 内借用的 keyed 写入意图                   | 是                |
| `CollectionChange`       | 唯一的 added/updated/removed/order transition      | 是                |
| `Scheduler`              | settle、拓扑顺序、fault、publication、notification | 扩展 barrier/wave |

现有单 output context 的核心形状是 `previous`、`next`、`output`；多 output
只需要把它提升为静态命名 record，而不是发明新的 transition 体系。

## 2. Final Goal

Projection 应形成下面一条唯一的计算脊柱：

```text
document / session / input projections
                │
                ▼
         ProcessorGroup A
       ┌──────┼────────┐
       ▼      ▼        ▼
    nodes   edges   mindmaps
       │      │        │
       └──────┼────────┘
              ▼
         ProcessorGroup B
       ┌─────┼──────┬─────┐
       ▼     ▼      ▼     ▼
  nodeShell  ...  edgePath labels
```

一个 group 是一次计算和一次原子提交的边界。一个 output 是一个可被下游
Projection 消费的 keyed collection，不是独立的 Runtime 或事件流。

必须满足以下不变量：

1. 同一个 group 的 processor 在一个 causal batch 内最多执行一次。
2. processor 的所有 output 只在 processor 成功完成并通过校验后才发布。
3. 下游 processor 只能在上游所有变化的 output 都完成 publication 后执行。
4. 同一个 group 内某个 output 无变化时，不增加该 output revision，也不通知其 listener。
5. 任意 output 的 `added`、`updated`、`removed`、`before`、`after` 和 `order` 都由 Runtime 从边界状态计算，调用方不得手动构造。
6. processor 失败或 group rebuild 时不得产生部分 output 状态。
7. processor state 在 Runtime 和 scope 内隔离；同一个 definition 不共享 state、revision、订阅或缓存。
8. output definition 和 namespace 在定义时固定，运行中不能动态添加或删除。
9. namespace 不属于 scheduler graph；只有 output 叶子参与依赖、revision、订阅和 disposal。
10. 所有 callback 同步执行；`CollectionRead` 和 `CollectionDraft` 不能逃逸 callback。

## 3. 最终公共 API

### 3.1 `incremental.group`

`incremental.group` 是唯一新增的公共 processor composition 入口：

```ts
const graph = incremental.group(
  [documentProjection],
  define => ({
    nodes: define.collection<NodeId, Node>(),
    edges: define.collection<EdgeId, Edge>(),
    mindmaps: define.collection<MindmapId, Mindmap>(),
  }),
  ({ sources, changes, previous, next, outputs, state, reset, cause }) => {
    // 一次调用内共同更新 nodes、edges、mindmaps
  }
);
```

`define` 是声明 callback 内的静态 output builder，不单独导出为领域概念。
其唯一职责是声明 output 的 key/value 类型以及可选的 entry equality；不持有
Runtime 状态，不建立订阅，不执行 processor。

`incremental.group` 的返回值是只读 output record。原则上不需要导出名为
`ProjectionGroup` 或 `OutputTree` 的公共运行时类型；TypeScript 通过返回 record
的结构推导每个叶子 Projection。

### 3.2 嵌套命名空间

嵌套对象只表达命名和领域分组：

```ts
const render = incremental.group(
  [graph.nodes, graph.edges],
  define => ({
    node: {
      shell: define.collection<NodeId, NodeShell>(),
      content: define.collection<NodeId, NodeContent>(),
    },
    edge: {
      shell: define.collection<EdgeId, EdgeShell>(),
      path: define.collection<EdgeId, EdgePath>(),
    },
    labels: define.collection<LabelId, Label>(),
  }),
  ({ outputs }) => {
    outputs.node.shell.set(nodeId, shell);
    outputs.edge.path.set(edgeId, path);
    outputs.labels.set(labelId, label);
  }
);
```

规则：

- namespace 只能是静态普通对象。
- output 只能是叶子。
- 同一个 key 不能同时是 namespace 和 output。
- 不支持数组、动态 key、运行时 `add/remove`。
- namespace 本身不是 Projection，不能传给 `get`、`readable`、`derive` 或 processor 依赖。
- 只有叶子才有 `Projection`、`CollectionChange`、revision 和 subscription 语义。
- 返回的 namespace/output record 必须只读且冻结，防止应用修改 graph topology。

不建议暴露字符串路径 API：

```ts
outputs.get('node.shell');
outputs.subscribe('edge.path', listener);
```

内部可以保存结构化的 leaf path 用于诊断，例如 `['node', 'shell']`，但不能
引入 dotted-string parser 或第二套 application address 模型。

### 3.3 Processor context

多 output context 按 output namespace 镜像：

```ts
type GroupContext = {
  readonly sources: InputValues;
  readonly changes: InputChanges;

  readonly previous: OutputReads;
  readonly next: OutputReads;
  readonly outputs: OutputDrafts;

  readonly reset: boolean;
  readonly cause: unknown;
  readonly state: Record<string, unknown>;
};
```

例如：

```ts
previous.node.shell;
next.node.shell;
outputs.node.shell;
```

`changes` 仍然是输入依赖按位置对齐的 tuple。output 自身的 change 在 processor
完成后由 Runtime 生成，不作为 processor 的写入协议传入。

每个 output draft 继续复用现有 `CollectionDraft`：

```ts
outputs.node.shell.set(id, value);
outputs.node.shell.remove(id);
outputs.node.shell.order(ids);
```

不增加 `replace`、`commit`、`publish`、`subscribe`、`flush` 等方法。

### 3.4 下游组合

下游 processor 通过 Projection 依赖连接：

```ts
const render = incremental.group(
  [graph.nodes, graph.edges, graph.mindmaps],
  define => ({
    nodeShell: define.collection<NodeId, Shell>(),
    edgePath: define.collection<EdgeId, Path>(),
    labels: define.collection<LabelId, Label>(),
  }),
  processor
);
```

禁止在 processor 内部手动订阅：

```ts
graph.nodes.subscribe(...); // 不属于 processor composition API
```

`subscribe` 仍然只属于 `Readable`，服务于 React 和外部 store 集成。

### 3.5 Scope 集成

局部 scope 直接拥有整个 group：

```ts
const scope = runtime.scope();

const graph = scope.incremental.group(
  [documentProjection],
  define => ({
    nodes: define.collection<NodeId, Node>(),
    edges: define.collection<EdgeId, Edge>(),
  }),
  processor
);

scope.dispose();
```

scope dispose 一次释放 group、所有 output、processor state 和 readable。父图的
document/session projection 继续存在；父级和 sibling scope 不能反向依赖该 group。

### 3.6 Lazy materialization 边界

任意一个 output leaf 首次被 `get`、`readable` 或下游 projection 使用时，Runtime
materialize 整个 group。由于所有 output 共享一次 processor 执行和一个原子提交
边界，不能只计算其中一个 leaf。

因此：

- 读取 `graph.nodes` 会同时建立 `edges`、`mindmaps` 的 output state；
- group processor 仍然只执行一次；
- 后续读取其他 leaf 不会再次 materialize 或重复执行初次构建；
- 只需要一个 output 时继续使用 `incremental.collection`；
- 如果多个 output 成本很高且没有共同原子性要求，应拆成多个 group。

这项取舍是 group-level atomicity 的直接结果，不提供 per-leaf lazy processor，避免
一个 group 内出现多个不一致的计算世代。

## 4. Causal Batch 与原子发布

### 4.1 结算波次

多 output 不能直接复用“每个 output 一个普通 node，然后按顺序通知”的模型，
否则下游可能看到半新半旧状态。

Scheduler 必须使用计算波次和 publication barrier：

```text
Wave 1: 计算当前 causal batch 中所有 dirty group
Barrier: 原子发布每个 group 的全部 output
Wave 2: 计算依赖这些 output 的下游 group
Barrier: 原子发布下游 output
最后: 统一通知外部 Readable listener
```

如果一个 downstream group 同时依赖两个 upstream group，它必须在两个 upstream
都完成 barrier 后才执行，不能先看到其中一个的新值。

同一 group 内的 output 也必须作为一个 publication unit：

```text
graph.nodes    ─┐
graph.edges    ─┼─ group publication
graph.mindmaps ─┘
```

### 4.2 Output change

每个 output 独立发布已有的 `CollectionChange`：

```ts
graph.nodes: CollectionChange<NodeId, Node>
graph.edges: CollectionChange<EdgeId, Edge>
graph.mindmaps: CollectionChange<MindmapId, Mindmap>
```

一个 causal batch 可以得到：

```text
nodes    -> incremental
edges    -> unchanged
mindmaps -> incremental
```

`edges` 不会因为同属一个 processor 就产生空通知或 revision 增长。

`CollectionChange` 不增加 `outputName` 或 `batchId`：

- output 名称已经由 Projection 依赖字段确定；
- batch correlation 已由 Runtime 的 batch context 和 `cause` 表达；
- change 只描述 keyed collection transition，不混入调度元数据。

### 4.3 初次构建、rebuild 与失败

初次构建时，所有 output 进入 `reset` 语义。processor 必须构建完整 output；
没有写入的 output 以空 collection 发布 reset。

如果 processor 返回 `{ kind: 'rebuild' }`：

- 整个 group rebuild；
- 所有 output 重新计算；
- 不允许某一个 output 单独 rebuild；
- rebuild 结束前不发布任何 output。

如果 processor 抛错：

- 所有 output 保持上一个已发布 snapshot；
- 不允许部分 output 提交；
- group 进入 fault 状态；
- downstream output 被阻塞；
- 报告一个 group-level `ProjectionError`。

如果两个 output 需要独立 fault 或 rebuild，应拆成两个 group，而不是把 group
内部做成多个独立错误边界。

## 5. Ownership 与内部模型

### 5.1 表示账本

| 表示                    | 角色                                    | Owner                                    | 生命周期                                | 最终动作                               |
| ----------------------- | --------------------------------------- | ---------------------------------------- | --------------------------------------- | -------------------------------------- |
| group definition        | 惰性 definition                         | definition registry；scope 可绑定 owner  | root 可跨 Runtime 复用；scoped 随 scope | 新增 definition kind                   |
| output leaf definition  | group definition 的静态出口             | group definition                         | 随 group definition                     | 不独立持有 state                       |
| output namespace        | API 边界的只读命名树                    | group definition 返回值                  | 随 definition                           | 不进入 scheduler                       |
| `ProcessorGroup`        | 内部 resolved/materialized compute unit | `ProjectionRuntime` 或 `ProjectionScope` | materialize 到 dispose                  | 唯一新增内部概念                       |
| output collection state | resolved keyed snapshot                 | `ProcessorGroup` 的 output slot          | group 生命周期                          | 复用 CollectionNode publication kernel |
| `CollectionDraft`       | processor-local session intent          | 单次 processor callback                  | callback 返回即失效                     | 保持现有协议                           |
| `CollectionChange`      | boundary transition                     | output publication boundary              | 一次 publication                        | 保持现有协议                           |

### 5.2 `ProcessorGroup`

`ProcessorGroup` 是内部调度概念，不对应用导出。它负责：

- 一份 processor callback；
- 一份 retained `state`；
- 一组显式输入依赖；
- 一棵静态 output leaf tree；
- 一次 evaluate；
- 一次 group-level reset/rebuild/fault；
- 一次 atomic publication。

它不负责：

- canonical document state；
- application event bus；
- 外部 listener lifecycle；
- 手动 output subscription；
- 第二个 Runtime 或 scheduler。

### 5.3 Output collection state

当前 `CollectionNode` 内的下列逻辑应抽成可复用的内部 publication kernel：

- staged keyed state；
- borrowed previous/next read；
- `set/remove/order` 意图；
- entry equality；
- key coverage 和 order 校验；
- added/updated/removed/order 计算；
- persistent published snapshot；
- listener emission。

普通单 output collection 和 group output 都使用这个 kernel，禁止维护两套
collection change 计算或 map publication 实现。

## 6. 结构性规则

### 6.1 Graph 规则

- group 和 output definition 都是 lazy 的。
- 同一个 group 在同一个 Runtime 中只 materialize 一次。
- 一个 group definition 在不同 Runtime/scope 中的 state 完全隔离。
- output leaf 依赖 group output，而不是重新构造外部 readable。
- graph 必须是 DAG；检测到循环依赖时在 materialization 处拒绝。
- output schema 在定义期冻结；processor 运行中不得注册新 output。

### 6.2 Atomicity 规则

- processor callback 运行期间任何 output 都不可对外可见。
- 所有 output draft 校验成功后才允许 publication。
- group 的 output 不得跨多个 Runtime batch 分别提交。
- 下游 group 必须在上游 output barrier 之后读取。
- 外部 listener 只能在整个 scheduler settle 完成后通知。
- 通知期间禁止任何 projection write。

### 6.3 Change 规则

- output change 由真实 published before/after 状态生成。
- processor 不构造 `CollectionChange`，也不传入假的 before/after。
- 同一 key 的多次写入折叠为 batch 边界的净结果。
- 新增后删除、更新后恢复原值都不产生虚假 transition。
- 未触碰 output 不运行全量 diff；只对 staged key 计算变化。
- output order 独立计算，不能把 namespace 顺序误当 collection order。

### 6.4 Namespace 规则

- namespace 不是图节点、不是数据容器、不是 transaction boundary。
- namespace 不能被单独 `get`、`readable` 或订阅。
- namespace 的 leaf path 只用于稳定身份、调试和错误命名。
- 不新增 dotted path parser，不复用 document address parser。
- 建议公共使用深度不超过三层；深度本身不形成 runtime 限制。

## 7. 不采用的方案

### 7.1 Processor 返回多个完整 Map

```ts
return { nodes: nextNodes, edges: nextEdges };
```

不采用作为主协议，因为它通常要求构建或扫描完整 output，难以维持 keyed
incremental performance，也无法自然复用 `CollectionDraft`。

### 7.2 多个独立 processor 共享同一输入

```ts
incremental.collection([source], buildNodes);
incremental.collection([source], buildEdges);
```

不采用作为 composition 机制，因为会重复执行输入处理，分散 retained state，
并且没有同一 causal batch 的原子提交保证。

### 7.3 Event bus 或 output subscription

不采用 `on('nodes')`、`subscribe('edge.path')` 等机制。它会把 processor 依赖从
ProjectionGraph 中移走，重新引入手动订阅、生命周期泄漏、通知顺序和 reentrancy
问题。

### 7.4 Namespace 作为嵌套 ProcessorGroup

不因为存在 `node`、`edge` namespace 就自动创建子 group。namespace 只是命名树；
group 边界必须由 `incremental.group` 的声明显式决定。

## 8. 实施方案

### Phase 0：冻结最终合同 ✅

- [x] 确认唯一新增 public entry 是 `incremental.group`。
- [x] 确认 output namespace 是静态 readonly object tree。
- [x] 确认 output 叶子只支持 keyed collection，不在本阶段加入 value output。
- [x] 确认 group-level fault/rebuild 和 atomic publication 语义。
- [x] 确认 namespace 不导出为独立运行时类型。

### Phase 1：重构 collection publication kernel ✅

- [x] 从现有 `CollectionNode` 提取 staged state、seal、change、snapshot publication。
- [x] 保持现有 `CollectionChange`、`CollectionRead`、`CollectionDraft` 形状不变。
- [x] 让普通 `incremental.collection` 和 group output 共用同一 kernel。
- [x] 删除任何重复的 output diff、order 校验或 map snapshot 实现。

### Phase 2：增加 group definition ✅

- [x] 在 definition registry 增加 group definition 和静态 output leaf metadata。
- [x] 递归解析 output namespace，拒绝动态 key、重复 leaf 和 namespace/leaf 冲突。
- [x] 为每个 leaf 创建惰性 Projection definition。
- [x] 确保 output Projection 不持有 group state。
- [x] 将 `define.collection` 限定在 group declaration callback 内。

### Phase 3：实现 ProcessorGroup materialization ✅

- [x] Runtime 首次 materialize 任意 leaf 时，materialize 整个 group 一次。
- [x] group state、processor instance 和所有 output state 归同一个 owner。
- [x] `previous`、`next`、`outputs` 递归镜像 output tree。
- [x] 一个 processor callback 只能执行一次，并获得同一 source snapshot。
- [x] output draft callback 返回后立即失效。

### Phase 4：改造 Scheduler settlement ✅

- [x] 引入 compute wave 和 publication barrier。
- [x] group output 在同一 barrier 内一起 publish。
- [x] barrier 完成后再 enqueue 下游 processor。
- [x] 处理一个 downstream 同时依赖多个 upstream group 的情况。
- [x] 保持现有 fault recovery、observer error 和 notification ordering。
- [x] 禁止 compute/notify 阶段 reentrant write。

### Phase 5：接入 scope 与 React ✅

- [x] `scope.incremental.group` 直接绑定 group owner。
- [x] scope dispose 逆拓扑释放整个 group 的 output、state 和 readable。
- [x] 父 projection 可以作为 scope group 输入。
- [x] root/sibling 不能反向依赖 scope output。
- [x] React `ProjectionProvider` 继续接受 runtime 或 scope，不新增 composition adapter。

### Phase 6：删除平行路径并更新文档 ✅

- [x] 不保留 multi-output event adapter。
- [x] 不保留独立 output runtime、output handle 或 output subscription。
- [x] 不保留另一套 multi-change/delta 类型。
- [x] 更新 README、`docs/projections.md`、`docs/architecture.md` 和 runtime skill reference。
- [x] 增加本文件到 Projection 目标态文档索引。

## 9. 测试矩阵

### API 与类型

- [ ] flat output record 的类型推导。
- [ ] 嵌套 namespace 的叶子 Projection 类型推导。
- [ ] namespace 本身不能作为 Projection 使用。
- [ ] namespace/leaf 冲突被拒绝。
- [ ] 动态 output 注册在类型或运行时被拒绝。

### 计算与提交

- [ ] 初次构建所有 output 都得到 reset。
- [ ] 一个 source change 只执行一次 group processor。
- [ ] 多个 output 在同一 causal batch 一起发布。
- [ ] 未变化 output 不增加 revision、不通知 listener。
- [ ] 一个 output 变化而其他 output 不变化时，变化集合准确。
- [ ] `added/updated/removed/order` 的 before/after 完整且真实。
- [ ] batch 内同一 key 多次写入只产生最终净变化。

### Composition

- [ ] 下游只在上游全部 output publication 后执行。
- [ ] downstream 同时依赖两个 upstream group 时不看到半新半旧状态。
- [ ] 多级 `graph -> render -> paint` 仍然在同一 causal settle 中完成。
- [ ] 下游只依赖一个 leaf 时可以精确收到该 leaf change。
- [ ] output leaf 可以被 `derive`、`incremental`、`readable` 和 React 消费。

### 失败与生命周期

- [ ] processor 抛错时无 output 部分提交。
- [ ] group rebuild 时所有 output 一起 rebuild。
- [ ] group fault 恢复后所有 output 状态重新一致。
- [ ] scope dispose 释放整个 group，父 projection 仍可用。
- [ ] 同一个 group definition 在多个 Runtime 中 state 隔离。
- [ ] output readable 在 Runtime/scope dispose 后失效。
- [ ] 循环依赖在 materialization 时拒绝。

### 性能

- [ ] 单 key 更新只触碰受影响 output 的 staged keys。
- [ ] 未变化 output 不做全量 collection diff。
- [ ] 10000 项 collection 单 key 更新不扫描无关 entries。
- [ ] 多 output processor 比多个独立 processor 少一次输入处理。
- [ ] 多级 group 不产生重复 publication 或重复 listener notification。

## 10. Change-Surface Ledger

| 新增或修改                             | Owner                          | 替代/删除                              | 影响消费者                           |
| -------------------------------------- | ------------------------------ | -------------------------------------- | ------------------------------------ |
| `incremental.group`                    | `advanced` definition factory  | 替代多 processor 手工拼接              | advanced processor、应用 projection  |
| static output tree declaration         | group definition registry      | 删除动态 output/event 注册想法         | TypeScript API、Runtime materializer |
| `ProcessorGroup`                       | ProjectionGraph/Scheduler 内部 | 替代多个独立 output processor 的伪组合 | scheduler、scope lifecycle           |
| reusable collection publication kernel | CollectionNode 内部            | 删除重复 change/diff 实现              | 普通 collection、group outputs       |
| publication wave/barrier               | Scheduler                      | 删除按 output 逐个通知的路径           | 所有 processor、Readable、React      |
| recursive output context               | group processor boundary       | 替代平铺的 previous/next/output 参数   | processor 作者                       |

不新增：

- `OutputRuntime`
- `OutputHandle`
- `OutputSubscription`
- `OutputEvent`
- `MultiCollectionChange`
- `NestedScheduler`
- `OutputTransaction`
- dotted string output address

## 11. 完成标准

只有同时满足以下条件，processor composition 才算完成：

1. `incremental.group` 是唯一多 output 公共入口。
2. output 叶子全部是普通 Projection，能直接进入现有依赖图。
3. nested namespace 只影响 API 组织，不增加 graph/scheduler 语义。
4. 一个 group 的所有 output 具备 all-or-nothing publication。
5. 下游 processor 不需要任何手动订阅或事件转发。
6. 每个 output 使用现有 `CollectionChange`，没有 parallel protocol。
7. group state、output state、readable 和 scope 生命周期只有一个 owner。
8. scheduler 能保证多 upstream、多 output、多级 processor 的完整 causal 顺序。
9. 普通单 output collection 与多 output group 共用 publication kernel。
10. 文档、类型测试、运行时测试、错误测试和性能测试都通过。
11. 搜索仓库确认没有遗留 event bus、output adapter、duplicate change 或旧 API。
