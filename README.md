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
`document.readonly()` returns a capability-stripped `ReadonlyDocument` alias for
boundaries that must not receive document write APIs.

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
Standard Schema v1 validators. Function validators are predicates/assertions: return
`true` or `undefined` for success, `false` for rejection, or throw from an assertion.
Standard Schema validation must return the original value by identity; transformed
outputs are rejected. Validators must not mutate their input. Perform transformations
before calling Doxum. `parse(model, unknown)`
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

Local/system apply may opt out of history with `history: false`. Remote apply uses
`{ expectedRevision, source: 'remote' }` and always invalidates local history; it has
no independent history option.

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

Projection definitions are lazy and reusable. A `ProjectionRuntime` owns materialization,
incremental state, scheduling, publication, batching, recovery and Runtime-local inputs.

```ts
import { createProjectionRuntime, derive, input, observe } from 'doxum';

const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');

const visible = derive({ tasks, filter }, ({ tasks, filter }) =>
  filter === 'all' ? tasks : new Map([...tasks].filter(([, task]) => !task.done))
);

const runtime = createProjectionRuntime({ onError: console.error });

const current = runtime.read(visible);
const selected = runtime.select(visible, tasks => tasks.get('a'));
const stop = selected.subscribe(() => selected.current());

runtime.update(filter, 'open');
runtime.batch(
  () => {
    runtime.update(filter, 'all');
    document.update(draft => {
      draft.title = 'Updated';
    });
  },
  { cause: { action: 'refresh' } }
);

stop();
runtime.dispose();
```

The stable vocabulary is `read` for a synchronous current value, `select` for a
`Readable`, and `observe` for declaring a lazy source boundary. `ProjectionRuntime`
exposes `read`, `select`, `update`, `batch`, `scope` and `dispose`.
`ProjectionScope` mirrors `read`, `select`, `update`, `batch` and `dispose`, plus
`own(definitionOrTree)` for lifecycle ownership of lazy projection definitions.

### Keyed projection

`derive.keyed` preserves a keyed driver's membership and order while deriving entries
independently. The simple form is a per-entry selector:

```ts
const fieldValues = derive.keyed(records, record => record.values[fieldId]);
```

The output keeps one key per source entry. The selector runs only for affected keys,
and the optional equality function suppresses `updated` output transitions when the
derived value is equal.

Dynamic joins stay explicit in the dependency graph. Declare keyed lookups and ordinary
projection dependencies by name:

```ts
const cardContent = derive.keyed(
  items,
  {
    record: { source: records, key: item => item.recordId },
    view: activeView,
    fields: visibleFields,
  },
  (item, itemId, { record, view, fields }) => renderCard(itemId, item, record, view, fields)
);
```

For `{ source, key }` dependencies, the Runtime owns output-key → source-key bindings
and reverse invalidation. A missing source entry resolves to `undefined` but remains
bound, so adding it later invalidates the dependent output keys. An ordinary projection
dependency invalidates the driver key set when its value changes. Processor code never
performs imperative Runtime reads to discover dependencies.

### Runtime-local keyed state

Use `input.collection` for selection, expanded state, local overrides and other
Runtime-local keyed application/UI state:

```ts
const selection = input.collection<RowId, SelectionState>(
  new Map(),
  (previous, next) => previous.selected === next.selected
);

runtime.update(selection, draft => {
  draft.set(rowId, { selected: true });
  draft.remove(previousRowId);
});
```

Its state is owned by the `ProjectionRuntime`, not the document, history or persistence.
Updates are synchronous and atomic. It publishes exact keyed `CollectionChange`
transitions and preserves order. The optional per-entry equality defaults to `Object.is`
and suppresses equivalent `set` operations.

The processor-facing `CollectionChange` type is exported by `doxum/advanced`.

A root input definition can be materialized independently by several runtimes. Wrap any
definition in `scope.own(...)` when its lifecycle belongs to one scope; scalar inputs,
keyed inputs, derives and advanced group output trees all use the same ownership API.
Ownership must be assigned before that definition is first materialized as a root.

### Sources and scopes

`observe` adapts documents, Doxum `Readable` values and exported external source
contracts. Document `map`, `table` and `list(field, { keyOf })` paths become keyed
collection projections. Trees reuse the same model: `path.tree.rootId` is scalar,
`path.tree.nodes` is keyed and `path.tree.nodes.item(id)` is a single-node value source.

```ts
const scope = runtime.scope();
const localFilter = scope.own(input<'all' | 'open'>('all'));
const localVisible = scope.own(
  derive({ tasks, filter: localFilter }, ({ tasks, filter }) =>
    filter === 'all' ? tasks : new Map([...tasks].filter(([, task]) => !task.done))
  )
);

scope.read(localVisible);
scope.dispose();
```

A scope shares its parent Runtime's scheduler and source materialization but owns the
lifetime of definitions passed to `scope.own`, their materialized producers, state and
subscriptions. Scoped definitions may depend on root definitions; root definitions and
sibling scopes cannot depend on scoped definitions. A materialized root definition cannot
later be converted into a scoped definition.

### Advanced processors

Use `doxum/advanced` only when pure `derive` / `derive.keyed` cannot express retained
state, cross-key indexes, or direct incremental patches. Dependencies are always named.
The processor definition is closed and always owns `process()`. Add `state()` only when
the processor actually needs Runtime-owned retained state.

```ts
import { incremental } from 'doxum/advanced';

const doubled = incremental.collection(
  { tasks },
  {
    state: () => ({ initialized: false }),
    process: ({ values, changes, output, state, reset }) => {
      if (reset) {
        for (const [id, task] of values.tasks) {
          output.set(id, task.value * 2);
        }
        output.order([...values.tasks.keys()]);
        state.initialized = true;
        return;
      }

      const change = changes.tasks;
      if (!change || change.kind === 'reset') return;

      for (const entry of change.added) output.set(entry.key, entry.after.value * 2);
      for (const entry of change.updated) output.set(entry.key, entry.after.value * 2);
      for (const entry of change.removed) output.remove(entry.key);
      if (change.order) output.order([...values.tasks.keys()]);
    },
  }
);
```

`incremental(...)` produces one scalar value projection.
`incremental.collection(...)` exposes keyed `previous`, `next` and `output`.
`incremental.group(...)` runs one processor for several atomic output leaves:

```ts
const render = incremental.group(
  { tasks },
  {
    output: define => ({
      shell: define.collection<string, { readonly title: string }>(),
      content: define.collection<string, string>(),
      count: define.value<number>(),
    }),
    state: () => ({ renders: 0 }),
    process: ({ values, output, state }) => {
      state.renders++;
      for (const [id, task] of values.tasks) {
        output.shell.set(id, { title: task.title });
        output.content.set(id, task.title);
      }
      output.count.set(values.tasks.size);
    },
  }
);
```

`define.collection<K,V>(equality?)` and `define.value<T>(equality?)` are output
declaration methods available only inside `output`. The returned object tree keeps the
same shape with ordinary `Projection` leaves. Value leaves must be initialized on
initial build or Runtime recovery; untouched value leaves retain their value during a
normal incremental run.

`values` and `changes` use the dependency names. Collection changes are exact
`added` / `updated` / `removed` transitions plus optional `order`; scalar dependency
changes are `undefined`. `reset` means the processor must reconcile from current source
values. Ordinary source resets preserve retained state when one exists. If a processor
faults, the Runtime owns recovery, recreates declared state, and performs a reset
evaluation. Stateless processors use the same recovery path without a state object.

### React

```ts
const task = useProjection(tasks, tasks => tasks.get(taskId), equality);
const [mode, setMode] = useInput(filter);
const [selectedRows, updateSelectedRows] = useInput(selection);
```

`useProjection(projection, selector, equality?)` uses the same keyed selector semantics
as Core. `useInput` handles both scalar `Input<T>` and `CollectionInput<K,V>`; collection
updates receive a keyed draft callback. `ProjectionProvider` accepts either a
`ProjectionRuntime` or `ProjectionScope`.

See [projection contracts](docs/projections.md).

## Local Sync

`doxum/local-sync` attaches an IndexedDB timeline and Web Lock leadership to a
runtime. One leader writes synchronously and persists final changes asynchronously;
followers apply the durable sequence in order. `flush()` waits for persistence.
Durability errors do not roll back an already visible commit.

Operational failures use one `LocalSyncError` contract. Error states and `onError`
receive that same typed error and preserve an underlying `cause` when one exists.
Exceptions thrown by consumers of `state.subscribe` stay outside synchronization
fault state and are not reported through operational `onError`.

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
