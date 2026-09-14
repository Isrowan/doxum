# Projection 参考

Projection 定义是惰性、可复用的。默认入口只保留 `Projection<T>`、
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
keyed `change`。`changed` 与 transitions 由 Runtime 自己计算。

`derive(dependencies, compute, equality?)` 使用 tuple，依赖在定义创建时固定。
Processor 不能通过读取另一个 Projection 隐式建立图依赖。

Runtime 的公开脊柱只有：

```ts
runtime.get(projection);
runtime.subscribe(projection, listener);
runtime.set(input, value);
runtime.batch({ cause }, run);
runtime.dispose();
```

revision、item handle、rebuild、release 都是 Runtime 内部事实，不是应用层操作。
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
```

Value context 包含 `sources`、`previous`、`reset`、`change`、`cause` 和持久
`state`。`incremental.collection(...)` 使用独立的 collection processor 协议，
另外提供借用的 `previous`/`next` keyed read，以及
只在同步 callback 内有效的 `output` draft。Draft 只有 `set`、`remove`、`order`、
`replace`；Runtime 在 callback 返回后校验并 seal，计算 keyed transitions，发布
一个不可变 map-like 值。reset 或故障恢复由 Runtime 内部完成。

## React selector 追踪

```tsx
const task = useProjection(visible, tasks => tasks.get(taskId));
const [mode, setMode] = useInput(filter);
```

`get`/`has` 记录单 key，`keys` 记录 key/order 结构，`values` 或迭代记录整个
集合。无关 key 的更新不会执行 selector；相关更新后才执行 selector，并由
`equality`（默认 `Object.is`）决定是否重渲染。这是消费端优化，不会反向构建
Projection processor 依赖。

Processor 先于 listener settle。通知期间禁止写入。listener 错误不会回滚已经
接受的文档 commit；processor 错误交给 Runtime error callback，并由 Runtime
内部恢复。
