# Projection Reference

Projection definitions are lazy and reusable. The public core consists of
`Projection<T>`, `ProjectionRuntime`, `input`, `observe`, and tuple `derive`.

```ts
const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');
const visible = derive([tasks, filter], (tasks, filter) =>
  filter === 'all' ? tasks : new Map([...tasks].filter(([, task]) => !task.done))
);
const runtime = createProjectionRuntime({ onError: report });
runtime.get(visible);
```

`input(initial, equality?)` is Runtime-local and can be written only with
`runtime.set(input, value)`. `observe(document, selector)` compiles a document
boundary lazily. Collection paths publish immutable map-like snapshots; the
whole-document form publishes a snapshot of the root. Existing Doxum Readables
can also be observed at this boundary.

`derive(dependencies, compute, equality?)` takes a tuple. Dependencies are
explicit and fixed when the definition is created. Processors must not discover
graph dependencies by reading other projections.

The Runtime API is intentionally small:

```ts
runtime.get(projection);
runtime.subscribe(projection, listener);
runtime.set(input, value);
runtime.batch({ cause }, run);
runtime.dispose();
```

There is no public revision, item handle, rebuild or release operation. Runtime
materialization, keyed storage, recovery and disposal are one owner.

## Incremental processors

Import retained-state processors from `doxum/advanced`:

```ts
const total = incremental([tasks], ({ sources, previous, state }) => {
  state.calls = Number(state.calls ?? 0) + 1;
  return sources[0].size + Number(state.calls) + (previous ?? 0);
});

const doubled = incremental.collection([tasks], ({ sources, output }) => {
  for (const [id, task] of sources[0]) output.set(id, task.value * 2);
});
```

Value contexts expose `sources`, `previous`, `reset`, `change`, `cause` and a
retained `state` object. `incremental.collection(...)` uses a separate
collection processor protocol and additionally exposes borrowed
`previous`/`next` keyed reads and a callback-local `output` draft. Draft methods are
`set`, `remove`, `order`, and `replace`; the Runtime validates and seals them after
the synchronous callback, computes keyed transitions and publishes one immutable
map-like value. Reset or fault recovery is internal.

## React selector tracking

```tsx
const task = useProjection(visible, tasks => tasks.get(taskId));
const [mode, setMode] = useInput(filter);
```

Collection `get`/`has` records one key, `keys` records key/order structure, and
`values`/iteration records the whole collection. Unrelated key changes do not run
the selector. After a related update, the selector's equality (default
`Object.is`) decides whether React re-renders. This tracking exists only at the
consumer boundary; projection dependencies remain explicit.

Processors settle before listeners. Writes are forbidden during notification.
Listener errors do not roll back an accepted document commit; processor errors use
the Runtime error callback and internal recovery.
