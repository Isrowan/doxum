# Projection Reference

For the concise callable surface, including `input.collection`, Runtime/Scope methods,
external source contracts, every `incremental.*` form and `define.value/collection`,
see the [API reference](api.en.md). This document explains behavior and ownership.

Root projection definitions are lazy and reusable; scoped definitions are lazy
and bound to one scope. The public core consists of
`Projection<T>`, `ProjectionRuntime`, `input`, `observe`, tuple `derive`, and
key-preserving `derive.keyed`.

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
Tree structure reuses the same source kinds: `path.tree.rootId` is a scalar,
`path.tree.nodes` is a keyed collection, and `path.tree.nodes.item(id)` is a
single-node value. Committed tree-node groups route directly to affected keyed
entries, and the existing `CollectionOutput` publishes ordinary `CollectionChange`
entries, so unrelated node snapshots keep their identity.

External events are smaller than Runtime contexts. A value event carries the new
`value` and `revision`; a collection event carries a stable `previous` read,
`revision`, and an optional `impact` hint. The Runtime derives the exact
`CollectionChange`; processors never receive the impact directly.

`derive(dependencies, compute, equality?)` takes a tuple. Dependencies are
explicit and fixed when the definition is created. Processors must not discover
graph dependencies by reading other projections.

Use `derive.keyed` when one keyed collection determines the output membership and
order:

```ts
const labels = derive.keyed(entries, entry => entry.label);
```

Only added or updated driver entries run the selector; removals delete the same
output key and order changes preserve driver order without reevaluating unchanged
entries. The collection output applies per-entry equality, so an updated source
entry whose selected value is equal produces no output `updated` transition.
Initial materialization, source reset and fault recovery rebuild through the normal
ProjectionRuntime processor lifecycle.

Dynamic keyed lookups use the same derivation instead of an application-owned join
protocol:

```ts
const resolved = derive.keyed(
  links,
  {
    entity: { source: entities, key: link => link.entityId },
    mode,
  },
  (link, { entity, mode }) => projectLink(link, entity, mode)
);
```

The dependency form is named and calls the selector as `(entry, dependencies, key)`.
Plain Projection members invalidate the full driver key set; `{ source, key }` members
bind each output key to a dynamic source key. The no-dependency shorthand stays
`derive.keyed(source, (entry, key) => value, equality?)`.

The source projection remains a static producer dependency; only the selected
source key varies per output key. The materialized processor owns the forward and
reverse key bindings. Updating one source entry recomputes only the output keys
currently bound to it. A missing source entry keeps its binding so a later add of
that key also recomputes its dependents. Ordinary projection dependencies such as
`mode` invalidate the full driver key set. Do not add processor-side
`runtime.get()` tracking, wildcard document path grammars, or a separate join
runtime for this case.

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
processors through `scope.input`, `scope.derive` (including `scope.derive.keyed`),
and `scope.incremental`. They
depend directly on root projections in the same Runtime. Disposing the scope
releases local producers, state and subscriptions without disposing its root
dependencies.

The Runtime exposes no scheduler/output internals, item handle, rebuild or release operation;
only a `Readable`'s own publication revision is public for store integrations.
Runtime materialization, keyed storage, recovery and disposal are one owner.

## Incremental processors

Use `derive.keyed` for key-preserving selection and declared dynamic keyed
dependencies. Import retained-state processors from `doxum/advanced` when the
algorithm needs application-specific retained state, cross-key indexes, or output
patches that this dependency model cannot express:

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
static API organization, not another producer, runtime or scheduler concept. Every
leaf is an ordinary `Projection` pointing to one output of the same processor
producer; one processor execution seals and publishes all changed leaves atomically,
and downstream processors depend on those leaves directly.
Initial builds and rebuilds must set every value leaf; ordinary incremental runs
may leave a value leaf untouched to preserve its current value and revision.
Reading any leaf materializes that producer once, while scope disposal releases the
producer and its retained state once.

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
