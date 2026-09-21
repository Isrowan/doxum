# Projection API

Projection definitions are lazy. Root definitions are reusable across
`ProjectionRuntime` Instances; scope-owned definitions belong to one
`ProjectionScope`. A `Projection<T>` is only a definition. Materialized values,
retained state, subscriptions, errors and disposal state belong to the Runtime.

## Declaration model

```ts
import { createProjectionRuntime, derive, input, observe } from 'doxum';

const mode = input<'all' | 'open'>('all');
const tasks = observe(document, path => path.tasks);

const visible = derive({ tasks, mode }, ({ tasks, mode }) =>
  mode === 'all' ? tasks : filterOpen(tasks)
);
```

Public declaration primitives are:

- `input(initial, equality?)` — Runtime-local scalar state.
- `input.collection(initial?, equality?)` — Runtime-local keyed state.
- `observe(...)` — document, `Readable`, or exported external source boundary.
- `derive(dependencies, compute, equality?)` — pure value derivation.
- `derive.keyed(...)` — key-preserving per-entry derivation and keyed joins.
- `derive.keyed.from(...)` — ordered scalar/static collection to keyed projection.
- `derive.keyed.merge(...)` — multiple keyed projections to one union projection.

`Projection<T>` is the scalar/value handle and `KeyedProjection<K,V>` is the public
keyed handle. Collection `observe`, `derive.keyed`, `incremental.collection`, and
collection group leaves all return `KeyedProjection`. `CollectionInput<K,V>` adds the
writable Runtime-local capability to that keyed handle.

Dependencies are named objects. They are part of the static processor graph; a
processor never performs imperative Runtime reads to discover new dependencies.

## Keyed derivation

The simple form maps each driver entry independently and preserves driver
membership and order:

```ts
const fieldValues = derive.keyed(records, record => record.values[fieldId]);
```

Only affected driver keys run the selector. The optional equality function
compares the previous and next selected value for one key. Equal results do not
publish an `updated` transition. Added, removed and order transitions keep their
normal `CollectionChange` meaning.

Standard keyed structure reads stay in the same family:

```ts
const ids = derive.keyed.keys(records); // Projection<readonly RecordId[]>
const all = derive.keyed.values(records); // Projection<readonly Record[]>
const entries = derive.keyed.entries(records); // Projection<readonly (readonly [RecordId, Record])[]>
const active = derive.keyed.get(records, activeRecordId); // Projection<Record | undefined>
```

`keys` republishes only for add/remove/order/reset. A value-only update keeps its
published array reference and revision. `values` and `entries` follow formal keyed order
and update for entry or structural changes. `entries` reuses tuple references for
unchanged entries. `get` binds to exactly one scalar-selected key; missing keys remain
bound so a later add invalidates the result.

Keyed shape construction and composition are also first-class:

```ts
const rows = derive.keyed.from(rowArray, row => row.id);
const projectedRows = derive.keyed.from(rowArrayProjection, row => row.id);
const effectiveRows = derive.keyed.merge([baseRows, rowOverrides], {
  conflict: 'last',
});
```

`from` accepts either `readonly V[]` or `Projection<readonly V[]>`. `keyOf(value)` is
the keyed identity and must produce unique string keys. The array's order is the output
formal order. Duplicate keys are processor errors. Static outer arrays are shallow-
snapshotted at definition creation, but `keyOf` still runs lazily during materialization.
Scalar-array updates require an O(n) scan because the scalar source has no entry delta;
the resulting keyed publication is still exact. Same-key equality-equivalent values do
not publish `updated` and retain the previous published value identity.

`merge` accepts a fixed definition-time source list with union membership. Conflict
policy is mandatory: `error` rejects overlap, `first` uses the earliest source, `last`
uses the latest source, and `resolve` receives source-priority `{ sourceIndex, value }`
contributions only when at least two sources currently contain the key. A single
contribution passes through unchanged. Equality compares the final effective value.

Formal order is always:

```text
stableUnique(S0.ids() ++ S1.ids() ++ ... ++ Sn.ids())
```

Position and value winner are independent. With `[base, overrides]` and `last`, shared
keys keep their base position while override values win; override-only keys are included
as union members. Removing an override while base still contains the key is an update or
no-op, not a remove/add lifecycle. This preserves `runtime.items(merged)` item identity
through winner changes. Value-only source updates recompute only affected keys and do not
rebuild formal order; membership/order changes rebuild the stable merged order once.
Membership uses `has(key)`, so present `undefined` remains valid.

Membership-changing keyed derives are also first-class:

```ts
const visible = derive.keyed.filter(fields, field => field.visible);
const ordered = derive.keyed.subset(fields, visibleFieldIds);
const content = derive.keyed.compact(cards, card => card.content);
const bySection = derive.keyed.groupBy(records, record => record.sectionId);
const activeCollection = derive.keyed.singleton(activeRecord, record => record.id);
```

`filter` preserves source values and source-relative order. `subset` uses
`orderedKeys ∩ source.keys` with orderedKeys order; missing requested keys are latent
and appear if the source later adds them, while duplicate ordered keys are invalid.
`compact` treats selected `undefined` as absence and applies optional per-entry equality
to present values. `filter` and `compact` reuse the normal named dependency and dynamic
keyed lookup protocol. `groupBy` is the one-to-many reverse-index primitive: a source
entry may belong to one or several groups and bucket members follow source order. Group
keys are ranked by the earliest current source member that belongs to them; when several
groups first appear on the same source member, they follow that member's selector-result
order. Source membership/order changes may therefore reorder group keys. `singleton`
converts an optional scalar projection to a zero-or-one keyed projection.

Dynamic keyed dependencies declare how one output key selects a key from another
keyed projection:

```ts
const cardContent = derive.keyed(
  items,
  {
    metadata: { source: itemMetadata },
    record: { source: records, key: item => item.recordId },
    related: { source: records, keys: item => item.relatedRecordIds },
    view: activeView,
    fields: visibleFields,
  },
  (item, itemId, { metadata, record, related, view, fields }) =>
    renderCard(itemId, item, metadata, record, related, view, fields)
);
```

`{ source }` is the same-key form: the driver key directly selects the source entry.
It requires `DriverKey extends SourceKey`, so branded key domains stay type-safe, and
the Runtime can route a source-key change directly to the identical driver key without
maintaining a relation map. `{ source, key }` owns a mapped singular binding and reverse
index. Missing selected entries resolve to `undefined` but remain bound so a later add
invalidates the dependent output. A plain projection dependency such as `view`
invalidates the driver key set when it changes. `{ source, keys }` declares an ordered
duplicate-free set of keyed dependencies and resolves to a readonly map of currently
present selected entries. Changes to one selected source key invalidate only the
relevant driver keys; source order-only changes do not invalidate keyed lookups.

This is the dynamic join protocol. Do not add a second join abstraction or a
document-specific wildcard path grammar to processors.

## Document sources

`observe(document)` creates a whole-document source. A schema path selects a finer
source:

```ts
const title = observe(document, path => path.title);
const rows = observe(document, path => path.rows);
```

`map`, `table` and `list(field, { keyOf })` paths produce keyed collection
projections. List identity comes from `keyOf`, never the array index. Atomic
array-valued fields remain scalar values.

Tree structure uses the same source model:

```ts
const rootId = observe(document, path => path.outline.rootId);
const nodes = observe(document, path => path.outline.nodes);
const node = observe(document, path => path.outline.nodes.item(nodeId));
```

`rootId` is scalar, `nodes` is keyed, and `item(id)` is a single-node value
source. One document commit settles all affected projection sources in one causal
batch.

`observe(readable)` adapts a Doxum `Readable<T>`. Exported
`ExternalValueSource<T>` and `ExternalCollectionSource<K,V>` provide adapter
boundaries for eventful external systems. External collection invalidation hints
are normalized into the same exact projection `CollectionChange`.

## Runtime lifecycle

```ts
const runtime = createProjectionRuntime({ onError: reportProjectionError });

const value = runtime.read(visible);
const selected = runtime.select(visible, rows => rows.get(taskId), equality);

const stop = selected.subscribe(() => {
  selected.current();
});

runtime.update(mode, 'open');

runtime.batch(
  () => {
    runtime.update(mode, 'all');
    document.update(draft => {
      draft.title = 'Updated';
    });
  },
  { cause: { action: 'refresh' } }
);

stop();
runtime.dispose();
```

Stable verbs:

| API                                        | Meaning                                                         |
| ------------------------------------------ | --------------------------------------------------------------- |
| `read(projection)`                         | Read the current published value synchronously.                 |
| `select(projection, selector?, equality?)` | Create a standard `Readable`.                                   |
| `items(keyedProjection)`                   | Create a Runtime-owned keyed Readable family.                   |
| `update(input, value)`                     | Write an `Input<T>`.                                            |
| `update(collectionInput, draft => ...)`    | Atomically edit keyed Runtime-local state.                      |
| `batch(run, options?)`                     | Defer graph settlement/listeners across one application action. |
| `scope()`                                  | Create a local projection lifetime.                             |
| `dispose()`                                | Release Runtime-owned materialization and attachments.          |

A Runtime batch does not delay document commits or document listeners. Projection
readers inside the batch see the last published projection state until settlement.
Processors settle before external projection listeners. Writes are forbidden during
processing/notification.

`ProjectionError` exposes stable `phase` and `cause` fields. Producer names, revision
arrays and scheduler topology remain Runtime diagnostics rather than public API.

For keyed consumer identity, `runtime.items(projection)` returns `{ keys, get }`.
`keys` is an ordered-membership Readable. `get(key)` returns one stable
`Readable<V | undefined>` for the duration of that published membership. A remove
publishes `undefined` and retires that generation; re-adding the same key creates a new
Readable identity. Subscribed missing keys remain latent and can activate on a later add.
The family owns one source subscription and is disposed with its Runtime or scope.

## Runtime-local keyed state

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

The borrowed draft exposes `get`, `has`, `set` and `remove`, and expires when the
synchronous callback returns. A throwing callback applies none of that edit. Per-entry
equality is evaluated against the staged edit before Runtime-local state is installed;
if equality throws, neither the published value nor the next draft is partially updated.
`set` preserves an existing key position and appends a new key.

The optional equality is per entry and defaults to `Object.is`. Setting an existing
key to an equal value is a no-op: no stored replacement, revision, change or
listener publication occurs. Accepted edits publish exact net keyed transitions and
order.

`input.collection` is application/UI state owned by the projection Runtime. It is
outside canonical document state, history and persistence.

## Scope

```ts
const scope = runtime.scope();

const localMode = scope.own(input<'all' | 'open'>('all'));
const localVisible = scope.own(
  derive({ tasks, mode: localMode }, ({ tasks, mode }) =>
    mode === 'all' ? tasks : filterOpen(tasks)
  )
);

scope.read(localVisible);
scope.update(localMode, 'open');
scope.dispose();
```

A scope shares its parent Runtime's scheduler and root materialization. `scope.own`
assigns lifecycle ownership to a projection definition or a static nested tree of
projection leaves such as an `incremental.group` result. Scalar/keyed inputs, derives and
advanced definitions use that same ownership protocol. Scoped definitions may depend on
root definitions; root or sibling scopes cannot depend on a scoped definition. One
definition can belong to only one scope, and ownership must be assigned before the
definition is first materialized as a root.

## Collection values and changes

Keyed projections expose immutable `ReadonlyMap` values. Unchanged entries preserve
their references.

Every keyed projection source/output uses one change algebra:

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

`CollectionChange` is exported by `doxum/advanced` for processor typing; root projection
consumers work with `Projection`, `KeyedProjection`, `CollectionInput` and immutable
`ReadonlyMap` values.

`collectionChange.keys(change)` accepts an incremental change and lazily yields added,
updated and removed keys in that order. It does not interpret reset, does not expand an
order change into all keys, and does not define business-level "touched" semantics.

Initial materialization and source reset report `reset` to advanced processors.
Incremental transitions are net changes across the settled batch.

`CollectionImpact` belongs to the document domain and is only an invalidation hint.
It is not the projection change protocol.

## Advanced processors

Import advanced processors from `doxum/advanced`. Use them only when retained state,
cross-key indexes, or direct incremental patching cannot be expressed cleanly by
`derive` / the `derive.keyed` family.

All advanced processors take named dependencies plus a closed definition object.
`process()` is required and synchronous. `state()` is optional and creates Runtime-owned
retained state only when the processor needs it.

### Value processor

```ts
const total = incremental(
  { tasks },
  {
    state: () => ({ runs: 0 }),
    process: ({ values, previous, state, reset }) => {
      state.runs++;
      return values.tasks.size + state.runs + (reset ? 0 : (previous ?? 0));
    },
  }
);
```

Context fields are values, changes, previous, reset and cause. When `state()` is
declared, the context additionally contains its precisely inferred `state`.

### Collection processor

```ts
const doubled = incremental.collection(
  { tasks },
  {
    process: ({ values, changes, output, reset }) => {
      if (reset) {
        for (const [id, task] of values.tasks) {
          output.set(id, task.value * 2);
        }
        output.order([...values.tasks.keys()]);
        return;
      }

      const change = changes.tasks;
      if (!change || change.kind === 'reset') return;

      for (const entry of change.added) {
        output.set(entry.key, entry.after.value * 2);
      }
      for (const entry of change.updated) {
        output.set(entry.key, entry.after.value * 2);
      }
      for (const entry of change.removed) {
        output.remove(entry.key);
      }
      if (change.order) output.order([...values.tasks.keys()]);
    },
  }
);
```

Collection context additionally exposes previous, next and a borrowed output draft.
The draft has set, remove and order.

### Keyed processor

`incremental.keyed(driver, dependencies, definition)` is the retained-state counterpart
to `derive.keyed`. The driver exclusively owns output membership and order, while each
driver membership owns independent retained state:

```ts
const sectionTotals = incremental.keyed(
  sections,
  {
    records: { source: records, keys: section => section.recordIds },
  },
  {
    state: () => ({ runs: 0 }),
    process: ({ value, dependencies, state }) => {
      state.runs++;
      return [...dependencies.records.values()].reduce((sum, record) => sum + record.score, 0);
    },
  }
);
```

Ordinary scalar dependencies invalidate every current driver key. Singular/plural keyed
dependencies use reverse routing and run only dependent keys. Driver order-only changes
reorder output without executing `process`. Removing a driver key releases its state;
re-adding the same key starts a new membership lifecycle. Reset intersections preserve
state, while processor fault recovery recreates the processor and all per-key state.
The process context is `key`, `value`, named `dependencies`, `reset`, `cause`, and
optional retained `state`; it returns only its own output value and receives no
collection draft.

### Multi-output group

```ts
const render = incremental.group(
  { tasks },
  {
    output: define => ({
      node: {
        shell: define.collection<NodeId, Shell>(),
        content: define.collection<NodeId, Content>(),
      },
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, output, state }) => {
      state.runs++;
      for (const [id, task] of values.tasks) {
        output.node.shell.set(id, makeShell(task));
        output.node.content.set(id, makeContent(task));
      }
      output.count.set(values.tasks.size);
    },
  }
);
```

define.collection<K,V>(equality?) and define.value<T>(equality?) are only available
inside output. The declaration returns a non-empty static object tree and each
descriptor must appear exactly once. The result has the same shape with normal
projection leaves backed by one producer: collection descriptors become
`KeyedProjection<K,V>` and value descriptors become `Projection<T>`.

The advanced entry also exports `IncrementalGroupOutput` and `IncrementalGroupResult`
as declaration-safe type boundaries. Normal callers do not annotate them; they exist so
inferred group results remain nameable when another package emits `.d.ts` files.

On initial materialization or Runtime recovery every value leaf must be set. During
ordinary incremental evaluation, untouched value leaves retain their published
value. Equal set results do not publish.

values and changes are keyed by dependency name. Collection dependencies receive
exact CollectionChange metadata; scalar dependencies have undefined change
metadata.

A normal source reset requests reconciliation and preserves retained processor state
when one is declared. Processor faults are owned by the Runtime: recovery recreates
declared state and runs a reset evaluation. Stateless processors follow the same reset
path without a state object. There is no public rebuild token or manual recovery protocol.

## React

doxum/react consumes only public Core capabilities:

```tsx
<ProjectionProvider value={runtime}>
  <TaskList />
</ProjectionProvider>;

function TaskList() {
  const task = useProjection(tasks, rows => rows.get(taskId), equality);
  const [mode, setMode] = useInput(filter);
  const [selection, updateSelection] = useInput(selectionInput);
}
```

ProjectionProvider accepts ProjectionRuntime or ProjectionScope.
useProjection(projection, selector, equality?) uses Core keyed selector tracking.
useInput overloads scalar and collection inputs. Collection updates receive a
CollectionInputDraft.

Document selection remains independent of ProjectionProvider:

```ts
const result = useDocumentSelector(document, selector, equality);
```

This is a React adapter over Core select(document, selector, equality).

## Ownership rules

- ProjectionRuntime is the only owner of materialized projection state.
- Processor dependencies are explicit declarations.
- ProjectionScope owns only its local lifetime.
- Document path grammar stays at document/source boundaries.
- One keyed CollectionChange protocol is used by all projection collections.
- Recovery is a Runtime lifecycle concern.
- React consumes Readable, document select, and projection Runtime APIs only.
