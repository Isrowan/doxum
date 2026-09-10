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
  const task = draft.tasks.get('a');
  if (task) task.done = true;
  draft.tasks.put('b', { title: 'Review', done: false });
  draft.tasks.remove('a');
  return { warnings: [] };
});
```

The root object is the schema identity. Multiple runtimes can share its definition;
their data, revisions and subscriptions remain independent. Definitions are immutable.

`object()` exposes editable structure with a closed schema: undeclared own properties,
including symbols and non-enumerable properties, are rejected at input boundaries.
A variant allows its discriminant and the active branch's declared members.
Use `map()` for dynamic keys and `field<T>()` for arbitrary payload objects.
`field<T>()` is atomic: replace the whole
value, including objects, arrays, Maps and Dates. Atomic payloads are shared by
reference across inputs, reads, snapshots, commits and history. They are deeply
readonly in `Infer`/`Read`/`Draft`: never mutate them through any alias, even after
removal from the document. Published results are readonly by contract, without
defensive deep copying or runtime freezing. Classes and functions need no copier.

Drafts and structural reads are borrowed for their synchronous callback. Draft and
internal reader proxies must not escape their callback; escaping them is undefined
behavior. Ordinary property
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

- `map(field(...))`, `map(object(...))`, `map(variant(...))` expose
  `get/has/ids/put/remove/replace`. `put` is an upsert; removing a missing key is a no-op.
- `table(object(...))` retains `{ ids, byId }` data and exposes
  `get/has/ids/create/remove/move/replace`.
- `list(field(...), { keyOf })` retains a plain array and exposes
  `get/has/ids/insert/remove/move/replace`.
- `tree(field(...))` retains `{ rootId?, nodes }` and exposes topology reads plus
  `insert/remove/move/replace`.
- `variant(tag, branches)` has a readonly discriminant and whole-value branch replacement.
- `optional(node)` permits absence for fields, variants, maps, lists and trees.

Map/table key validators preserve branded string types through access, paths,
projection keys and impact queries. Validators are pure, synchronous functions or
Standard Schema v1 validators. They receive the original value, must not mutate it,
and their successful output is ignored. Perform transformations before calling
Doxum; it does not detect validator mutation or conversion. `parse(model, unknown)`
validates and copies schema structure while sharing readonly payloads. Strict parsing
requires validators for atomic fields; typed in-memory fields can omit them.

Collection `replace` has two forms: `replace(id, value)` replaces one existing
table/list/tree member without changing order or topology, while `replace(value)`
replaces the entire map/table/list/tree. Use top-level `replace(parent, key, value)`
when replacing an object or variant member whose draft type exposes collection tools:

```ts
import { replace, table, variant } from 'doxum';
const boardModel = object({
  entries: map(object({ rows: table(task) })),
  view: variant('kind', {
    empty: object({}),
    tasks: object({ rows: table(task) }),
  }),
});
const board = createDocument({
  schema: boardModel,
  initial: { entries: {}, view: { kind: 'empty' } },
});
board.update(draft => {
  draft.entries.put('a', { rows: { ids: [], byId: {} } });
  replace(draft, 'view', { kind: 'tasks', rows: { ids: [], byId: {} } });
});
```

Top-level `replace` checks the parent key and its plain `Infer` value, then enters the
same transaction write path. It is useful for variant replacement and initializing
optional collections. Map entries use `put`; collection-wide replacements use the
collection's own `replace`. Ordinary field and object-member assignments remain the
common case. See [value boundaries](docs/value-boundaries.md).

## Changes And History

A commit contains `{ revision, source, changes, impact }`. Repeated writes to one
field produce one first-before/final-after fact. Net-zero transactions do not
advance revision or notify. A `members` change shares its container address across
member transitions: `added` carries `after`, `removed` carries `before`, and
`updated` carries both. `order` records key sequences, `tree` records touched nodes
and nullable root IDs, and `reset` records a whole-document transition. There are
no per-value presence wrappers or intermediate assignment logs.

```ts
const changes = {
  changes: [
    {
      kind: 'members',
      at: ['tasks', 'a'],
      members: [{ key: 'title', kind: 'updated', before: 'A', after: 'B' }],
    },
  ],
};
```

Each container appears in at most one members group. Grouping preserves exact
field impact; a group at `[]` is an incremental root-member change, not a reset.
An ordered container's group may also contain `order: { before, after }` with its
complete key sequences. Order-only groups use `members: []`; a standalone `order`
change or a second group for the same container is rejected. Apply installs each
group's members and order together before moving to the next group.

`document.apply(changes, { expectedRevision })` accepts unknown input. The revision
must match this runtime. The decoder rejects malformed and overlapping facts, then
the same session applies the complete transition atomically. Received `before`
values support reverse replay but are not trusted as local undo data; the runtime
captures its actual old state. Revision is a local baseline, not a distributed
conflict-resolution protocol.

Published ChangeSets are readonly in their entirety, including envelope objects,
addresses, transitions and order arrays. The runtime reuses validation of its own
publications and normalized storage input by identity; fresh unknown input still
passes through the decoder and every apply validates against current local state.

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
import { createProjectionStore, input, project } from 'doxum';

const titles = project(
  document,
  path => path.tasks,
  (id, task) => `${id}: ${task.title}`
);
const count = project({ titles }, ({ titles }) => titles.ids().length);
const zoom = input(1);
const scaled = project({ count, zoom }, ({ count, zoom }) => count * zoom);

const store = createProjectionStore({ onError: console.error });
store.get(scaled);
store.set(zoom, 2);
```

Projection declarations are lazy and reusable. A `ProjectionStore` owns
materialized values, subscriptions, batching, processor state and disposal.
`project(document, path)` binds a document collection; adding a mapper performs
incremental keyed mapping. `project(readable)` bridges an external readable.
Pure computations receive current values. Advanced processors use tagged specs:
`project({ kind: 'value', sources, build })` and
`project({ kind: 'collection', sources, build })`.
Document collection events provide scoped `read.get/has/ids`, final candidate
keys, order dirtiness, commits and reset state.
Ordinary mappers intentionally model only one-source, same-key transforms.
Cross-collection relationships use an advanced collection processor with explicit,
application-owned dependency indexes; processor reads are not tracked automatically.

Processors settle before external listeners. `store.batch` defers graph
settlement and projection notifications, but document commits/listeners remain
synchronous. Projection readers inside the batch see the last publication.
Dispose projection stores with their owning service.
See [projection contracts](docs/projections.md).

## Local Sync

`doxum/local-sync` attaches an IndexedDB timeline and Web Lock leadership to a
runtime. One leader writes synchronously and persists final changes asynchronously;
followers apply the durable sequence in order. `flush()` waits for persistence.
Durability errors do not roll back an already visible commit.

The storage format is IndexedDB version 5 with format version 3 records. Earlier
databases are rejected without upgrading, deleting or converting their data.
This JSON adapter rejects non-JSON atomic values. Network collaboration and
collaborative undo remain separate concerns; see [collaboration design](COLLABORATION_DESIGN.md).
Change count limits count individual members and tree nodes, not just outer groups.
`changeLimits` applies to newly authored local commits. Previously persisted
commits remain readable by followers and after reopening with smaller limits;
their JSON and ChangeSet structure are still validated.

## Development

```sh
pnpm install
pnpm run check
pnpm run build
pnpm run bench
pnpm run profile
node test.mjs
node core/bench/architecture.mjs --isolate
```

The architecture benchmark isolates each workload in a fresh process. Use
`--allocation` for separate V8 allocation sampling, `DOXUM_BENCH_FILTER` for a
comma-separated workload list, and `DOXUM_BENCH_MODULE=/absolute/path/to/index.js`
to compare a saved build. Sampling timings are not normal latency measurements.
`pnpm run profile` reports work counters and separates writes, sealing, remaining
runtime/publication work and explicit impact queries.
It also reports structural generation advances and distinguishes captured order
baselines from final published order copies. Architecture workloads include order
round trips and repeated tree edits to expose costs hidden by commit-only benchmarks.

Builds produce root `dist` ESM/CJS/declarations for `doxum`, `doxum/integration`,
`doxum/local-sync` and `doxum/react`. Source ownership is described in
[architecture](docs/architecture.md) and [AGENTS.md](AGENTS.md).
The runtime shares one transaction lifecycle; complete mutation operations are
organized by domain under `core/src/mutation/operations`, with access, first-touch
recording and publication retaining their own responsibilities.
The published [runtime skill](skills/doxum-runtime/SKILL.md) includes English and
Chinese application guidance.

## Release

Run `pnpm release` from a clean, synchronized `main` branch to execute the release
checks, build, tarball validation, npm publication and release commit/tag steps.
Use `pnpm release:resume` to continue an interrupted release after resolving its
external failure. Publication is a separate maintainer action.
