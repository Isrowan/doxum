# Doxum

Doxum is a typed TypeScript runtime for complex mutable documents. It is built
for editors and product surfaces that need structured state, atomic updates,
undo/redo, precise change notifications, and incremental derived data.

Licensed under the [MIT License](LICENSE).

It is a local in-memory runtime. Persistence, synchronization, authorization,
and conflict resolution are intentionally application concerns.

## Packages

- `doxum` defines schemas, mutations, history, subscriptions, and views.
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
`DocumentDiagnostic`; published diagnostic arrays and addresses are copied and
frozen.

## Read And Subscribe

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

## History And Operations

Local history is enabled by default with a capacity of 100 commits. Doxum
records inverse operations, so undo and redo follow the same mutation path as
ordinary updates.

```ts
runtime.history.undo();
runtime.history.redo();

runtime.apply([{ type: 'field.set', at: ['title'], value: 'Ship Doxum' }]);
```

`apply` is the boundary for replaying operations from persistence or a network
adapter. Doxum does not provide those adapters. A `replace` or a commit marked
as `remote` invalidates local history because its prior inverse sequence is no
longer authoritative.

The returned result distinguishes `committed`, `unchanged`, and `rejected`.
Observer failures do not turn a completed write into a rejection: committed
results expose them in `observerErrors`, after history and canonical state have
already settled.

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

`createCollectionView` incrementally projects one table or map into `ids`,
`all`, and cached `item(id)` readables. `createMaterializedView` is for
indexes and aggregates that need custom incremental update logic. A materialized
view may depend on earlier views from the same runtime; Doxum settles that graph
before notifying external listeners.

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
