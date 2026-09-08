# Doxum

Doxum is a typed TypeScript runtime for complex mutable documents. It is built
for editors and product surfaces that need structured state, atomic updates,
undo/redo, precise change notifications, and incremental derived data.

Licensed under the [MIT License](LICENSE).

The `doxum` core entry is a local in-memory runtime. The optional
`doxum/local-sync` browser attachment adds IndexedDB persistence and
same-origin cross-tab synchronization with one writable tab at a time; network
collaboration, authorization, and conflict resolution remain separate
application concerns.

## Packages

- `doxum` defines schemas, mutations, history, subscriptions, and views.
- `doxum/local-sync` lets one Web-Lock leader write a runtime synchronously,
  persists its commands asynchronously to IndexedDB, and makes other tabs
  ordered read-only mirrors.
- `doxum/react` binds Doxum read models to React 18+ with fine-grained external
  store subscriptions.

## Install

```sh
pnpm add doxum
```

For React bindings, install React alongside Doxum and import from `doxum/react`:

```sh
pnpm add doxum react
```

Use the package manager that owns your application if it is not pnpm.

## AI Development Guide

Doxum ships a task-oriented guide for AI assistants and application developers.
It is the recommended reference for using `doxum` and `doxum/react` in place
of a generated, symbol-by-symbol API reference. The guide is included in the
published `doxum` package at `skills/doxum-runtime`.

- [English guide](skills/doxum-runtime/references/guide.en.md)
- [中文指南](skills/doxum-runtime/references/guide.zh-CN.md)
- [English patterns](skills/doxum-runtime/references/patterns.en.md)
- [中文模式参考](skills/doxum-runtime/references/patterns.zh-CN.md)
- [English invariants](skills/doxum-runtime/references/invariants.en.md)
- [中文不变量](skills/doxum-runtime/references/invariants.zh-CN.md)
- [AI skill instructions](skills/doxum-runtime/SKILL.md)

Tools that support `SKILL.md` can install or link the complete
`doxum-runtime` directory as the `$doxum-runtime` skill. The files are also
ordinary Markdown: read the guide matching your working language, then use the
patterns and invariants references for the task at hand.

## Quick Start

Define the document shape once. Doxum infers the immutable document value and
the reader and writer APIs from that schema.

```ts
import { createDocument, field, object, schema, table, type Infer } from 'doxum';

const task = object({
  title: field<string>(),
  completed: field<boolean>(),
});

const taskSchema = schema({
  title: field<string>(),
  tasks: table(task),
});

type Task = Infer<typeof task>;
type TaskDocument = Infer<typeof taskSchema>;

const runtime = createDocument({
  schema: taskSchema,
  initial: {
    title: 'Launch',
    tasks: {
      ids: ['task-1'],
      byId: {
        'task-1': { title: 'Write the brief', completed: false },
      },
    },
  },
});

runtime.update(tx => {
  tx.write.tasks.item('task-1').completed.set(true);
  return tx.read.tasks.get('task-1')?.title.get();
});
```

An update is synchronous and atomic. `apply` decodes untrusted operation
payloads before they reach mutation code. A malformed or semantically rejected
operation returns a typed `MutationIssue`; if an operation is rejected, if the
transaction calls `tx.reject`, or if user code throws, every preceding change
in that update is rolled back.

Mutation failure codes are a closed public `MutationIssueCode` union. For
application validation, use `tx.report` or `tx.reject` with a
diagnostic `{ code, message, address? }`; Doxum adds `source: 'application'`.
Published diagnostic arrays and addresses are copied and frozen.

## Infer Value Types

Use `Infer<typeof node>` or `Infer<typeof documentSchema>` for value types.
Schema-generated objects are flattened, with readonly properties and optional
presence preserved. Variants produce a discriminated union of flat branches:

```ts
import { field, object, variant, type Infer } from 'doxum';

const outcome = variant('kind', {
  victory: object({ reason: field<'sealed' | 'destroyed'>() }),
  defeat: object({ reason: field<'deadline' | 'collapse'>() }),
});

type Outcome = Infer<typeof outcome>;
// { readonly kind: 'victory'; readonly reason: 'sealed' | 'destroyed' }
// | { readonly kind: 'defeat'; readonly reason: 'deadline' | 'collapse' }
```

`Infer` includes `undefined` for an optional node; in a containing object its
property is optional. User-supplied types in `field<T>`, dict, list and tree
values retain their original type structure. Flattening does not recursively
rewrite those types or apply deep readonly to them. TypeScript controls the
exact alias presentation in editor hovers.

## Read And Subscribe

Use `snapshot(reader)` to capture an entire subtree as its `Infer` value:

```ts
import { select, snapshot } from 'doxum';

const tasks = select(runtime, read => snapshot(read.tasks));
const titles = select(runtime, read => read.tasks.ids());

runtime.update(tx => {
  tx.write.tasks.item('task-1').completed.update(done => !done);
});
```

Snapshots are immediate, detached values. They include earlier writes in the
current transaction and do not follow later writes or rollback. The reader
must still be in its active scope. Snapshotting costs proportionally to the
selected subtree; retain fine-grained readers for field-level hot paths.
Plain structures and mutable builtins such as Date, Map and Set are copied.
Opaque classes and functions require `field(validator, { snapshot: copy })`;
use `undefined` as the validator for a trusted, type-only field with a copier.
The copier must return an independent value. This does not change the existing
immutable-payload contract of ordinary field `get()`.

Field `update(value => next)` runs synchronously inside the transaction, sees
its latest value, and records an ordinary `field.set`. Object inputs are
detached before calling the updater. Return the next value; nested writes and
asynchronous callbacks are rejected. Use `clear()` to remove an optional field.

Use `select` for a one-off typed read. Use schema selectors and `subscribe`
when a non-React consumer needs only relevant commits.

```ts
import { select } from 'doxum';

const taskTitles = select(runtime, read =>
  read.tasks.ids().map(id => read.tasks.get(id)?.title.get())
);

const tasks = taskSchema.collection(path => path.tasks);
const stop = runtime.subscribe(tasks, commit => {
  const change = commit.impact.collection(tasks);
  if (change.kind === 'incremental') console.log(change.updated);
});

stop();
```

Each committed update produces a revision, forward operations, inverse
operations, and a `DocumentImpact`. Collection impacts distinguish added,
removed, updated, and reordered entries.

## Parse Values And Domain Keys

```ts
import { field, map, object, parse, schema, type Infer } from 'doxum';

type PersonId = string & { readonly personId: unique symbol };
const personId = (input: unknown): PersonId => {
  if (typeof input !== 'string' || !input.startsWith('person:')) {
    throw new TypeError('Expected a person ID.');
  }
  return input as PersonId;
};
const finiteNumber = (input: unknown): number => {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new TypeError('Expected a finite number.');
  }
  return input;
};
const person = object({ age: field(finiteNumber) });
const peopleSchema = schema({ people: map(person, { key: personId }) });
type People = Infer<typeof peopleSchema>;
const initial = parse(peopleSchema, {
  people: { 'person:1': { age: 30 } },
});
```

`parse(nodeOrSchema, unknown)` returns a detached inferred value or throws
`ParseError` with addressed issues. Validators can be synchronous functions
or Standard Schema v1 validators. They must preserve values; perform coercion
and transformations before parsing. Async validators are rejected. An encountered
opaque `field<T>()` without a validator cannot validate unknown input and is
rejected by parse; it remains available for trusted, typed runtime values.
Dict accepts `{ key, value }` validators, list accepts a `value` validator
alongside `keyOf`, and tree accepts a value validator.

Runtime initialization, replacement and incoming mutation payloads use the same
structural rules and configured validators. Incremental writes validate only
the incoming values and keys. Invalid writes reject and roll back the transaction.
Map/table key validators infer the domain key through readers, writers, anchors,
selectors, impacts and projection chains. Serialized operations retain string
keys, validated against the target schema. Keys default to string when omitted.

## History And Operations

Local history is enabled by default with a capacity of 100 commits. Doxum
records inverse operations, so undo and redo follow the same mutation path as
ordinary updates.

```ts
runtime.history.undo();
runtime.history.redo();

runtime.apply([{ type: 'field.set', at: ['title'], value: 'Ship Doxum' }]);
```

Use `runtime.history.group()` for one action spanning multiple synchronous
updates, such as a drag. Keep its handle until the action ends, then call
`end()` to retain one undo entry or `cancel()` to apply its inverses atomically.
Groups cannot nest. Undo, redo, clear, remote/replace commits, and committed
updates with `history: false` end the current group. History implements
`Readable<HistoryState>` and can be used with `useReadable` or `fromReadable`.

`apply` is the boundary for replaying operations from persistence or a network
adapter. Doxum does not provide those adapters. A `replace` or a commit marked
as `remote` invalidates local history because its prior inverse sequence is no
longer authoritative.

The returned result distinguishes `committed`, `unchanged`, and `rejected`.
Observer failures do not turn a completed write into a rejection: committed
results expose them in `observerErrors`, after history and canonical state have
already settled.

## Local Persistence And Cross-Tab Sync

`doxum/local-sync` is an optional browser attachment for a document that needs
offline persistence and same-origin, cross-tab convergence. It uses IndexedDB
as the ordered checkpoint and commit log, Web Locks to serialize background
confirmation, and BroadcastChannel only to notify other tabs to catch up from
IndexedDB. It does not need a server or Yjs.

The attachment deliberately uses a simple single-writer model. It hydrates the
runtime from the IndexedDB checkpoint and ordered command log, then attempts to
hold a Web Lock for that document. The lock holder is the `leader` and may use
the normal synchronous runtime APIs. All other attached tabs are `follower`
mirrors: they read the durable tail in order after a BroadcastChannel hint, and
their direct writes throw `LocalSyncReadOnlyError`. When the leader disposes,
a follower catches up and becomes the next leader.

The leader's `runtime.update`, normal `runtime.apply`, and
`runtime.history.undo()` / `redo()` stay synchronous and immediately visible.
Local-sync observes the resulting local, system, and history commits and writes
their JSON operation batches to IndexedDB in the background. It deliberately
rejects `runtime.replace()` and an externally supplied `apply(..., {
source: 'remote' })` while attached: neither is a local operation command that
the log can faithfully append. `flush()` is the explicit point that waits for
commits observed before the call to persist (or, in a follower, waits to catch
up to the durable head). A browser crash, quota failure, or malformed JSON
payload can therefore leave an already visible leader commit unpersisted;
observe `state` or use `onError` to surface that condition.

```ts
import { createDocument, select } from 'doxum';
import { attachLocalSync } from 'doxum/local-sync';

const runtime = createDocument({
  schema: taskSchema,
  initial: {
    title: 'Launch',
    tasks: { ids: [], byId: {} },
  },
});

const localSync = await attachLocalSync({
  runtime,
  database: 'my-app',
  documentId: 'project-1',
});

if (localSync.state.current().status === 'leader') {
  runtime.update(tx => {
    tx.write.title.set('Ship Doxum');
  });

  runtime.history.undo();
}

select(runtime, read => read.title.get()); // leader write or follower replay
await localSync.flush(); // persist observed leader commands / catch up a follower

await localSync.dispose();
```

`localSync.state` is a `Readable`: `state.current()` returns a stable snapshot,
`state.subscribe(listener)` observes persistence, leadership and error changes,
and React can consume it with `useReadable(localSync.state)`.

`attachLocalSync` first hydrates the passed runtime from IndexedDB; await it
before allowing reads or edits. It does not make runtime mutation asynchronous,
does not own `runtime.dispose()`, and does not expose a second undo API. Runtime
history is in-memory only: hydration and remote tail application invalidate it,
so an undo stack never transfers to a new leader or survives reopening a tab.
Local-sync data must be JSON. Because command validation happens after the
runtime commit, a non-JSON payload is reported as a post-commit attachment error
rather than rolling back an already observed document change.

## React

`useDocumentSelector` learns the paths read by its selector and re-renders only
when a matching commit changes the selected result.

```tsx
import { useDocumentSelector } from 'doxum/react';

function TaskCount() {
  const count = useDocumentSelector(runtime, read => read.tasks.ids().length);
  return <output>{count}</output>;
}
```

Use `useReadable` and `useHistory` with Doxum collection
views, materialized views, and history state.

## Derived Views

`createProjectionRuntime` owns an explicit graph of derived values and keyed
collections. It combines document runtimes and external values without owning
their mutations or history.

```ts
const projection = createProjectionRuntime({ onError: error => console.error(error) });
const document = projection.document(runtime);
const taskTitles = projection.map(
  document.collection(path => path.tasks),
  (_id, task) => task.title.get()
);
const taskCount = projection.value({ tasks: taskTitles }, ({ tasks }) => tasks.ids().length);
const labels = projection.map(taskTitles, (id, title) => `${id}: ${title}`);
```

`projection.value(sources, compute, { isEqual }?)` is the ordinary pure-compute
entry. Stateful algorithms use `projection.value({ sources, build }, { isEqual }?)`,
where build returns `{ value, update }`. Both use the same scheduler and lifecycle.

`projection.collection<Item>()(spec)` handles custom incremental algorithms. Its scoped
writer supports `set`, `remove`, `order`, and `replace`; `previous` and `next`
provide scoped reads. Declare all sources and use their native commit impacts
or upstream collection changes to choose candidate keys. A document collection
context also provides `candidates.keys`, `candidates.orderDirty` and `reset`,
aggregated across the entire batch. Candidates include net-zero changes; read
final state to decide the output. Doxum stages writes,
applies equality, and publishes exact `CollectionImpact` changes. It does not
automatically track item dependencies. `ids`, lazy `all`, and cached `item(id)`
implement `Readable` and work with `useReadable`.

`map` accepts document collections and upstream projection collections while
preserving keys and order. Source dependencies stay explicit.

Use `projection.input(initial, { isEqual })` for boundary values such as container
size. Its application-owned `set` updates a read-only `source`. Use
`projection.fromReadable(existing, { isEqual })` for an existing external source.
Neither replaces a document with domain mutation semantics.

Wrap the entire synchronous application action in `projection.batch(() => ...)`
before its first document commit to combine document changes and editor cleanup.
Batches nest, preserve committed source changes on exceptions, and provide no
cross-document rollback. Projection reads inside a batch return the last
published state. Document listeners still run synchronously.

All affected nodes settle before listeners. Output revisions change only when
their output changes. Update failures discard the processor instance and attempt
one fresh build; persistent faults block descendants, while independent branches
continue. Errors reach `onError` and, when inside document notification, the
committed result's `observerErrors`. Manual `rebuild()` uses the same graph.
Dispose the projection with its service; component unmount only unsubscribes.
Disposing a node with consumers is rejected, and disposed handles throw.

Schema access uses `object` for structured entities and `dict` for keyed values.
Variants expose `reader.get()` as a discriminated union and `writer.replace()`
for replacement. Optional presence is supported by field, variant, dict, list
and tree nodes. Dictionaries expose `get(key)`, `has(key)`, `keys()` and
`values()`; lists additionally support `get(key)` and `has(key)` using `keyOf`.
Tree insert/move accept `{ parentId, index }`, with index denoting the final
position after removing a moved node. See [API migration](docs/api-migration.md)
for breaking changes and the public surface.

## Data Ownership

Doxum clones the initial document. Structural values supplied through operations
are transferred to its mutable canonical document, while published commit and
history payloads are immutable snapshots. Treat data passed to an update as
owned by Doxum after the call unless the value is intentionally immutable.

Tree replacement snapshots are an exception: Doxum validates and clones the
tree structure so a caller cannot later corrupt its single-root, connected,
acyclic representation. Tree insert and move operations preserve the same
invariant.

## Development

```sh
pnpm install
pnpm run check
pnpm run build
pnpm run bench
pnpm run profile
```

The nested frame benchmarks cover field updates, unchanged updates, collection
impact reads, and field matching. Typed writers share transaction-local parent
resolution and skip operation allocation for unchanged values after validation.
All paths retain synchronous rollback, inverse operations, and exact impact.

See [the architecture guide](docs/architecture.md) for the runtime pipeline and
[AGENTS.md](AGENTS.md) for contribution rules.

## Release

`doxum` is released as one package. A normal release always increments the
patch version:

```sh
pnpm release
```

Run it only from a clean, synchronized `main` branch. The command verifies the
logged-in npm account, updates both public package versions, runs the complete
check and build, verifies the publish tarball, publishes the package, then
creates and pushes a `vX.Y.Z` release commit and tag.

If npm accepts one package but the command cannot finish, it preserves the
release state rather than reverting a version that may already be public. Fix
the external failure and continue with:

```sh
pnpm release:resume
```
