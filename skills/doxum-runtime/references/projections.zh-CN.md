# Projection 参考

根 Projection 定义惰性且可跨 Runtime 复用；scope 定义惰性但只属于其局部生命周期。默认入口包含 `Projection<T>`、
`ProjectionRuntime`、`input`、`observe`、tuple 形式的 `derive` 和保持 key 的
`derive.keyed`。

```ts
const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');
const visible = derive([tasks, filter], (tasks, filter) =>
  filter === 'all' ? tasks : new Map([...tasks].filter(([, task]) => !task.done))
);
const runtime = createProjectionRuntime({ onError: report });
runtime.get(visible);
```

`input(initial, equality?)` 属于每个 Runtime，只能通过
`runtime.set(input, value)` 写入。`observe(document, selector)` 延迟编译文档
边界；集合路径发布只读 map-like 快照，省略 selector 时发布整个文档快照。
现有 Doxum `Readable` 和带事件的 external source 也在这个边界接入。External
source 通过 `kind: 'value'` 或 `kind: 'collection'` 区分语义，但调用方统一使用
`observe(source)`。

schema map、table 和 `list(field, { keyOf })` 都是 keyed collection path。list
直接使用 schema 的 `keyOf` 作为稳定 identity，并按文档顺序迭代；数组类型的普通
`field(...)` 仍然是 scalar value observation。
tree 结构复用相同的 source 类型：`path.tree.rootId` 是 scalar，
`path.tree.nodes` 是 keyed collection，`path.tree.nodes.item(id)` 是单节点 value。
tree 的 committed node group 直接路由到受影响的 keyed entry，由现有
`CollectionOutput` 生成普通 `CollectionChange`；未变化节点的 snapshot identity
保持稳定。

External event 不再复用 Runtime context：value event 提供新 `value` 和
`revision`；collection event 提供稳定的 `previous` read、`revision` 和可选的
`impact` hint。Runtime 自己计算精确的 `CollectionChange`，processor 不会直接收到
impact。

`derive(dependencies, compute, equality?)` 使用 tuple，依赖在定义创建时固定。
Processor 不能通过读取另一个 Projection 隐式建立图依赖。

当一个 keyed collection 决定 output 的 membership 与 order 时使用
`derive.keyed`：

```ts
const labels = derive.keyed(entries, entry => entry.label);
```

只有 added / updated 的 driver entry 执行 selector；removed 删除同 key output，
纯 order 变化直接保持 driver 顺序，不重新计算未变化 entry。Collection output
继续按每个 entry 的 equality 比较，因此 source entry 虽然 updated，但 selected
value 相等时不会产生 output `updated`。首次物化、source reset 和故障恢复继续走
ProjectionRuntime 原有 processor rebuild 生命周期。

跨 keyed collection 的动态 lookup 也使用同一个 derivation，不由应用层再维护 join
协议：

```ts
const resolved = derive.keyed(
  links,
  [{ source: entities, key: link => link.entityId }, mode],
  (link, _linkId, entity, mode) => projectLink(link, entity, mode)
);
```

source Projection 仍是静态 producer dependency，只有每个 output key 对应的
source key 动态变化。物化后的 processor 拥有正向 binding 与 reverse index；一个
source entry 更新只重算当前绑定它的 output keys。source entry 暂时不存在时仍保留
binding，因此以后添加该 key 会正确唤醒依赖者。`mode` 这类普通 Projection
依赖变化则使整个 driver key set 失效。不要为此增加 processor 内 `runtime.get()`
追踪、wildcard document path grammar 或独立 join Runtime。

Runtime 的公开脊柱只有：

```ts
runtime.get(projection);
const selected = runtime.readable(projection, value => value.get(id));
selected.subscribe(listener);
runtime.set(input, value);
runtime.update(collectionInput, draft => draft.set(id, value));
runtime.batch({ cause }, run);
const scope = runtime.scope();
scope.dispose();
runtime.dispose();
```

`input.collection<K, V>(initial?)` 声明 Runtime 本地 keyed 状态。`update` 的借用 draft
提供 `get`、`has`、`set`、`remove`；单次 callback 同步且原子，Runtime batch 发布一次
精确的净 `CollectionChange`。scope 用 `scope.input`、`scope.derive`、
`scope.derive.keyed` 和 `scope.incremental` 声明局部投影，直接依赖同一 Runtime 中的根投影；dispose 只释放
局部 producer、状态和订阅。

Runtime 的 scheduler/output internals、item handle、rebuild、release 都是内部事实，不是应用层操作；
只有 `Readable` 自己的 publication revision 为 store 集成保留为公开事实。
Materialization、keyed storage、故障恢复和释放只有一个 owner。

## 增量 Processor

保持 key 的 selector 和声明式 dynamic keyed dependency 优先使用 `derive.keyed`。
只有算法需要该模型无法表达的应用级 retained state、跨 key index 或 output patch 时，
才从 `doxum/advanced` 引入增量 processor：

```ts
const totalWeight = incremental([tasks], ({ sources, changes, previous, reset }) => {
  const change = changes[0];
  if (reset || change?.kind === 'reset')
    return [...sources[0].values()].reduce((sum, task) => sum + task.weight, 0);
  if (!change) return previous ?? 0;
  let next = previous ?? 0;
  for (const entry of change.added) next += entry.after.weight;
  for (const entry of change.updated) next += entry.after.weight - entry.before.weight;
  for (const entry of change.removed) next -= entry.before.weight;
  return next;
});

const weights = incremental.collection([tasks], ({ sources, changes, output, reset }) => {
  const change = changes[0];
  if (reset || change?.kind === 'reset') {
    for (const [id, task] of sources[0]) output.set(id, task.weight);
    output.order([...sources[0].keys()]);
    return;
  }
  if (!change) return;
  for (const entry of change.added) output.set(entry.key, entry.after.weight);
  for (const entry of change.updated) output.set(entry.key, entry.after.weight);
  for (const entry of change.removed) output.remove(entry.key);
  if (change.order) output.order([...sources[0].keys()]);
});

const render = incremental.group(
  [selection],
  define => ({
    geometry: define.value<Geometry>(),
    label: define.value<Label>(),
  }),
  ({ sources, outputs }) => {
    const layout = computeLayout(sources[0]);
    outputs.geometry.set(layout.geometry);
    outputs.label.set(layout.label);
  }
);
```

两种 processor context 都包含 `sources`、按依赖位置对齐的 `changes` tuple、
`previous`、`reset`、`cause` 和持久 `state`。`changes[i]` 只对应第 `i` 个依赖：
标量依赖为 `undefined`，集合依赖则是 `reset`，或带完整 `before`/`after` 值的
`added`/`updated`/`removed` 分组，并可选提供 `order.before`/`order.after`。初次
build 对集合依赖报告 `reset`；一次已提交的 batch 已经合并成一个净 transition。
`sources` 内的集合值是 callback-local 的惰性 `ReadonlyMap` 视图，不能保存或直接
返回。`get`/`has` 保持按 key 读取，迭代才显式扫描整个集合。

`incremental.collection(...)` 使用独立的 collection processor 协议，另外提供借用的
`previous`/`next` keyed read，以及
只在同步 callback 内有效的 `output` draft。Draft 只有 `set`、`remove`、`order`；
Runtime 在 callback 返回后校验并 seal，计算 keyed transitions，发布
一个不可变 map-like 值。reset 或故障恢复由 Runtime 内部完成。
`incremental.group(...)` 是多个命名 value / keyed collection output 的组合边界。
`define.value<T>(equality?)` 声明 scalar leaf，`define.collection<K, V>(equality?)`
声明 keyed leaf。嵌套 namespace 只是静态 API 组织，不是新的 producer、Runtime、scheduler 或事件协议。
每个叶子都是指向同一个 processor producer 某个 output 的普通 `Projection`；一次 processor 执行先 seal 所有 leaf，再原子发布真正
变化的 leaf，下游直接依赖这些叶子。initial build / rebuild 必须 set 每个 value leaf；
普通增量轮次可以不触碰 value leaf，此时保留其现值和 revision。首次读取任一叶子只会
物化该 producer 一次；scope dispose 也只会释放该 producer 和其保留状态一次。

## React selector 追踪

```tsx
const task = useProjection(visible, tasks => tasks.get(taskId));
const [mode, setMode] = useInput(filter);
```

`get`/`has` 记录单 key，`keys` 记录 key/order 结构，`values` 或迭代记录整个
集合。无关 key 的更新不会执行 selector；相关更新后才执行 selector，并由
`equality`（默认 `Object.is`）决定 readable 是否发布。这是消费端优化，不会反向
构建 Projection processor 依赖。

Processor 先于 listener settle。通知期间禁止写入。listener 错误不会回滚已经
接受的文档 commit；processor 错误交给 Runtime error callback，并由 Runtime
内部恢复。
