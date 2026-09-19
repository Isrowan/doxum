# Public API Reference

Use this as the compact lookup for supported public APIs. The guide and patterns explain
design choices; the projection reference explains incremental behavior.

## Package entry points

| Package            | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `doxum`            | schema, document runtime, reads, history, impact, projections |
| `doxum/advanced`   | retained-state and multi-output projection processors         |
| `doxum/react`      | React adapters                                                |
| `doxum/local-sync` | browser-local persistence and leader/follower coordination    |

## `doxum`

### Schema

| API                       | Contract                                                   |
| ------------------------- | ---------------------------------------------------------- |
| `field<T>(validator?)`    | Atomic payload; replace as one value.                      |
| `optional(node)`          | Optional field/variant/map/list/tree member.               |
| `object(shape)`           | Fixed declared members; extra own properties are rejected. |
| `variant(tag, variants)`  | Tagged union; replace the variant to switch branch.        |
| `map(value, { key }?)`    | Dynamic keyed record.                                      |
| `table(entity, { key }?)` | Ordered keyed entities stored as `{ ids, byId }`.          |
| `list(field, { keyOf })`  | Ordered array with stable string identity.                 |
| `tree(field)`             | Empty-or-single-root tree with reciprocal topology.        |

Common schema types: `Infer`, `ReadonlyValue`, `Validator`, `SchemaPath`,
`PathValueOf`, `DocumentAnchor`, `DocumentTreeNode`, `DocumentTreeValue`, and the
exported `*Node` types. `parse(schema, input)` validates and returns plain `Infer`
data while atomic payload references remain shared and readonly by contract.

Collection Draft methods:

| Container | Read                                         | Write                                                                         |
| --------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| map       | `get`, `has`, `ids`                          | `put`, `remove`, `replace(next)`                                              |
| table     | `get`, `has`, `ids`                          | `create`, `remove`, `move`, `reorder`, `replace(id, value)`, `replace(next)`  |
| list      | `get`, `has`, `ids`                          | `insert`, `remove`, `move`, `reorder`, `replace(key, value)`, `replace(next)` |
| tree      | `rootId`, `get`, `has`, `parent`, `children` | `insert`, `move`, `remove`, `replace(id, value)`, `replace(next)`             |

`replace(parent, key, value)` replaces one object/variant member with its plain `Infer`
value, especially when its Draft contains collection methods. `document.replace(...)`
is different: it resets the whole document.

### Document runtime

```ts
const document = createDocument({ schema, initial, history: { capacity: 100 } });
```

`DocumentRuntime` exposes:

- `revision()` and `snapshot()`;
- `update(run, { source?, history? }?)` for synchronous atomic Draft work;
- `apply(changes, { expectedRevision, source?, history? })`;
- `replace(value, { source? }?)` for a whole-document reset;
- `subscribe(listener)` or `subscribe(path | paths, listener)`;
- `history.undo()`, `redo()`, `clear()`, `group()`;
- `dispose()`.

`update` returns `TransactionResult`; `apply`, whole-document `replace`, history travel,
and group cancellation return `OperationResult`. Handle `committed | unchanged |
rejected`. Throw `TransactionRejected` for expected business rejection inside `update`;
ordinary exceptions roll back and rethrow.

Document/runtime errors are `TransactionRejected`, `DocumentReentrancyError`, and
`DocumentDisposedError`. Parsing failures use `ParseError` with `ParseIssue[]`.

History grouping:

```ts
const group = document.history.group();
// local commits
group.end(); // one undo unit
// or group.cancel();
```

### Read boundaries

| API                                     | Contract                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| `read(document, selector)`              | One synchronous borrowed `Read`.                            |
| `select(document, selector, equality?)` | Dynamic read-tracked `Readable<TResult>`.                   |
| `snapshot(scopedValue)`                 | Convert a borrowed Read/Draft value to plain readonly data. |
| `asReadable(document)`                  | Narrow `DocumentRuntime` to `DocumentReadable`.             |

`Readable<T>` has `current()`, `revision()`, `subscribe(listener)`.

Commits expose `revision`, `source`, `changes`, `impact`. `DocumentImpact` has
`affects(path => ...)` and `collection(path => collectionPath)`; collection impact is
either `reset` or exact `added`, `removed`, `updated`, `orderChanged` facts. Public
boundary types include `ChangeSet`, `Change`, `MemberChange`, `DocumentCommit`,
`DocumentImpact`, `CollectionImpact`, `MutationIssue`, and the result types.

### Projections

```ts
const mode = input('compact');
const overrides = input.collection<string, Override>();
const rows = observe(document, path => path.rows);
const count = derive([rows], rows => rows.size);
```

| API                                             | Contract                                                   |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `input(initial, equality?)`                     | Runtime-local writable scalar.                             |
| `input.collection<K,V>(initial?)`               | Runtime-local writable keyed collection.                   |
| `observe(document)`                             | Whole-document projection.                                 |
| `observe(document, path => ...)`                | Schema-path scalar or keyed collection projection.         |
| `observe(readable)`                             | Adapt a Doxum `Readable`.                                  |
| `observe(externalSource)`                       | Adapt exported external value/collection source contracts. |
| `derive(dependencies, compute, equality?)`      | Pure scalar/aggregate projection.                          |
| `derive.keyed(driver, select, equality?)`       | Preserve driver membership/order and map each entry.       |
| `derive.keyed(driver, deps, select, equality?)` | Named dependencies; selector is `(entry, deps, key)`.      |

A dynamic keyed dependency is a named member
`{ source: keyedProjection, key: (driverValue, driverKey) => sourceKey }`. Missing source
entries resolve to `undefined` but stay bound so a later add invalidates dependents.

`ProjectionRuntime` / `ProjectionScope` expose `get`, `readable`, scalar `set`, keyed
`update`, `batch`, and `dispose`; Runtime also has `scope()`. Keyed `update` drafts expose
`get`, `has`, `set`, `remove`. Scope also owns scoped `input`, `derive`, `incremental`.
`createProjectionRuntime({ onError })` reports `ProjectionError`; disposed scoped
projections raise `ProjectionDisposedError`.

External contracts are exported as `ExternalValueSource/Event` and
`ExternalCollectionSource/Event/Read`. The Runtime converts collection events into the
canonical `CollectionChange` protocol.

An external value source has `kind: 'value'`, `current()`, `revision()`, and
`subscribe(listener)` where events carry `value`, `revision`, optional `reset`/`cause`.
An external collection source has `kind: 'collection'`; `current()` and event `previous`
reads expose `get`, `has`, `ids`, while events carry `revision`, optional `impact` and
`cause`. `KeyedDependency` names the dynamic `{ source, key }` member when an explicit
annotation is useful.

### Public type groups

- Schema: `DocumentAddress`, `DocumentAnchor`, `DocumentListConfig`, `DocumentNode`,
  all `*Node` types, `Infer`, `ReadonlyValue`, `SchemaPath`, `PathValueOf`, `Validator`.
- Access/runtime: `Read`, `Draft`, `Readable`, `DocumentReadable`, `DocumentRuntime`,
  `DocumentSelector`, `CommitSource`, `DocumentCommit`, `HistoryState`, `LocalHistory`,
  `TransactionResult`, `OperationResult`, `ObserverError`, `Unsubscribe`.
- Changes/diagnostics: `ChangeSet`, `Change`, `MemberChange`, `ValueTransition`,
  `DocumentImpact`, `CollectionImpact`, `DocumentDiagnostic`, `DocumentProblem`,
  `MutationIssue`, `MutationIssueCode`, `ParseIssue`.
- Projections: `Projection`, `Input`, `CollectionChange`, `ProjectionRuntime`,
  `ProjectionScope`, `KeyedDependency`, and the external source/event types.

## `doxum/advanced`

Use `incremental` only when `derive` / `derive.keyed` cannot express retained state,
cross-key indexes, or direct keyed patches.

### `incremental(dependencies, processor)`

Produces one value projection. Context fields: `sources`, dependency-aligned `changes`,
`previous`, `reset`, `cause`, `state`. Return the next value.

### `incremental.collection(dependencies, processor)`

Adds `previous`, `next`, `output` for one keyed output. `previous`/`next` expose
`get`, `has`, `ids`; `output` exposes `set`, `remove`, `order`.

### `incremental.group(dependencies, defineOutputs, processor)`

```ts
const render = incremental.group(
  [scene],
  define => ({
    node: {
      shell: define.collection<NodeId, Shell>(),
      content: define.collection<NodeId, Content>(),
    },
    count: define.value<number>(),
  }),
  ({ sources, previous, next, outputs, state, reset, cause, changes }) => {
    // outputs.node.shell/content: set/remove/order
    // outputs.count: set(value)
  }
);
```

`define` is the `incremental.group` declaration callback parameter, not a separate
import. It provides exactly:

- `define.value<T>(equality?)` — scalar output leaf;
- `define.collection<K extends string, V>(equality?)` — keyed collection output leaf.

The declaration synchronously returns a non-empty static plain-object tree. Every
declared leaf must be returned exactly once; descriptors cannot be reused. The result
has the same shape with each leaf replaced by a `Projection`.

The group processor receives the common context fields plus shape-matched `previous`,
`next`, `outputs`. Value output drafts expose `set(value)`; collection output drafts
expose `set`, `remove`, `order`. Initial build/recovery must establish every value leaf;
ordinary incremental runs may leave a value leaf untouched.

Public types include `Incremental*Context`, `Incremental*Processor`,
`IncrementalGroupDefine`, `IncrementalGroupOutputTree`, `GroupProjections`, and
`CollectionChange`.

## `doxum/react`

| API                                                     | Contract                                             |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `ProjectionProvider`                                    | Provides a `ProjectionRuntime` or `ProjectionScope`. |
| `useProjection(projection)`                             | Read a projection value.                             |
| `useProjection(projection, selector, equality?)`        | Selected projection read.                            |
| `useInput(input)`                                       | `[value, setValue]` for a scalar input.              |
| `useDocumentSelector(document, selector, { isEqual? })` | React adapter over Core `select`.                    |
| `useReadable(readable)`                                 | Subscribe to any Doxum `Readable`.                   |
| `useHistory(history)`                                   | History state plus `undo` / `redo`.                  |

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

`LocalSync` exposes `state: Readable<LocalSyncState>`, `flush()`, async `dispose()`.
State is `leader`, `follower`, `error`, or `disposed`; active states include `headSeq`
and `checkpointSeq`. Only the leader writes while attached. Whole-document replace and
externally supplied remote apply are unsupported while attached.

`JsonChangeLimits` has `maxChanges`, `maxBytes`, `maxDepth`, `maxStringLength`;
`defaultJsonChangeLimits` is `{ maxChanges: 1000, maxBytes: 1_000_000, maxDepth: 64,
maxStringLength: 256_000 }`. `schemaVersion` defaults to `1`. Limits admit new local
commits only; durable replay does not reapply them. The environment must provide
IndexedDB, Web Locks and BroadcastChannel; persisted values must be JSON-compatible.

Operational errors: `LocalSyncUnavailableError`, `LocalSyncSchemaError`,
`LocalSyncConsistencyError`, `LocalSyncReadOnlyError`,
`LocalSyncUnsupportedOperationError`, `LocalSyncDisposedError`, `LocalSyncDataError`.
