# Projection Reference

Root projection definitions are lazy and reusable; scoped definitions are lazy
and bound to one scope. The public core consists of
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

Schema maps, tables, and `list(field, { keyOf })` nodes are all keyed collection
paths. A list uses its schema `keyOf` identity and preserves document order in
iteration; array-valued fields remain scalar value observations.

External events are smaller than Runtime contexts. A value event carries the new
`value` and `revision`; a collection event carries a stable `previous` read,
`revision`, and an optional `impact` hint. The Runtime derives the exact
`CollectionChange`; processors never receive the impact directly.

`derive(dependencies, compute, equality?)` takes a tuple. Dependencies are
explicit and fixed when the definition is created. Processors must not discover
graph dependencies by reading other projections.

The Runtime API is intentionally small:

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

`input.collection<K, V>(initial?)` declares keyed Runtime-local state. Its
`update` draft has `get`, `has`, `set`, and `remove`; edits are synchronous and
atomic per callback, and a Runtime batch publishes one exact net
`CollectionChange`. A scope declares local inputs, derives, and incremental
processors through `scope.input`, `scope.derive`, and `scope.incremental`. They
depend directly on root projections in the same graph. Disposing the scope
releases local state and subscriptions without disposing its root dependencies.

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

const render = incremental.group(
  [tasks],
  define => ({
    node: {
      shell: define.collection<string, Shell>(),
      content: define.collection<string, Content>(),
    },
    labels: define.collection<string, Label>(),
    chrome: define.value<Chrome>(),
    revision: define.value<number>(),
  }),
  ({ sources, outputs }) => {
    for (const [id, task] of sources[0]) {
      outputs.node.shell.set(id, makeShell(task));
      outputs.node.content.set(id, makeContent(task));
      outputs.labels.set(id, makeLabel(task));
    }
    outputs.chrome.set(makeChrome(sources[0]));
    outputs.revision.set(sources[0].size);
  }
);
```

Both processor contexts expose `sources`, a dependency-aligned `changes` tuple,
`previous`, `reset`, `cause` and a retained `state` object. `changes[i]` belongs
to dependency `i`: scalar dependencies are `undefined`, while collection
dependencies receive `reset` or grouped `added`/`updated`/`removed` entries with
complete `before`/`after` values and optional `order.before`/`order.after`.
The initial build reports `reset` for collection dependencies. A committed batch
is already coalesced into one net transition.
Collection values inside `sources` are callback-local lazy `ReadonlyMap` views;
do not retain or return them. Keyed `get`/`has` avoids a scan, while iteration is
an explicit full-collection read.

`incremental.collection(...)` uses a separate collection processor protocol and additionally exposes borrowed
`previous`/`next` keyed reads and a callback-local `output` draft. Draft methods are
`set`, `remove`, and `order`; the Runtime validates and seals them after
the synchronous callback, computes keyed transitions and publishes one immutable
map-like value. Reset or fault recovery is internal.
`incremental.group(...)` is the composition boundary for several named value and
keyed collection outputs. `define.value<T>(equality?)` creates a scalar leaf and
`define.collection<K, V>(equality?)` creates a keyed leaf. Its nested namespace is
static API organization, not another graph or runtime concept. Every leaf is an
ordinary `Projection`; one processor execution seals and publishes all changed
leaves atomically, and downstream processors depend on those leaves directly.
Initial builds and rebuilds must set every value leaf; ordinary incremental runs
may leave a value leaf untouched to preserve its current value and revision.
Reading any leaf materializes the whole group, while scope disposal releases the
group and its retained state together.

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
