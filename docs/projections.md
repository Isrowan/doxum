# Projection API

Projection definitions are lazy and reusable. A definition contains no materialized
state; each `ProjectionRuntime` owns its own values, retained processor state,
subscriptions and disposal lifecycle.

## Basic API

The basic graph has three declaration functions:

```ts
import { createProjectionRuntime, derive, input, observe } from 'doxum';

const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');
const visible = derive([tasks, filter], (tasks, filter) => {
  if (filter === 'all') return tasks;
  return new Map([...tasks].filter(([, task]) => !task.done));
});
```

`input(initial, equality?)` declares a Runtime-local writable value. The same
definition can be materialized by multiple Runtimes without sharing its current
value.

`observe(document, pathSelector)` establishes a document boundary. A collection
path produces an immutable `ReadonlyMap`-like projection whose entry values are
snapshots. `observe(document)` produces a snapshot of the complete document.
`observe(readable)` bridges an existing Doxum `Readable`. Eventful external
sources use the same `observe(source)` entry point; their `kind` selects the
value or keyed-collection adapter and preserves collection transitions.

External sources are boundary contracts, not Runtime contexts:

```ts
type ExternalValueEvent<T, D> = {
  value: T;
  revision: number;
  reset?: boolean;
  detail?: D;
  cause?: unknown;
  batch?: { id: number; cause?: unknown };
};

type ExternalCollectionRead<K, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
};

type ExternalCollectionEvent<K, V, D> = {
  previous: ExternalCollectionRead<K, V>;
  revision: number;
  change?: CollectionImpact<K>;
  reset?: boolean;
  detail?: D;
  cause?: unknown;
  batch?: { id: number; cause?: unknown };
};
```

The Runtime computes `previous`, `changed` and keyed transitions for its own
contexts. Collection sources must provide a stable `previous` read in each event
so mutable external stores cannot make before/after comparison ambiguous.

`derive(dependencies, compute, equality?)` takes a tuple of explicit dependencies
and calls `compute` with their current values. Dependencies are captured when the
definition is created; processors do not discover graph dependencies by reading
other projections.

## Runtime lifecycle

```ts
const runtime = createProjectionRuntime({ onError: reportProjectionError });

const value = runtime.get(visible);
const selected = runtime.readable(visible, tasks => tasks.get(taskId));
const stop = selected.subscribe(() => {
  // Re-read with selected.current inside the listener.
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

The public Runtime deliberately has only five operations:

| Operation                                    | Meaning                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `get(projection)`                            | Read the last published value.                                           |
| `readable(projection, selector?, equality?)` | Create a live readable snapshot; subscribe through `Readable.subscribe`. |
| `set(input, value)`                          | Write a Runtime-local input.                                             |
| `batch(options?, run)`                       | Settle a complete application action once.                               |
| `dispose()`                                  | Release all graph nodes and source attachments.                          |

Graph revision numbers, rebuild controls, per-item handles and release operations
are internal publication facts. A `Readable` exposes only its own publication
revision for store integrations. An opaque `cause` may travel with a batch, while
the Runtime's batch identity remains private.

## Collection values

Collection projections expose only immutable map-like reads:

```ts
const rows = runtime.get(tasks);
rows.get(taskId);
rows.has(taskId);
rows.size;
for (const [id, task] of rows) {
  // task is an immutable snapshot
}
```

Unchanged entry values keep their references. This is what makes a keyed selector
or a memoized derived value useful without requiring deep equality everywhere.

## Advanced incremental processors

The advanced entry point is intentionally separate from the basic package surface:

```ts
import { incremental } from 'doxum/advanced';

const total = incremental([tasks], ({ sources, previous, state }) => {
  state.calls = Number(state.calls ?? 0) + 1;
  return sources[0].size + Number(state.calls) + (previous ?? 0);
});

const doubled = incremental.collection([tasks], ({ sources, output }) => {
  for (const [id, task] of sources[0]) output.set(id, task.value * 2);
});
```

Both incremental processors receive `sources`, a dependency-aligned `changes`
tuple, `previous` (for values), `reset`, `cause` and a retained `state` object.
An incremental collection processor also receives `previous`, `next` and a
callback-local `output` draft. `changes[i]` describes only dependency `i`; scalar
dependencies are `undefined`, while collection dependencies use this exact shape:

```ts
type CollectionChange<K extends string, V> =
  | { kind: 'reset' }
  | {
      kind: 'incremental';
      added: readonly { kind: 'added'; key: K; after: V }[];
      updated: readonly { kind: 'updated'; key: K; before: V; after: V }[];
      removed: readonly { kind: 'removed'; key: K; before: V }[];
      order?: { before: readonly K[]; after: readonly K[] };
    };
```

The initial build reports `reset` for collection dependencies. A committed
document batch is already coalesced into one net transition, so `before` and
`after` are the values at the batch boundaries.

The two processor protocols intentionally live under one advanced namespace:
`incremental(...)` returns a whole value, while `incremental.collection(...)`
publishes keyed changes and stable entry references. They are not one union
callback because their update ownership is different.

```ts
type CollectionDraft<K, V> = {
  set(key: K, value: V): void;
  remove(key: K): void;
  order(keys: readonly K[]): void;
  replace(entries: readonly (readonly [K, V])[]): void;
};
```

The draft is borrowed for the synchronous callback and cannot escape. Runtime
publication validates key coverage and order, computes added/removed/updated and
order transitions, then publishes one immutable collection. A reset or processor
fault causes internal reinitialization; application code never calls `rebuild`.

Use the basic `derive` form unless a retained state, reverse index, cross-key
coordination or keyed patch is materially cheaper with an incremental processor.

## React

```tsx
import { ProjectionProvider, useInput, useProjection } from 'doxum/react';

function TaskList() {
  const tasks = useProjection(visible);
  const task = useProjection(visible, tasks => tasks.get(taskId));
  const [mode, setMode] = useInput(filter);
  // ...
}
```

`ProjectionProvider` supplies a Runtime. `useProjection(projection)` consumes
`runtime.readable(projection)`. The selector overload consumes the same
runtime-owned readable boundary:

| Selector read                   | Dependency recorded | Unrelated update                   |
| ------------------------------- | ------------------- | ---------------------------------- |
| `rows.get(id)` / `rows.has(id)` | one key             | selector does not execute          |
| `rows.keys()`                   | key/order structure | value-only update does not execute |
| `rows.values()` / iteration     | whole collection    | any changed member executes        |
| scalar projection               | scalar projection   | no selector dependency set         |

After a related invalidation, the selector runs synchronously and `equality`
(default `Object.is`) decides whether the readable publishes a new snapshot and
React re-renders. Selector tracking is a consumer optimization only; processor
dependencies remain explicit.

Selectors must be pure and synchronous. They may not retain borrowed readers or
drafts in asynchronous callbacks.

## Error and batching rules

Processors settle before external listeners. Writes are forbidden while processor
or listener notification is in progress. A processor fault is reported through the
Runtime error callback and recovery is internal. Listener failures do not roll back
an already accepted document commit. Inside a Runtime batch, projection readers see
the last published value until the batch settles.
