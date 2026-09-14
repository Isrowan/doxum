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
`observe(readable)` is the small adapter for an existing Doxum `Readable`.

`derive(dependencies, compute, equality?)` takes a tuple of explicit dependencies
and calls `compute` with their current values. Dependencies are captured when the
definition is created; processors do not discover graph dependencies by reading
other projections.

## Runtime lifecycle

```ts
const runtime = createProjectionRuntime({ onError: reportProjectionError });

const value = runtime.get(visible);
const stop = runtime.subscribe(visible, () => {
  // Re-read with runtime.get inside the listener.
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

| Operation                         | Meaning                                         |
| --------------------------------- | ----------------------------------------------- |
| `get(projection)`                 | Read the last published value.                  |
| `subscribe(projection, listener)` | Subscribe to invalidation; re-read with `get`.  |
| `set(input, value)`               | Write a Runtime-local input.                    |
| `batch(options?, run)`            | Settle a complete application action once.      |
| `dispose()`                       | Release all graph nodes and source attachments. |

Revision numbers, rebuild controls, per-item handles and release operations are
internal publication facts. An opaque `cause` may travel with a batch, while the
Runtime's batch identity remains private.

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

An incremental value processor receives `sources`, `previous`, `reset`, `change`,
`cause` and a retained `state` object. An incremental collection processor also
receives `previous`, `next` and a callback-local `output` draft:

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

`ProjectionProvider` supplies a Runtime. `useProjection(projection)` subscribes
to coarse invalidation. The selector overload records collection reads at the
React boundary:

| Selector read                   | Dependency recorded | Unrelated update                   |
| ------------------------------- | ------------------- | ---------------------------------- |
| `rows.get(id)` / `rows.has(id)` | one key             | selector does not execute          |
| `rows.keys()`                   | key/order structure | value-only update does not execute |
| `rows.values()` / iteration     | whole collection    | any changed member executes        |
| scalar projection               | scalar projection   | no selector dependency set         |

After a related invalidation, the selector runs synchronously and `equality`
(default `Object.is`) decides whether React re-renders. Selector tracking is a
consumer optimization only; processor dependencies remain explicit.

Selectors must be pure and synchronous. They may not retain borrowed readers or
drafts in asynchronous callbacks.

## Error and batching rules

Processors settle before external listeners. Writes are forbidden while processor
or listener notification is in progress. A processor fault is reported through the
Runtime error callback and recovery is internal. Listener failures do not roll back
an already accepted document commit. Inside a Runtime batch, projection readers see
the last published value until the batch settles.
