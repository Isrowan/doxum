# Public API Reference

Use this as the compact public-contract lookup. For projection lifecycle and examples,
read [projections](projections.en.md); for modeling choices, read the [guide](guide.en.md).

## Package entry points

| Package            | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `doxum`            | schema, canonical document runtime, reads, history, impact, projections |
| `doxum/advanced`   | retained-state and multi-output projection processors                   |
| `doxum/react`      | React adapters over Core capabilities                                   |
| `doxum/local-sync` | IndexedDB persistence and browser leader/follower coordination          |

## `doxum`

### Schema

| API                       | Contract                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| `field<T>(validator?)`    | Atomic payload. Replace whole; payload interior is readonly.           |
| `optional(schema)`        | Optional field/variant/map/list/tree member.                           |
| `object(shape)`           | Fixed declared members; returns opaque `ObjectSchema<T>`.              |
| `variant(tag, variants)`  | Tagged union of object branches.                                       |
| `map(value, { key }?)`    | Dynamic keyed record.                                                  |
| `table(entity, { key }?)` | Ordered keyed object/variant entities stored as `{ ids, byId }`.       |
| `list(field, { keyOf })`  | Ordered array with stable string identity.                             |
| `tree(field)`             | Empty-or-single-root tree; optional field means optional node payload. |
| `parse(schema, input)`    | Validate unknown input and copy schema structure.                      |

Public schema types are `Schema<T>`, `ObjectSchema<T>`, `Infer<S>`, `ReadonlyValue<T>`,
`Validator<T>`, `SchemaPath<S>`, `PathValueOf<P>`, `DocumentAnchor`,
`DocumentListConfig<T>`, `DocumentTreeNode<T>` and `DocumentTreeValue<T>`.
Concrete node representation types are internal.
`Schema` / `ObjectSchema` are declaration-portable handles; downstream packages can
export inferred schema constants directly without `ReturnType` wrappers.

`Validator<T>` is validation-only. A function validator is a predicate/assertion:
`true` or `undefined` succeeds, `false` rejects, and an assertion may throw.
A Standard Schema validator must return the original value by identity on success;
transformed output is rejected. Validators are synchronous and must not mutate input.

Draft collection methods:

| Container | Read                                         | Write                                                                        |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| map       | `get`, `has`, `ids`                          | `put`, `remove`, `replace(next)`                                             |
| table     | `get`, `has`, `ids`                          | `create`, `remove`, `move`, `reorder`, `replace(id,value)`, `replace(next)`  |
| list      | `get`, `has`, `ids`                          | `insert`, `remove`, `move`, `reorder`, `replace(key,value)`, `replace(next)` |
| tree      | `rootId`, `get`, `has`, `parent`, `children` | `insert`, `move`, `remove`, `replace(id,value)`, `replace(next)`             |

`replace(parent, key, value)` replaces one object/variant member with plain `Infer` data.
`document.replace(value)` is a whole-document reset and remains a separate operation.

### Document runtime

```ts
const document = createDocument({ schema, initial, history: { capacity: 100 } });
```

`DocumentRuntime<S>` exposes:

- `schema`, `revision()`, `snapshot()` and `readonly()`;
- `update(run, { source?, history? }?)` for synchronous atomic Draft work;
- `apply(changes, { expectedRevision, source?: 'local' | 'system', history? })`, or
  `apply(changes, { expectedRevision, source: 'remote' })` for remote replay;
- `replace(value, { source? }?)` for a whole-document reset;
- `subscribe(listener)` and `subscribe(path | paths, listener)`;
- `history.undo()`, `redo()`, `clear()`, `group()`;
- `dispose()`.

`document.readonly()` returns `ReadonlyDocument<S>`, which has only `revision()` and
document commit/path subscriptions. It is the capability-stripped document boundary.

`update` returns `TransactionResult`; `apply`, whole-document `replace`, history travel
and group cancellation return `OperationResult`. Result status is `committed`,
`unchanged`, or `rejected`. Throw `TransactionRejected` for expected application
rejection. Ordinary thrown values roll back and rethrow unchanged.

Document errors are `TransactionRejected`, `DocumentReentrancyError` and
`DocumentDisposedError`. Parsing failures use `ParseError` with `ParseIssue` data.

### Reads and subscriptions

| API                                     | Contract                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `read(document, selector)`              | One synchronous borrowed `Read`.                          |
| `select(document, selector, equality?)` | Dynamic read-tracked `Readable<TResult>`.                 |
| `snapshot(value)`                       | Export borrowed schema structure as stable readonly data. |

`Readable<T>` has `current()`, `revision()` and `subscribe(listener)`.
`select` rebinds dependencies when selector control flow changes and suppresses
publication when `equality` reports the selected result unchanged.

A commit has `revision`, `source`, `changes`, `impact`. Public change/impact types include
`ChangeSet`, `Change`, `MemberChange`, `ValueTransition`, `DocumentCommit`,
`DocumentImpact`, `CollectionImpact`, `MutationIssue` and result/diagnostic types.

### Projections

```ts
const mode = input<'all' | 'open'>('all');
const selection = input.collection<RowId, Selection>();
const rows = observe(document, path => path.rows);
const count = derive({ rows }, ({ rows }) => rows.size);
```

| API                                                     | Contract                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `input(initial, equality?)`                             | Runtime-local writable scalar `Input<T>`.                           |
| `input.collection<K,V>(initial?, equality?)`            | Runtime-local keyed `CollectionInput<K,V>` with per-entry equality. |
| `observe(document)`                                     | Whole-document Projection source.                                   |
| `observe(document, path => ...)`                        | Schema-path scalar or keyed Projection source.                      |
| `observe(readable)`                                     | Adapt a Doxum `Readable`.                                           |
| `observe(externalSource)`                               | Adapt exported external value/collection source contracts.          |
| `derive(dependencies, compute, equality?)`              | Pure value Projection with named dependencies.                      |
| `derive.keyed(driver, select, equality?)`               | Preserve driver keys/order and project each entry.                  |
| `derive.keyed(driver, deps, select, equality?)`         | Keyed projection with named global/dynamic keyed dependencies.      |
| `derive.keyed.keys(source)`                             | Ordered key array; value-only updates do not publish.               |
| `derive.keyed.values(source)`                           | Ordered value array following keyed collection order.               |
| `derive.keyed.subset(source, orderedKeys)`              | Keyed subset whose membership/order come from ordered keys.         |
| `derive.keyed.filter(source, predicate)`                | Keyed subset preserving source values and source-relative order.    |
| `derive.keyed.filter(source, deps, predicate)`          | Filter with the standard keyed dependency protocol.                 |
| `derive.keyed.compact(source, select, equality?)`       | Map entries and omit keys whose selected value is `undefined`.      |
| `derive.keyed.compact(source, deps, select, equality?)` | Compact with standard keyed dependencies.                           |

Dynamic keyed dependency syntax is
`{ source: keyedProjection, key: (driverValue, driverKey) => sourceKey | undefined }`.
The Runtime owns output-key to source-key bindings and reverse invalidation. This helper
shape is inferred at the call site; no dedicated public helper type is required.
Keyed selectors keep stable leading arguments: `(value, key)` without extra dependencies
and `(value, key, dependencies)` when the named dependency object is present.

`ProjectionRuntime` exposes:

- `read(projection)`;
- `select(projection)` and `select(projection, selector, equality?)`;
- `update(input, nextValue)` for scalar `Input<T>`;
- `update(collectionInput, draft => ...)` for `CollectionInput<K,V>`;
- `batch(run, { cause? }?)`;
- `scope()`;
- `dispose()`.

`input.collection` draft callbacks and per-entry equality run before accepted local
state is installed. If either throws, the published collection and the next draft both
remain at the pre-update state.

`CollectionInputDraft` exposes `get`, `has`, `set`, `remove`. A throwing edit callback
applies none of that edit. `ProjectionScope` mirrors `read`, `select`, `update`, `batch`,
`dispose` and adds `own(projectionOrTree)` for lifecycle ownership of scalar/keyed inputs,
derives and advanced output trees. One definition can belong to only one scope; call
`own` before that definition is first materialized as a root.

Public projection types are `Projection<T>`, `KeyedProjection<K,V>`, `Input<T>`,
`CollectionInput<K,V>`, `CollectionInputDraft<K,V>`, `ProjectionRuntime`,
`ProjectionScope`, plus the external source/event contracts. All keyed producers return
`KeyedProjection<K,V>`; `CollectionInput<K,V>` is its writable Runtime-local form.
`ProjectionError` exposes only `phase` and `cause`;
`ProjectionDisposedError` represents disposed access.

`filter` and `subset` reuse source values and therefore do not take a second equality.
`compact` owns membership through `undefined` while ordinary `derive.keyed` continues
to preserve every driver key, including when its selected value is `undefined`.

External value sources expose `kind: 'value'`, `current()`, `revision()`, `subscribe()`.
External collection sources expose `kind: 'collection'` plus `get/has/ids` reads and
optional `CollectionImpact` invalidation hints; the adapter derives exact
`CollectionChange` transitions.

## `doxum/advanced`

Use advanced processors only when `derive` / `derive.keyed` cannot express retained
state, cross-key indexes, or direct incremental output patching.

`collectionChange.keys(change)` iterates the added, updated and removed keys of an
incremental `CollectionChange` in that order. It does not interpret reset or order
changes; handle `reset` before calling it.

All advanced functions use named dependencies and a closed definition object.

```ts
const total = incremental(
  { rows },
  {
    state: () => ({ runs: 0 }),
    process: ({ values, changes, previous, reset, cause, state }) => nextValue,
  }
);
```

`incremental.collection(dependencies, { process, state? })` adds keyed `previous`,
`next`, and borrowed `output` with `set`, `remove`, `order`. `state()` is declared only
when retained state is needed; stateless process contexts do not contain `state`.

`incremental.group(dependencies, { output, process, state? })` declares several leaves:

```ts
const view = incremental.group(
  { rows },
  {
    output: define => ({
      cards: define.collection<RowId, Card>(),
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, changes, previous, next, output, reset, cause, state }) => {},
  }
);
```

`define.collection<K,V>(equality?)` and `define.value<T>(equality?)` exist only inside
`output`. The returned static object tree is mirrored with `KeyedProjection<K,V>`
collection leaves and `Projection<T>` value leaves. Every declared descriptor must be
returned exactly once.

Normal source resets preserve retained state when declared. If a processor faults, the
Runtime owns recovery: it recreates declared state and runs a reset evaluation. Stateless
processors use the same recovery path without a state object. There is no public rebuild
token or manual recovery protocol.

Exported advanced APIs include `collectionChange`, the value/collection/group context
and definition types, `CollectionChange`, and the declaration-safe `IncrementalGroupOutput` /
`IncrementalGroupResult` type boundaries. Normal callers infer the latter two; internal
scheduler/output plumbing is not part of the public contract.

## `doxum/react`

| API                                                  | Contract                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `ProjectionProvider`                                 | Provide `ProjectionRuntime` or `ProjectionScope`.              |
| `useProjection(projection)`                          | Read a Projection.                                             |
| `useProjection(projection, selector, equality?)`     | Selected Projection read.                                      |
| `useInput(input)`                                    | Scalar `[value, setValue]` or collection `[map, updateDraft]`. |
| `useDocumentSelector(document, selector, equality?)` | React adapter over Core document `select`.                     |
| `useReadable(readable)`                              | Subscribe to any Doxum `Readable`.                             |
| `useHistory(history)`                                | History state plus `undo` / `redo`.                            |

## `doxum/local-sync`

```ts
const sync = await attachLocalSync({
  runtime: document,
  database: 'app',
  documentId: 'doc:1',
  schemaVersion: 1,
  changeLimits,
  onError,
});
```

`LocalSync` exposes `state: Readable<LocalSyncState>`, `flush()` and async `dispose()`.
Only the leader may write while attached. Whole-document replace and externally supplied
remote apply are unsupported while attached.

`LocalSyncError` is the single public operational error class. Its `code` is one of
`unavailable`, `schema-mismatch`, `consistency`, `read-only`, `unsupported-operation`,
`disposed`, `invalid-data`.
`LocalSyncState` error states carry `LocalSyncError`, and `onError` receives the same
operational error contract. Consumer state-listener exceptions are isolated from sync
fault state and `onError`.

`JsonChangeLimits` contains `maxChanges`, `maxBytes`, `maxDepth`, `maxStringLength`.
`defaultJsonChangeLimits` supplies defaults. Limits admit new local commits only;
durable replay remains readable under smaller current limits.
