# Projection 参考

根 Projection 定义惰性且可跨 Runtime 复用；scope 定义惰性但只属于其局部生命周期。默认入口包含 `Projection<T>`、
`ProjectionRuntime`、`input`、`observe` 和 tuple 形式的 `derive`。

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

External event 不再复用 Runtime context：value event 提供新 `value` 和
`revision`；collection event 提供稳定的 `previous` read、`revision` 和可选的
`impact` hint。Runtime 自己计算精确的 `CollectionChange`，processor 不会直接收到
impact。

`derive(dependencies, compute, equality?)` 使用 tuple，依赖在定义创建时固定。
Processor 不能通过读取另一个 Projection 隐式建立图依赖。

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
`scope.incremental` 声明局部投影，直接依赖同一张图中的根投影；dispose 只释放局部状态和订阅。

Runtime graph revision、item handle、rebuild、release 都是内部事实，不是应用层操作；
只有 `Readable` 自己的 publication revision 为 store 集成保留为公开事实。
Materialization、keyed storage、故障恢复和释放只有一个 owner。

## 增量 Processor

保留状态和 keyed patch 从 `doxum/advanced` 引入：

```ts
const total = incremental([tasks], ({ sources, previous, state }) => {
  state.calls = Number(state.calls ?? 0) + 1;
  return sources[0].size + Number(state.calls) + (previous ?? 0);
});

const doubled = incremental.collection([tasks], ({ sources, output }) => {
  for (const [id, task] of sources[0]) output.set(id, task.value * 2);
});

const render = incremental.group(
  [tasks],
  define => ({
    node: {
      shell: define.collection<string, Shell>(),
      content: define.collection<string, Content>(),
    },
    labels: define.collection<string, Label>(),
  }),
  ({ sources, outputs }) => {
    for (const [id, task] of sources[0]) {
      outputs.node.shell.set(id, makeShell(task));
      outputs.node.content.set(id, makeContent(task));
      outputs.labels.set(id, makeLabel(task));
    }
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
`incremental.group(...)` 是多个命名 keyed output 的组合边界。嵌套 namespace
只是静态 API 组织，不是新的图、Runtime 或事件协议。每个叶子都是普通
`Projection`；一次 processor 执行会把所有变化的叶子原子发布，下游直接依赖这些
叶子。首次读取任一叶子会物化整个 group；scope dispose 会一起释放 group 和其保留状态。

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
