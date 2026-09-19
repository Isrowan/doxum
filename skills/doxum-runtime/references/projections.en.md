# Projection Reference

For exact signatures, use the [API reference](api.en.md). This document explains
ownership, invalidation and recovery.

## Ownership and basic declarations

Projection definitions are lazy. Root definitions are reusable across runtimes;
scope definitions belong to one `ProjectionScope`. A public `Projection<T>` contains
no materialized value, state, subscription or disposal state.

```ts
const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');
const visible = derive({ tasks, filter }, ({ tasks, filter }) =>
  filter === 'all' ? tasks : filterOpen(tasks)
);

const runtime = createProjectionRuntime({ onError: report });
runtime.read(visible);
```

`ProjectionRuntime` is the single owner of materialization, retained state, source
attachments, settlement, publication and recovery. Its stable verbs are `read`,
`select`, overloaded `update`, `batch`, `scope`, and `dispose`.

`input(initial, equality?)` is scalar Runtime-local state. `input.collection(initial?,
equality?)` is keyed Runtime-local application/UI state. Both are outside canonical
document history/persistence.

## Source boundaries

`observe` is the one source declaration entry point. It adapts:

- a whole `ReadonlyDocument` or a schema-path selection;
- a Doxum `Readable<T>`;
- exported external value/collection source contracts.

Document `map`, `table`, and `list(field, { keyOf })` selections are keyed projections.
List identity comes from schema `keyOf`. Atomic array-valued fields remain scalar.

Trees reuse the same source model:

```ts
const rootId = observe(document, path => path.outline.rootId);
const nodes = observe(document, path => path.outline.nodes);
const node = observe(document, path => path.outline.nodes.item(nodeId));
```

`rootId` is scalar, `nodes` is keyed, and `item(id)` is one node value. A document
commit settles all affected source projections in one Runtime causal batch.

External collection impact is only a boundary invalidation hint. The Runtime derives
the exact `CollectionChange` before processors observe it.

## Pure derive and keyed projection

`derive(dependencies, compute, equality?)` always takes a named dependency object.
Dependencies are explicit and fixed when the definition is created.

Use `derive.keyed` when one keyed driver owns output membership and order:

```ts
const fieldValues = derive.keyed(records, record => record.values[fieldId]);
```

Only affected driver entries execute the selector. Per-entry equality suppresses an
`updated` output transition when the selected value is unchanged. Added, removed and
order transitions retain their normal collection meaning.

Dynamic keyed lookups stay in the same API:

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

A plain Projection dependency invalidates the driver key set when it changes.
`{ source, key }` declares an output-key → dynamic source-key dependency. The Runtime
owns forward bindings and reverse invalidation. Missing selected entries remain bound,
so adding that source key later invalidates its dependents.

This is the keyed join protocol. Do not add a second join abstraction, wildcard
document-path grammar, or processor-side imperative dependency discovery.

## Runtime reads, updates and scope

```ts
const value = runtime.read(visible);
const selected = runtime.select(visible, rows => rows.get(rowId), equality);
const stop = selected.subscribe(listener);

runtime.update(filter, 'open');
runtime.update(selection, draft => {
  draft.set(rowId, true);
  draft.remove(previousRowId);
});

runtime.batch(run, { cause });
```

`select` returns the standard `Readable`. Keyed selectors track relevant key/structure
reads; equality filters the result only after a related invalidation.

`CollectionInputDraft` exposes `get`, `has`, `set`, `remove` and expires with the
synchronous edit callback. A throwing callback applies none of that edit. Collection
input equality is per entry and defaults to `Object.is`; equal sets do not replace
stored data or publish.

```ts
const scope = runtime.scope();
const localFilter = scope.own(input<'all' | 'open'>('all'));
const local = scope.own(
  derive({ tasks, filter: localFilter }, ({ tasks, filter }) =>
    filter === 'all' ? tasks : filterOpen(tasks)
  )
);
scope.read(local);
scope.update(localFilter, 'open');
scope.dispose();
```

A scope shares the parent scheduler/materialization owner. `scope.own` assigns one
lifecycle to a projection definition or a static nested projection tree. Scoped
definitions may depend on root definitions; root and sibling scopes cannot depend on
scoped definitions, and one definition can belong to only one scope. Assign scope
ownership before the definition is first materialized as a root.

## One collection change protocol

All keyed projection sources and outputs use:

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

Import `CollectionChange` from `doxum/advanced` when an advanced processor signature
needs it. Root projection consumers do not import this transport type.

Initial materialization and source reset report `reset` to advanced processors.
Incremental transitions are exact net changes across the settled Runtime batch.

## Advanced processors

Import `incremental` from `doxum/advanced` only when retained state, cross-key indexes,
or direct incremental output patching cannot be expressed cleanly with `derive` or
`derive.keyed`.

All advanced processors use named dependencies plus a required `process`. Add `state()`
only when the processor needs retained state:

```ts
const weights = incremental.collection(
  { tasks },
  {
    state: () => ({ initialized: false }),
    process: ({ values, changes, output, state, reset }) => {
      if (reset) {
        for (const [id, task] of values.tasks) output.set(id, task.weight);
        output.order([...values.tasks.keys()]);
        state.initialized = true;
        return;
      }

      const change = changes.tasks;
      if (!change || change.kind === 'reset') return;
      for (const entry of change.added) output.set(entry.key, entry.after.weight);
      for (const entry of change.updated) output.set(entry.key, entry.after.weight);
      for (const entry of change.removed) output.remove(entry.key);
      if (change.order) output.order([...values.tasks.keys()]);
    },
  }
);
```

`values` and `changes` are keyed by dependency name. Scalar dependencies have no
collection change metadata. Collection processors additionally expose keyed
`previous`, `next`, and a borrowed `output` draft.

Multi-output processors use one closed group definition:

```ts
const render = incremental.group(
  { tasks },
  {
    output: define => ({
      shell: define.collection<RowId, Shell>(),
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, output, state }) => {
      state.runs++;
      for (const [id, task] of values.tasks) output.shell.set(id, makeShell(task));
      output.count.set(values.tasks.size);
    },
  }
);
```

`define.collection<K,V>(equality?)` and `define.value<T>(equality?)` are available only
inside `output`. The returned static object tree is mirrored by ordinary Projection
leaves from the same producer. Value leaves must be established on initial build and
Runtime recovery; untouched value leaves keep their value on ordinary incremental runs.

Normal source resets preserve retained state when declared. A processor fault is
recovered by the Runtime: it recreates declared state and performs a reset evaluation.
Stateless processors follow the same recovery path without a state object. No public
rebuild token or manual recovery hook exists.

## React

`ProjectionProvider` supplies a Runtime or scope. `useProjection(projection, selector,
equality?)` uses the same Core selector semantics; `useInput` overloads scalar and
collection inputs. Document reads remain separate:

```ts
const value = useDocumentSelector(document, selector, equality);
```

Processors settle before projection listeners. Writes are forbidden while processing
or notifying. Listener failure does not roll back an accepted document commit.
