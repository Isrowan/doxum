# Doxum

Doxum is a TypeScript runtime for mutable documents with synchronous atomic
updates, reversible final changes, history, precise subscriptions, and incremental
projections. Licensed under the [MIT License](LICENSE).

```sh
pnpm add doxum
```

## Define And Update

```ts
import { createDocument, field, map, object, type Infer } from 'doxum';

const task = object({ title: field<string>(), done: field<boolean>() });
const model = object({ tasks: map(task), title: field<string>() });
type TaskDocument = Infer<typeof model>;

const document = createDocument({
  schema: model,
  initial: { title: 'Launch', tasks: { a: { title: 'Write', done: false } } },
});

document.update(draft => {
  const task = draft.tasks.a;
  if (task) task.done = true;
  draft.tasks.b = { title: 'Review', done: false };
  delete draft.tasks.a;
  return { warnings: [] };
});
```

The root object is the schema identity. Multiple runtimes can share its definition;
their data, revisions and subscriptions remain independent. Definitions are immutable.

`object()` exposes editable structure. `field<T>()` is atomic: replace the whole
value, including objects, arrays, Maps and Dates. Atomic payloads are shared by
reference across inputs, reads, snapshots, commits and history. They are deeply
readonly in `Infer`/`Read`/`Draft`: never mutate them through any alias, even after
removal from the document. Published results are readonly by contract, without
defensive deep copying or runtime freezing. Classes and functions need no copier.

Drafts and structural reads expire when their callback returns. Ordinary property
reads see preceding writes in the same update. Same-address proxies are stable
within a scope and resolve against current structure after replacement.

Throw `new TransactionRejected({ code, message, address? })` for expected business
rejection. Schema and structural failures also return `status: 'rejected'` and
restore all prior work. Other thrown values roll back and are rethrown unchanged.
Normal callback returns, including `false`, are business results, not cancellation.
Committed observer failures are returned in `observerErrors` without rollback.

## Read And Observe

```ts
import { select, snapshot } from 'doxum';

const title = select(document, state => state.title);
const tasks = select(document, state => snapshot(state.tasks));
document.subscribe(
  path => path.tasks.item('b').title,
  commit => {
    console.log(commit.revision, commit.changes);
  }
);
document.subscribe([path => path.title, path => path.tasks], () => {});
```

`snapshot` exports a stable value with the subtree's `Infer` type: editable schema
structure is copied, while immutable atomic payloads keep their identity.
`snapshot(rawPayload)` returns that same readonly reference. To edit exported
payloads, explicitly copy them in application code; `structuredClone` works for
supported types, while classes/functions need application-specific handling.
Use ordinary properties for fine-grained reads. Data callbacks read real values;
path callbacks describe symbolic schema locations, including missing entries.
Subscription paths compile once during registration.

React integration:

```ts
import { useDocumentSelector, useHistory, useReadable } from 'doxum/react';

const title = useDocumentSelector(document, state => state.title);
const history = useHistory(document.history);
```

React tracks fields actually read and updates dependencies when the selector
branches. The core has no React dependency. `asReadable(document)` removes write
capabilities while retaining selection, subscription and projection support.

## Containers And Parsing

- `map(field(...))`, `map(object(...))`, `map(variant(...))` use key indexing,
  assignment and deletion. Absent differs from present `undefined`.
- `table(object(...))` retains `{ ids, byId }` data and `get/has/ids/create/remove/move`.
- `list(field(...), { keyOf })` retains a plain array and `get/has/ids/insert/set/remove/move/replace`.
- `tree(field(...))` retains `{ rootId?, nodes }` and explicit topology methods.
- `variant(tag, branches)` has a readonly discriminant and whole-value branch replacement.
- `optional(node)` permits absence for fields, variants, maps, lists and trees.

Map/table key validators preserve branded string types through access, paths,
projection keys and impact queries. Validators are pure, synchronous functions or
Standard Schema v1 validators. They receive the original value, must not mutate it,
and their successful output is ignored. Perform transformations before calling
Doxum; it does not detect validator mutation or conversion. `parse(model, unknown)`
validates and copies schema structure while sharing readonly payloads. Strict parsing
requires validators for atomic fields; typed in-memory fields can omit them.

For replacements containing nested collection tools, use `assign(scope, key, value)`:

```ts
import { assign, table } from 'doxum';
const boardModel = object({ entries: map(object({ rows: table(task) })) });
const board = createDocument({ schema: boardModel, initial: { entries: {} } });
board.update(draft => {
  assign(draft.entries, 'a', { rows: { ids: [], byId: {} } });
});
```

TypeScript cannot give a mapped property a draft read type and a different plain
data assignment type. `assign` checks the key and its `Infer` value and calls the
same transaction write path. It is useful for complex map entries, variant
replacement and initializing optional lists/trees. Ordinary assignments remain
the common case. See [value boundaries](docs/value-boundaries.md).

## Changes And History

A commit contains `{ revision, source, changes, impact }`. Repeated writes to one
field produce one first-before/final-after fact. Net-zero transactions do not
advance revision or notify. The `ChangeSet` contains value/presence facts, order
facts and touched tree node facts. It records no intermediate assignment sequence.

`document.apply(changes, { expectedRevision })` accepts unknown input. The revision
must match this runtime. The decoder rejects malformed and overlapping facts, then
the same session applies the complete transition atomically. Received `before`
values support reverse replay but are not trusted as local undo data; the runtime
captures its actual old state. Revision is a local baseline, not a distributed
conflict-resolution protocol.

`history.undo()` and `redo()` replay the same changes by direction. A history group
holds complete commits and travels atomically with one notification:

```ts
const group = document.history.group();
document.update(draft => {
  draft.title = 'First';
});
document.update(draft => {
  draft.title = 'Final';
});
group.end();
document.history.undo();
```

`group.cancel()` restores its start and pre-group history. Local `replace` is an
explicit reversible root reset. Remote commits invalidate local history. Writes
with `history: false` close the active group.

## Projections

```ts
import { createProjectionRuntime } from 'doxum';

const projection = createProjectionRuntime({ onError: console.error });
const source = projection.document(document);
const titles = projection.map(
  source.collection(path => path.tasks),
  (id, task) => `${id}: ${task.title}`
);
const count = projection.value({ titles }, ({ titles }) => titles.ids().length);
```

Sources and processor dependencies are explicit. Use `source.targets(path => ...)`
to restrict a document source, `projection.input` for application boundary values,
and `projection.fromReadable` for external readable state. Stateful algorithms use
`projection.value({ sources, build })` or `projection.collection<T>()(spec)`.
Document collection contexts supply scoped `read.get/has/ids`, final candidate
keys, order dirtiness, commits and reset state.

Processors settle before external listeners. `projection.batch` defers graph
settlement and projection notifications, but document commits/listeners remain
synchronous. Projection readers inside the batch see the last publication.
Dispose projection runtimes with their owning service.
See [projection contracts](docs/projections.md).

## Local Sync

`doxum/local-sync` attaches an IndexedDB timeline and Web Lock leadership to a
runtime. One leader writes synchronously and persists final changes asynchronously;
followers apply the durable sequence in order. `flush()` waits for persistence.
Durability errors do not roll back an already visible commit.

The storage format is IndexedDB version 3 with format version 1 records. Earlier
databases are rejected without upgrading, deleting or converting their data.
This JSON adapter rejects non-JSON atomic values. Network collaboration and
collaborative undo remain separate concerns; see [collaboration design](COLLABORATION_DESIGN.md).

## Development

```sh
pnpm install
pnpm run check
pnpm run build
pnpm run bench
pnpm run profile
node test.mjs
```

Builds produce root `dist` ESM/CJS/declarations for `doxum`, `doxum/integration`,
`doxum/local-sync` and `doxum/react`. Source ownership is described in
[architecture](docs/architecture.md) and [AGENTS.md](AGENTS.md).
The published [runtime skill](skills/doxum-runtime/SKILL.md) includes English and
Chinese application guidance.

## Release

Run `pnpm release` from a clean, synchronized `main` branch to execute the release
checks, build, tarball validation, npm publication and release commit/tag steps.
Use `pnpm release:resume` to continue an interrupted release after resolving its
external failure. Publication is a separate maintainer action.
