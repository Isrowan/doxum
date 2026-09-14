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
and eventful external sources can also be observed at this boundary. External
sources use `kind: 'value'` or `kind: 'collection'`; the caller still uses only
`observe(source)`.

External events are smaller than Runtime contexts. A value event carries the new
`value` and `revision`; a collection event carries a stable `previous` read,
`revision`, and an optional keyed `change`. The Runtime derives `changed` and
transitions itself.

`derive(dependencies, compute, equality?)` takes a tuple. Dependencies are
explicit and fixed when the definition is created. Processors must not discover
graph dependencies by reading other projections.

The Runtime API is intentionally small:

```ts
runtime.get(projection);
const selected = runtime.readable(projection, value => value.get(id));
selected.subscribe(listener);
runtime.set(input, value);
runtime.batch({ cause }, run);
runtime.dispose();
```

The Runtime exposes no graph revision, item handle, rebuild or release operation;
only a `Readable`'s own publication revision is public for store integrations.
Runtime materialization, keyed storage, recovery and disposal are one owner.

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

Both processor contexts expose `sources`, a dependency-aligned `changes` tuple,
`previous`, `reset`, `cause` and a retained `state` object. `changes[i]` belongs
to dependency `i`: scalar dependencies are `undefined`, while collection
dependencies receive `reset` or grouped `added`/`updated`/`removed` entries with
complete `before`/`after` values and optional `order.before`/`order.after`.
The initial build reports `reset` for collection dependencies. A committed batch
is already coalesced into one net transition.

`incremental.collection(...)` uses a separate collection processor protocol and additionally exposes borrowed
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
`Object.is`) decides whether the readable publishes. React consumes the same
`Readable` boundary; projection dependencies remain explicit.

Processors settle before listeners. Writes are forbidden during notification.
Listener errors do not roll back an accepted document commit; processor errors use
the Runtime error callback and internal recovery.
