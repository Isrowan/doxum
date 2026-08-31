# Doxum Runtime Guide

This is the task-oriented public guide for Doxum. It describes how to model,
read, mutate, observe, and project one in-memory document with `doxum`, persist
one browser-origin document with `doxum/local-sync`, and bind read models with
`doxum/react`.

The `doxum` core entry owns typed document state, atomic mutation, history,
impact, subscriptions, and derived views. `doxum/local-sync` is the optional
browser adapter for IndexedDB-backed offline editing and same-origin cross-tab
sync. Your application still owns network ordering, authorization, and conflict
resolution.

## Choose the right entry point

| Goal                                  | Use                                                      |
| ------------------------------------- | -------------------------------------------------------- |
| Define document shape                 | `schema`, `field`, `object`, and collection constructors |
| Create the canonical runtime          | `createDocument`                                         |
| Persist and sync one browser document | `attachLocalSync` from `doxum/local-sync`                |
| Read once                             | `select(runtime, read => ...)`                           |
| Make local business changes           | `runtime.update(tx => ...)`                              |
| Replay persisted or remote operations | `runtime.apply(operations, options)`                     |
| Replace an entire trusted snapshot    | `runtime.replace(document, options)`                     |
| Observe one schema location           | `schema.value` plus `runtime.subscribe`                  |
| Observe a table or map                | `schema.collection` plus `runtime.subscribe`             |
| Maintain mapped collection data       | `createCollectionView`                                   |
| Maintain an aggregate or index        | `createMaterializedView`                                 |
| Read in React                         | `useDocumentSelector`, `useReadable`, or `useReadable`   |

Do not write a second mutable copy of the document. `createDocument` is the
only owner of canonical state.

## Start with a schema

A schema is both the TypeScript shape of the document and the authoritative
address model for writers, operations, selectors, and subscriptions. Define it
once and keep it close to the domain it describes.

```ts
import { createDocument, field, object, schema, table } from 'doxum';

const task = object({
  title: field<string>(),
  completed: field<boolean>(),
});

const taskSchema = schema({
  title: field<string>(),
  tasks: table(task),
});

const runtime = createDocument({
  schema: taskSchema,
  initial: {
    title: 'Launch Doxum',
    tasks: {
      ids: ['write-guide'],
      byId: {
        'write-guide': { title: 'Write the guide', completed: false },
      },
    },
  },
});
```

`table` preserves application-visible order through `{ ids, byId }`. `map`
stores id-indexed entities without order. Use `single` for one structured
entity, `dict` or `record` for scalar key/value data, `list` for an ordered
sequence with an application-supplied stable key, and `tree` for a validated
single-root hierarchy. See [patterns.en.md](patterns.en.md) for modelling
guidance.

## Read through readers

The runtime does not expose its mutable document. Read through a callback:

```ts
import { select } from 'doxum';

const openTitles = select(runtime, read =>
  read.tasks.ids().flatMap(id => {
    const task = read.tasks.get(id);
    return task && !task.completed.get() ? [task.title.get()] : [];
  })
);
```

Readers are intentionally shaped by the schema:

- A field has `get()`.
- A table or map has `ids()`, `has(id)`, and `get(id)`.
- A list has `values()`, `length()`, and `at(index)`.
- A tree has `rootId()`, `has(id)`, `value(id)`, `parent(id)`, and
  `children(id)`.

Reader values for structural data are snapshots. Do not retain a transaction
reader after `runtime.update` returns; it is only valid during that callback.

## Mutate atomically

Use `runtime.update` for local, typed domain behavior. Its callback receives a
short-lived `tx.read` and `tx.write`. Writers create operations for one atomic
session; they never expose direct canonical mutation.

```ts
const result = runtime.update(tx => {
  const task = tx.read.tasks.get('write-guide');
  if (!task) {
    tx.reject({
      source: 'application',
      code: 'task-not-found',
      message: 'The requested task no longer exists.',
      address: ['tasks', 'write-guide'],
    });
  }

  tx.write.tasks.item('write-guide').completed.set(true);
  return task.title.get();
});

if (result.status === 'committed') {
  console.log(result.value, result.commit.revision);
} else if (result.status === 'rejected') {
  console.error(result.issues);
}
```

An update is synchronous and atomic:

- If a writer emits a semantically invalid operation, Doxum rolls back the
  entire session and returns `status: 'rejected'` with `MutationIssue` values.
- `tx.reject(...)` rolls back and returns your application
  `DocumentDiagnostic` values.
- A normal thrown error also rolls back, then is rethrown to the caller.
- Net-zero work returns `status: 'unchanged'` and publishes no commit.

Use `tx.report(...)` for non-blocking application diagnostics. Committed and
unchanged transaction results expose them as `reports`; reports and diagnostic
addresses are copied and frozen before they are published.

## Use writers instead of constructing local operations

For normal application behavior, writer APIs are clearer and preserve the
schema domain:

```ts
runtime.update(tx => {
  tx.write.title.set('Ship Doxum');
  tx.write.tasks.create(
    { id: 'release', value: { title: 'Publish the package', completed: false } },
    { after: 'write-guide' }
  );
  tx.write.tasks.item('release').title.set('Publish doxum');
  tx.write.tasks.move('release', { at: 'start' });
  tx.write.tasks.remove('write-guide');
});
```

For a table, `create`, `item`, `remove`, and `move` are available. A map has
the same API except `move`, because it is unordered. Lists offer `insert`,
`move`, `remove`, and `replace`; list identity comes from the `keyOf` function
specified in the schema. See [patterns.en.md](patterns.en.md) for complete
collection and tree examples.

Optional field, variant, dict, list, and tree writers expose `clear()`. Optional
structured leaves can also be initialized from an absent state with `replace()`.
Optional objects, tables, and maps have no whole-value clear; modify them through
their child writers or collection operations.

## Replay operations at the boundary

Use `apply` for operation batches that came from persistence, a network
adapter, or another external boundary. Doxum decodes unknown operation payloads
before mutation code observes them, resolves every address against the schema,
and applies the batch atomically.

```ts
const result = runtime.apply([{ type: 'field.set', at: ['title'], value: 'Restored title' }], {
  source: 'remote',
  history: false,
});

if (result.status === 'rejected') {
  // The document and revision remain unchanged.
  console.error(result.issues);
}
```

Treat external operation input as untrusted, even if TypeScript types make it
look valid. Do not write a second path parser or validate operations by
partially replaying them outside Doxum. A remote commit and every `replace`
establish a new baseline, so they invalidate local undo/redo history.

## Interpret results and history

Every mutation entry point returns one of three states:

| Status      | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `committed` | Canonical state changed; the result contains a commit.   |
| `unchanged` | The net state did not change; the revision is unchanged. |
| `rejected`  | The whole batch rolled back; inspect `issues`.           |

Committed operations carry forward operations, inverse operations, a revision,
and a `DocumentImpact`. Local history records local and system commits by
default. Use `runtime.history.undo()` and `runtime.history.redo()`; they replay
the inverse or forward operation batch through the same mutation pipeline.

`observerErrors` on a committed result are failures from processors, flushes,
or listeners after canonical state and history settled. They are not mutation
failures and must not cause the caller to repeat the write.

## Attach local browser sync

`attachLocalSync` is an optional browser attachment. Create and keep the
runtime yourself, then await attachment before allowing the document to be used.
It hydrates that runtime from an IndexedDB checkpoint and append-only command
tail, then uses a Web Lock to choose exactly one writable tab. The `leader`
uses normal synchronous runtime writes; every other attached tab is a
`follower` read-only mirror. A direct follower write through `update`,
`prepare`, `apply`, or `replace` throws `LocalSyncReadOnlyError`.

The leader's local, system, and history commits are observed after they have
settled and persisted to IndexedDB in order. BroadcastChannel carries only a
new-head hint. Followers reload the durable tail and apply it as `remote`; this
keeps their document ordered and invalidates their in-memory history. When the
leader disposes, a caught-up follower takes the lock and becomes leader.

Local-sync persists operation commands, not arbitrary new baselines. While it
is attached, `runtime.replace()` and an externally supplied
`runtime.apply(..., { source: 'remote' })` throw
`LocalSyncUnsupportedOperationError`; internal hydration and tail replay use a
trusted attachment path instead.

```ts
import { attachLocalSync } from 'doxum/local-sync';

const runtime = createDocument({ schema: taskSchema, initial });
const localSync = await attachLocalSync({
  runtime,
  database: 'my-app',
  documentId: 'project-1',
});

if (localSync.state().status === 'leader') {
  runtime.update(tx => tx.write.title.set('Ship Doxum'));
  runtime.history.undo();
}

await localSync.flush(); // persist observed leader commands or catch up a follower
await localSync.dispose();
```

This is synchronous visibility with asynchronous persistence, not strict
durability: a crash, storage failure, or invalid JSON payload can leave a
visible leader commit unpersisted. Use `localSync.state()` and `onError` to show
that condition. `flush()` is the explicit persistence/catch-up boundary. The
attachment does not own or dispose the runtime and it does not expose an undo
API: use `runtime.history.undo()` and `runtime.history.redo()` while the tab is
leader. Runtime history is intentionally in-memory only; attachment hydration
and remote tail replay invalidate it, so it is not transferred across reopening
or leader handoff.

## Subscribe through schema-owned targets

Create stable selectors from the schema, then subscribe to them. This is the
shared address and impact model for the whole runtime.

```ts
const title = taskSchema.value(path => path.title);
const tasks = taskSchema.collection(path => path.tasks);

const stopTitle = runtime.subscribe(title, commit => {
  console.log('title changed at revision', commit.revision);
});

const stopTasks = runtime.subscribe(tasks, commit => {
  const change = commit.impact.collection(tasks);
  if (change.kind === 'incremental') {
    console.log(change.added, change.removed, change.updated, change.orderChanged);
  }
});

stopTitle();
stopTasks();
```

For value selectors, use `commit.impact.affects(target)`. For table or map
selectors, use `commit.impact.collection(selector)`, which returns either a
precise incremental change or `reset` after replacement. Do not recreate path
comparison helpers in application modules.

## Build derived read models

`createCollectionView` maps one table or map into stable ids, cached `item(id)`
readables, and a lazy `all` array. It updates only affected entries where possible.

```ts
import { createCollectionView } from 'doxum';

const taskTitles = createCollectionView({
  runtime,
  source: taskSchema.collection(path => path.tasks),
  map: (_id, task) => task.title.get(),
});

taskTitles.item('write-guide').current();
taskTitles.all.current();
```

Use `createMaterializedView` for an index or aggregate with custom incremental
logic. A materialized view is derived state, not a caller-maintained cache. It
may depend only on materialized views created earlier from the same runtime.
Dispose every view when its owning feature is disposed.

## React integration

`doxum/react` uses `useSyncExternalStore` and tracked Doxum dependencies. A
component re-renders only for commits that can affect the selector it read.

```tsx
import { useDocumentSelector } from 'doxum/react';

function OpenTaskCount() {
  const count = useDocumentSelector(
    runtime,
    read => read.tasks.ids().filter(id => !read.tasks.get(id)?.completed.get()).length
  );

  return <output>{count}</output>;
}
```

Use `useReadable(view.all)` for a `Readable`, `useReadable(view.item(id))`
for one keyed value, and `useHistory(runtime.history)` for undo/redo state and
actions. Keep `core` free of React imports; React-specific code belongs in the
adapter or application layer.

## Lifecycle and ownership

- The initial document is cloned when `createDocument` starts.
- Structural payloads passed through operations are transferred into canonical
  state. Do not mutate them afterwards unless you intentionally want to mutate
  the canonical document.
- Published commits, history payloads, diagnostics, and selector addresses are
  immutable snapshots.
- Tree replacement snapshots are validated and cloned to preserve structural
  integrity.
- Call `runtime.dispose()` when the runtime is no longer usable. Existing
  subscriptions, history state, and views should be disposed with their owners.

For decision rules and anti-patterns, read
[invariants.en.md](invariants.en.md). For copyable implementation patterns,
read [patterns.en.md](patterns.en.md).
