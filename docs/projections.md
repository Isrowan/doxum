# Projection API

Projection 的最终内部分层、算法 owner 和删除清单见根目录的
[Projection Layering Refactor Plan](../PROJECTION_LAYERING_REFACTOR_PLAN.md)。

Projection definitions are lazy. Root declarations are reusable across Runtimes;
scope declarations belong to one local lifetime. A `Projection` contains no
materialized value, retained processor state, subscription or disposal state.
Each `ProjectionRuntime` owns those facts for its own materialization.

## Basic declarations

```ts
import { createProjectionRuntime, derive, input, observe } from 'doxum';

const filter = input<'all' | 'open'>('all');
const tasks = observe(document, path => path.tasks);
const visibleTasks = derive([tasks, filter], (tasks, filter) => filterTasks(tasks, filter));
```

There are three declaration functions:

- `input(initial, equality?)` declares a Runtime-local writable value.
- `observe(...)` establishes a document, Doxum `Readable`, or external source boundary.
- `derive(dependencies, compute, equality?)` declares a pure projection with explicit dependencies.

The same root definition can be materialized by multiple runtimes without
sharing its current value, retained state, subscriptions or errors. A scoped
definition cannot be materialized by another Runtime or scope.

`observe` is the only source declaration entry point. A document selector that
resolves to a collection produces an immutable `ReadonlyMap` projection;
ordinary document selectors produce snapshots. External sources are selected by
their required `kind: 'value' | 'collection'` discriminant.

Schema `map`, `table`, and `list(field, { keyOf })` nodes are collection paths.
A list projection uses the schema `keyOf` result as its stable string key and
preserves document list order in `ReadonlyMap` iteration. It never uses the array
index as identity. An ordinary array-valued `field(...)` remains a scalar value.

Trees expose their structural facts through the same value/collection protocols:

```ts
const root = observe(document, path => path.outline.rootId);
const nodes = observe(document, path => path.outline.nodes);
const node = observe(document, path => path.outline.nodes.item(nodeId));
```

`rootId` publishes only when the root changes. `nodes` is a keyed
`ReadonlyMap<string, DocumentTreeNode<T>>`; committed tree-node groups route directly
to the affected keyed entries and the existing `CollectionOutput` publishes the
ordinary `CollectionChange`. A payload or topology edit of one node does not
resnapshot unrelated nodes. Root and node sources captured from the same document
commit settle in the same Runtime causal batch, so downstream processors never
observe a new root with old nodes or vice versa.

```ts
const order = observe(document, path => path.order);
const item = runtime.readable(order, items => items.get(itemId));
```

List insert/remove/replace/move operations therefore publish the same
`CollectionChange` used by map and table sources. `order.before/order.after` is
present only when keys that exist on both sides change relative order; membership
changes are already represented by `added` and `removed`.

## External source contracts

External source types are boundary contracts. They do not become Runtime
contexts and their events are translated by the source adapter.

```ts
type ExternalValueEvent<T> = {
  value: T;
  revision: number;
  reset?: boolean;
  cause?: unknown;
};

type ExternalCollectionRead<K, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
};

type ExternalCollectionEvent<K, V> = {
  /** Stable read before this event or external batch. */
  previous: ExternalCollectionRead<K, V>;
  revision: number;
  /** Optional invalidation hint; the Runtime derives the exact transition. */
  impact?: CollectionImpact<K>;
  cause?: unknown;
};
```

The collection adapter uses the stable previous read and current read to
produce the processor-facing `CollectionChange`. A boundary `impact` is only a
candidate optimization and never leaks into an incremental processor.

## Runtime lifecycle

```ts
const runtime = createProjectionRuntime({ onError: reportProjectionError });

const value = runtime.get(visibleTasks);
const selected = runtime.readable(visibleTasks, tasks => tasks.get(taskId));
const stop = selected.subscribe(() => {
  // Re-read from the published snapshot inside the listener.
  selected.current();
});

runtime.set(filter, 'open');
runtime.batch({ cause: { action: 'refresh' } }, () => {
  runtime.set(filter, 'all');
  document.update(draft => {
    draft.title = 'Updated';
  });
});

stop();
runtime.dispose();
```

The Runtime is the single owner of materialized producers, source boundaries,
scheduling and consumer readables. Its application-facing operations are:

| Operation                                    | Meaning                                                |
| -------------------------------------------- | ------------------------------------------------------ |
| `get(projection)`                            | Read the last published value.                         |
| `readable(projection, selector?, equality?)` | Create a live Runtime-owned readable boundary.         |
| `set(input, value)`                          | Write a Runtime-local input.                           |
| `update(collectionInput, edit)`              | Atomically edit keyed input entries.                   |
| `batch(options?, run)`                       | Settle one complete application action once.           |
| `scope()`                                    | Create a local producer lifetime in this Runtime.      |
| `dispose()`                                  | Release materialized producers and source attachments. |

Output revisions, rebuild controls, per-item handles, manual flush and release
operations are internal publication facts. A `Readable` exposes only its own
publication revision for external-store integrations.

### Local scope

```ts
const scope = runtime.scope();
const filter = scope.input<'all' | 'open'>('all');
const visible = scope.derive([tasks, filter], (tasks, mode) =>
  mode === 'all' ? tasks : filterTasks(tasks)
);
const index = scope.incremental.collection([tasks, filter], processor);
const row = scope.readable(visible, tasks => tasks.get(taskId));
scope.set(filter, 'open');
scope.dispose();
```

The scope provides the same `get`, `readable`, `set`, `update` and `batch`
operations, but uses its parent Runtime's scheduler and materialization cache.
Only definitions made through `scope.input`, `scope.derive`, and
`scope.incremental` belong to that scope. They may depend directly on root
definitions; sibling and root projections cannot depend on scoped definitions.
Disposal invalidates scoped handles, unsubscribes scope readables, and releases
only local materialized producers and processor state. It does not dispose their
root-owned dependencies. `ProjectionProvider` also accepts a scope as its value.

### Keyed input

```ts
const overrides = input.collection<string, Task>();
runtime.update(overrides, draft => {
  if (draft.has(taskId)) draft.remove(taskId);
  else draft.set(taskId, task);
});
```

The input owns an initially empty keyed collection (or a copied initial
`ReadonlyMap`). Its borrowed edit draft exposes `get`, `has`, `set`, and
`remove`; it expires when the synchronous callback returns. `set` preserves an
existing key's position and appends a new key. Runtime batches publish the net
added/updated/removed values and any observable reorder once. Unchanged keys
keep their references, and unrelated keyed selectors are not evaluated.
Outside a batch, each `update` publishes synchronously. A throwing edit callback
leaves that edit unapplied; a Runtime batch is not a rollback transaction for
earlier accepted edits. Readers inside a batch still see the last published
snapshot, while each edit draft reads the latest staged input state.

Inside a Runtime batch, projection readers see the last published value until
the batch settles. Document commits and document listeners are not delayed by a
Runtime batch. Processors settle before external listeners; writes are forbidden
while processing or notifying. Listener failures do not roll back an accepted
document commit.

## Collection values

Collection projections expose immutable map-like snapshots:

```ts
const rows = runtime.get(tasks);
rows.get(taskId);
rows.has(taskId);
rows.size;

for (const [id, task] of rows) {
  // task is an immutable snapshot
}
```

Unchanged entry values keep their references. That stable-reference rule is what
makes keyed selectors and memoized derived values useful without requiring deep
equality everywhere.

内部实现按职责分层：`output/collection.ts` 只维护 staged/published 生命周期；
持久 keyed lookup、`CollectionChange` 代数和 `CollectionRead`/`ReadonlyMap` view
分别由 `collection/index.ts`、`collection/change.ts`、`collection/view.ts` 拥有。
通用 source prepare/publish/fault 生命周期在 `source/boundary.ts`，document 的
订阅路由、dirty location 归并和读取在 `source/document.ts`；aggregate snapshot
的结构共享仍由纯 `source/materialization.ts` 算法完成。公开 API 不暴露这些
内部组件。

## The one collection transition protocol

Every collection source and collection output publishes the same exact net
transition shape:

```ts
type CollectionChange<K extends string, V> =
  | { kind: 'reset' }
  | {
      kind: 'incremental';
      added: readonly { key: K; after: V }[];
      updated: readonly { key: K; before: V; after: V }[];
      removed: readonly { key: K; before: V }[];
      order?: { before: readonly K[]; after: readonly K[] };
    };
```

The initial build reports `reset` for collection dependencies. A committed
document batch is coalesced before publication, so `before` and `after` are the
values at the batch boundaries. Entry arrays do not repeat a `kind` field; the
array name already identifies the transition category.

`CollectionImpact` remains a document-domain invalidation hint. It is not a
projection change and is never passed to an application processor.

## Advanced incremental processors

Use the isolated advanced entry point only when retained state, reverse indexes,
cross-key coordination or keyed patches are materially cheaper than ordinary
`derive` recomputation.

```ts
import { incremental } from 'doxum/advanced';

const total = incremental([tasks], ({ sources, previous, state }) => {
  state.calls = Number(state.calls ?? 0) + 1;
  return sources[0].size + Number(state.calls) + (previous ?? 0);
});

const doubled = incremental.collection([tasks], ({ sources, changes, output }) => {
  const change = changes[0];
  if (change?.kind === 'reset') {
    for (const [id, task] of sources[0]) output.set(id, task.value * 2);
    output.order([...sources[0].keys()]);
    return;
  }
  if (change?.kind !== 'incremental') return;
  for (const entry of change.added) output.set(entry.key, entry.after.value * 2);
  for (const entry of change.updated) output.set(entry.key, entry.after.value * 2);
  for (const entry of change.removed) output.remove(entry.key);
  if (change.order) output.order([...sources[0].keys()]);
});
```

When several outputs share one processor, declare them as one static group. The
processor executes once per causal batch; value and keyed collection leaves publish
atomically, while every leaf remains an ordinary `Projection`:

```ts
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

const shell = incremental.collection([render.node.shell], ({ sources, output }) => {
  for (const [id, value] of sources[0]) output.set(id, value);
});
```

The namespace is a frozen static object tree, not a projection, producer,
runtime, scheduler, transaction, or event bus. Only output leaves can be read,
composed, or subscribed. Every leaf points to one shared processor producer, so
reading any leaf materializes that producer once and every output observes the
same generation. Split groups when outputs do not share computation or atomicity
requirements. Group outputs can also be declared through
`scope.incremental.group`; scope disposal releases that producer and its retained
state once.

`define.value<T>(equality?)` has one borrowed draft operation: `set(value)`.
During the initial build and every rebuild each value leaf must be set exactly as
part of that processor run; on an ordinary incremental update an untouched value
leaf retains its published value and revision. Calling `set` with an equal value
also leaves the leaf unpublished. `T | undefined` is the explicit way to model an
optional value; `set(undefined)` is distinct from not touching the leaf. Group
`previous` and `next` expose scalar values alongside collection reads, and `next`
reflects a staged `set` immediately inside the processor callback.

Both processors receive `sources`, dependency-aligned `changes`, `previous`,
`reset`, `cause` and a Runtime-local retained `state` object. Collection
processors additionally receive `next` and a borrowed `output` draft. Collection
values inside `sources` are callback-local lazy `ReadonlyMap` views: `get` and
`has` stay keyed, while iteration intentionally reads the full collection. Do not
retain or return those borrowed source views.

```ts
type CollectionDraft<K, V> = {
  set(key: K, value: V): void;
  remove(key: K): void;
  order(keys: readonly K[]): void;
};
```

The draft is valid only during the synchronous processor callback. It cannot be
retained or used asynchronously. A value processor returns `T` or
`{ kind: 'rebuild' }`; a collection processor returns nothing or the same
`rebuild` marker. Rebuild is an internal reinitialization request, not a public
Runtime operation. There is no draft-wide replacement method or tagged value
result protocol.

## React

```tsx
import { ProjectionProvider, useInput, useProjection } from 'doxum/react';

<ProjectionProvider value={runtime}>
  <TaskList />
</ProjectionProvider>;

function TaskList() {
  const tasks = useProjection(visibleTasks);
  const task = useProjection(visibleTasks, tasks => tasks.get(taskId));
  const [mode, setMode] = useInput(filter);
  // ...
}
```

React obtains the Runtime only from `ProjectionProvider`. Hooks do not accept a
positional Runtime argument; multiple runtimes use nested providers.

Selector reads are tracked at the consumer boundary:

| Selector read                   | Dependency recorded | Unrelated update                   |
| ------------------------------- | ------------------- | ---------------------------------- |
| `rows.get(id)` / `rows.has(id)` | one key             | selector does not execute          |
| `rows.keys()`                   | key/order structure | value-only update does not execute |
| `rows.values()` / iteration     | whole collection    | any changed member executes        |
| scalar projection               | scalar projection   | no keyed dependency set            |

Only a related invalidation runs the selector. `equality` then decides whether
the selected result publishes a new snapshot; it is not a fallback for unrelated
selector execution. Selectors must be pure and synchronous.
