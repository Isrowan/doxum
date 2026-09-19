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
import { read, select, snapshot } from 'doxum';

const title = read(document, state => state.title);
const tasks = read(document, state => snapshot(state.tasks));
const selectedTitle = select(document, state => state.title);
const stop = selectedTitle.subscribe(() => {
  console.log(selectedTitle.current());
});
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
`select(document, selector, equality?)` returns a standard `Readable`. Core
tracks exactly the document locations read by the selector, rebinds dependencies
when selector branches change, and preserves the previous selected reference and
publication revision when `equality` reports no result change.

React integration:

```ts
import { useDocumentSelector, useHistory, useReadable } from 'doxum/react';

const title = useDocumentSelector(document, state => state.title);
const history = useHistory(document.history);
```

Document dependency tracking belongs to Core's `select`; the React adapter only
subscribes to the resulting `Readable`. The core has no React dependency.
`asReadable(document)` removes write capabilities while retaining selection,
subscription and projection support.

## Containers And Parsing

- `map(field(...))`, `map(object(...))`, `map(variant(...))` expose
  `get/has/ids/put/remove/replace`. `put` is an upsert; removing a missing key is a no-op.
- `table(object(...))` retains `{ ids, byId }` data and exposes
  `get/has/ids/create/remove/move/reorder/replace`.
- `list(field(...), { keyOf })` retains a plain array and exposes
  `get/has/ids/insert/remove/move/reorder/replace`.
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

A tree may be empty, but payload presence follows the payload field schema exactly.
`tree(field<T>())` requires every existing node to own a `value` property;
`tree(optional(field<T>()))` is the explicit sparse-payload form. This is independent
from `optional(tree(...))`, which controls whether the whole tree member may be absent.
Missing and present-`undefined` payloads remain distinct when the payload field is optional.

Ordered table/list drafts accept either one key or a key selection in
`move(key | readonly key[], anchor?)`. A selection is moved as one block while
preserving its current canonical relative order; the anchor is resolved after the
selection is removed. Use `reorder(keys)` when the caller already owns the complete
final order: it requires an exact permutation of current membership and changes no
member values. Whole-collection `replace(value)` remains a distinct replacement
operation and is not an order primitive.

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
import { createProjectionRuntime, derive, input, observe } from 'doxum';

const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');
const visible = derive([tasks, filter], (all, mode) => {
  if (mode === 'all') return all;
  return new Map([...all].filter(([, task]) => !task.done));
});

const runtime = createProjectionRuntime({ onError: console.error });
runtime.get(visible);
const selected = runtime.readable(visible, tasks => tasks.get('a'));
const stop = selected.subscribe(() => selected.current());
runtime.set(filter, 'open');
runtime.batch({ cause: { action: 'refresh' } }, () => {
  runtime.set(filter, 'all');
  document.update(draft => {
    draft.title = 'Updated';
  });
});
stop();
```

Root projection declarations are lazy and reusable; scoped declarations are
lazy but tied to their scope. The Runtime owns `get`,
`readable`, scalar `set`, keyed `update`, `batch`, `scope` and `dispose`;
materialization, incremental state, publication and recovery stay inside that
one Runtime. Collection values are
immutable `ReadonlyMap`-like snapshots, while a `Readable` owns selector
tracking, equality and subscription lifecycle.

`derive.keyed` preserves a keyed source's membership and order while deriving each
entry independently. Per-entry equality removes source updates whose selected value
did not change:

```ts
const fieldValues = derive.keyed(records, record => record.values[fieldId]);
```

It also supports explicitly declared dynamic keyed dependencies without exposing a
document path grammar or allowing processors to discover dependencies with
`runtime.get()`:

```ts
const cardContent = derive.keyed(
  items,
  [{ source: records, key: item => item.recordId }, activeView, visibleFields],
  (item, itemId, record, view, fields) => renderCard(item, record, view, fields)
);
```

The Runtime owns the resulting output-key/source-key bindings and reverse lookup.
A missing source key remains bound, so adding it later invalidates the dependent
output keys. Scalar dependencies invalidate all driver keys; reset and recovery use
the same projection rebuild lifecycle.

Local projections share the parent Runtime's scheduler and materialization owner:

```ts
const scope = runtime.scope();
const localFilter = scope.input<'all' | 'open'>('all');
const localVisible = scope.derive([tasks, localFilter], (tasks, filter) =>
  filter === 'all' ? tasks : new Map([...tasks].filter(([, task]) => !task.done))
);
scope.get(localVisible);
scope.dispose(); // Releases local producers, state and subscriptions; parent tasks remain.
```

For Runtime-local keyed state, `input.collection` publishes the same exact
`CollectionChange` as document collections. One `update` edits one or many keys
atomically; the enclosing Runtime batch coalesces accepted edits into one net
change:

```ts
const overrides = input.collection<string, Task>();
runtime.update(overrides, draft => {
  draft.set(taskId, task);
  draft.remove(oldTaskId);
});
```

`observe` is the single source boundary for documents, Doxum `Readable` values,
and eventful external sources. External sources declare `kind: 'value'` or
`kind: 'collection'`; collection invalidation remains keyed internally. Schema
`map`, `table`, and `list(field, { keyOf })` paths are all observed as keyed
collection projections. Trees expose structural observation without a second
projection protocol: `path.tree.rootId` is a scalar source,
`path.tree.nodes` is a keyed collection source, and
`path.tree.nodes.item(id)` is a single-node value source. A schema `list` uses its
`keyOf` identity and publishes in document order; ordinary array-valued `field(...)`
nodes remain scalar values.

Document projection sources route committed groups directly to their observed
targets, merge affected locations for the current projection batch, then combine the
previously published snapshot with the canonical final value. A touched tree node
replaces only that node structure and the necessary ancestor containers; unchanged
tree-node snapshots keep their identity. Whole aggregate tree values still use the
public `{ rootId?, nodes: Record }` shape, so changing a node may shallow-copy the
`nodes` record, while native `tree.nodes` observation remains keyed and touches only
changed nodes.

For retained state, cross-key indexes and keyed patches that cannot be expressed by
`derive.keyed`, use the isolated advanced entry point. Whole-value processors use
`incremental(...)`; keyed collection processors use `incremental.collection(...)`:

```ts
import { incremental } from 'doxum/advanced';

const doubled = incremental.collection([tasks], ({ sources, output }) => {
  for (const [id, task] of sources[0]) output.set(id, task.value * 2);
});

const render = incremental.group(
  [tasks],
  define => ({
    node: {
      shell: define.collection<string, { readonly title: string }>(),
      content: define.collection<string, string>(),
    },
    labels: define.collection<string, string>(),
    chrome: define.value<{ readonly count: number }>(),
    revision: define.value<number>(),
  }),
  ({ sources, outputs }) => {
    for (const [id, task] of sources[0]) {
      outputs.node.shell.set(id, { title: task.title });
      outputs.node.content.set(id, task.title);
      outputs.labels.set(id, task.title);
    }
    outputs.chrome.set({ count: sources[0].size });
    outputs.revision.set(sources[0].size);
  }
);
```

Incremental processors receive a dependency-aligned `changes` tuple. Collection
entries carry `added`/`updated`/`removed` transitions with complete
`before`/`after` values, so a processor can patch indexes without rescanning the
collection; scalar dependencies use `undefined` and the initial collection build
reports `{ kind: 'reset' }`.
`incremental.group` runs one processor for several named value and keyed collection
outputs. `define.collection<K, V>(equality?)` creates a keyed leaf;
`define.value<T>(equality?)` creates an ordinary scalar projection leaf. On an
initial build or rebuild every value leaf must be set; on an incremental update an
untouched value leaf keeps its published value. Its static nested namespace is only
API organization: every leaf is an ordinary `Projection`, all changed leaves publish
atomically in one causal settle, and downstream processors depend directly on those
leaves. All leaves reference one producer, so reading any leaf materializes that
producer once; split groups when outputs do not share computation or atomicity
requirements. There is no group runtime, output event bus, or per-output runtime.

In React, `useProjection(projection)` reads a value and
`useProjection(projection, selector, equality?)` tracks keyed reads such as
`tasks => tasks.get(taskId)`. Unrelated key changes do not execute that selector;
equality only filters a selector result after a related change. `useInput(input)`
returns the current value and its Runtime-local setter.

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

Builds produce root `dist` ESM/CJS/declarations for `doxum`,
`doxum/local-sync`, `doxum/react` and `doxum/advanced`. Source ownership is described in
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
