# Doxum Public API

This is the canonical consumer-facing API reference for the published package. Use it instead of implementation source. The type snippets intentionally omit private brands and internal helper types while preserving the public call shape and lifecycle-relevant fields.

## Package entry points

| Package            | Owns                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `doxum`            | schemas, canonical document runtime, reads/subscriptions, history/impact, projections, external projection sources |
| `doxum/advanced`   | retained/incremental processors and processor-facing `CollectionChange`                                            |
| `doxum/react`      | React adapters for document/projection/readable/history APIs                                                       |
| `doxum/local-sync` | IndexedDB durability and browser leader/follower coordination                                                      |

Application imports must come from these package entry points only.

## `doxum`

### Public symbol inventory

<!-- exports:doxum:start -->

| Public export              | Role                                                    |
| -------------------------- | ------------------------------------------------------- |
| `field`                    | Atomic payload schema                                   |
| `optional`                 | Optional schema member wrapper                          |
| `object`                   | Fixed object schema                                     |
| `variant`                  | Tagged object-union schema                              |
| `table`                    | Ordered keyed entity schema                             |
| `map`                      | Dynamic keyed record schema                             |
| `list`                     | Ordered keyed atomic-item schema                        |
| `tree`                     | Empty-or-single-root tree schema                        |
| `DocumentAddress`          | Schema address type                                     |
| `DocumentAnchor`           | Ordered move/create anchor                              |
| `DocumentListConfig`       | List `keyOf` config                                     |
| `DocumentTreeNode`         | Tree node value type                                    |
| `DocumentTreeValue`        | Whole tree value type                                   |
| `Schema`                   | Portable schema handle                                  |
| `ObjectSchema`             | Portable root object schema handle                      |
| `Infer`                    | Infer schema data type                                  |
| `ReadonlyValue`            | Deep readonly payload view                              |
| `Validator`                | Synchronous validator contract                          |
| `SchemaPath`               | Typed symbolic path root                                |
| `PathValueOf`              | Infer symbolic path value                               |
| `parse`                    | Validate/copy unknown input into schema data            |
| `ParseError`               | Parse failure class                                     |
| `ParseIssue`               | Parse issue type                                        |
| `snapshot`                 | Convert borrowed access to durable readonly value       |
| `replace`                  | Replace object/variant member with plain inferred value |
| `Read`                     | Borrowed readonly schema access type                    |
| `Draft`                    | Borrowed writable schema access type                    |
| `Change`                   | Document change union                                   |
| `ChangeSet`                | Normalized reversible document change set               |
| `MemberChange`             | Added/updated/removed member transition                 |
| `ValueTransition`          | Generic added/updated/removed transition                |
| `CollectionImpact`         | Collection impact summary                               |
| `DocumentImpact`           | Commit impact query API                                 |
| `createDocument`           | Create canonical document runtime                       |
| `DocumentReentrancyError`  | Reentrant document write/read-lifecycle failure         |
| `DocumentDisposedError`    | Access after document disposal                          |
| `TransactionRejected`      | Expected application-level transaction rejection        |
| `Unsubscribe`              | Subscription cleanup function                           |
| `CommitSource`             | Commit source label                                     |
| `DocumentCommit`           | Accepted commit record                                  |
| `ReadonlyDocument`         | Read/subscription-only document surface                 |
| `TransactionResult`        | `update` result union                                   |
| `OperationResult`          | apply/history/replace result union                      |
| `DocumentRuntime`          | Full document runtime surface                           |
| `HistoryState`             | Undo/redo depth state                                   |
| `LocalHistory`             | Local undo/redo API                                     |
| `DocumentDiagnostic`       | Application rejection issue                             |
| `DocumentProblem`          | Application or mutation issue union                     |
| `ObserverError`            | Post-commit observer failure                            |
| `MutationIssue`            | Engine mutation rejection issue                         |
| `MutationIssueCode`        | Mutation issue code union                               |
| `Readable`                 | Standard revisioned observable value                    |
| `read`                     | One synchronous document selector read                  |
| `select`                   | Document selector `Readable`                            |
| `DocumentSelector`         | Document selector callback type                         |
| `input`                    | Scalar projection input factory                         |
| `observe`                  | Projection source declaration                           |
| `derive`                   | Pure value/keyed derivation family                      |
| `createProjectionRuntime`  | Materialize and own projections                         |
| `ProjectionError`          | Projection source/processor/listener/blocked failure    |
| `ProjectionDisposedError`  | Projection access after disposal                        |
| `Projection`               | Lazy scalar projection handle                           |
| `KeyedProjection`          | Lazy keyed projection handle                            |
| `Input`                    | Writable scalar projection input                        |
| `CollectionInput`          | Writable keyed projection input                         |
| `CollectionInputDraft`     | Borrowed collection-input editor                        |
| `ExternalCollectionEvent`  | External keyed source event                             |
| `ExternalCollectionRead`   | External keyed source snapshot interface                |
| `ExternalCollectionSource` | External keyed projection source                        |
| `ExternalValueEvent`       | External scalar source event                            |
| `ExternalValueSource`      | External scalar projection source                       |
| `ProjectionRuntime`        | Root projection runtime API                             |
| `ProjectionScope`          | Scoped projection lifecycle API                         |
| `ProjectionItems`          | Runtime-owned keyed item readable family                |

<!-- exports:doxum:end -->

### Schema factories

```ts
field<T>(validator?: Validator<T>): Schema<ReadonlyValue<T>>
optional(schema): Schema<... | undefined>
object(shape): ObjectSchema<...>
variant(tag, variants): Schema<tagged union>
map(valueSchema, options?: { key: Validator<K> }): Schema<Readonly<Record<K, V>>>
table(entitySchema, options?: { key: Validator<K> }): Schema<{ ids: readonly K[]; byId: Readonly<Record<K,V>> }>
list(fieldSchema, { keyOf }): Schema<readonly T[]>
tree(fieldSchema): Schema<DocumentTreeValue<T>>
parse(schema, input): Infer<typeof schema>
```

`optional` supports field, variant, map, list, and tree schemas. `table` accepts object/variant entities. `map` accepts field/object/variant values. `list` accepts an atomic field schema and obtains stable identity from `keyOf`. `tree(optional(field(...)))` means node payload may be absent; `optional(tree(...))` means the entire tree member may be absent.

`Validator<T>` is synchronous and either a predicate/assertion function or Standard Schema v1 validator. Successful Standard Schema validation must return the original input by identity; transformed output is not accepted.

### Read/Draft container surface

Object/variant members are properties. Atomic `field` values are readonly and replaced whole. Collection nodes expose methods:

| Container | Read methods                                                   | Draft-only methods                                                                                     |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| map       | `get(id)`, `has(id)`, `ids()`                                  | `put(id,value)`, `remove(id)`, `replace(record)`                                                       |
| table     | `get(id)`, `has(id)`, `ids()`                                  | `create(id,value,anchor?)`, `create(entries,anchor?)`, `remove(id                                      | ids)`, `move(id                                                        | ids,anchor?)`, `reorder(ids)`, `replace(id,value)`, `replace(table)` |
| list      | `get(key)`, `has(key)`, `ids()`                                | `insert(value,anchor?)`, `remove(key)`, `move(key                                                      | keys,anchor?)`, `reorder(keys)`, `replace(key,value)`, `replace(list)` |
| tree      | `rootId()`, `get(id)`, `has(id)`, `parent(id)`, `children(id)` | `insert(id,value,position?)`, `move(id,position?)`, `remove(id)`, `replace(id,value)`, `replace(tree)` |

Ordered anchors are:

```ts
type DocumentAnchor<K extends string = string> =
  { at: 'start' | 'end' } | { before: K } | { after: K };
```

Tree positions are `{ parentId?: string; index?: number }`.

For an object/variant member whose Draft representation contains collection methods, replace it with its plain inferred value through:

```ts
replace(parentDraft, key, plainInferValue): void
```

### Durable values and borrowed values

```ts
snapshot<T>(borrowedOrValue: T): durableReadonlyValue
```

`Read` and `Draft` values are borrowed for the synchronous callback that received them. Do not retain their proxies or collection methods. `snapshot` copies schema-owned structure and shares immutable atomic payload references.

### Canonical document runtime

```ts
const document = createDocument({
  schema,
  initial,
  history?: { capacity?: number } | false,
});
```

Public shape:

```ts
type ReadonlyDocument<S> = {
  revision(): number;
  subscribe(listener: (commit: DocumentCommit<S>) => void): Unsubscribe;
  subscribe(
    pick: PathPick<S> | readonly [PathPick<S>, ...PathPick<S>[]],
    listener: (commit: DocumentCommit<S>) => void
  ): Unsubscribe;
};

type DocumentRuntime<S> = ReadonlyDocument<S> & {
  readonly schema: S;
  readonly(): ReadonlyDocument<S>;
  update<V>(
    run: (draft: Draft<S>) => V,
    options?: { source?: 'local' | 'system'; history?: boolean }
  ): TransactionResult<V, DocumentCommit<S>>;
  apply(
    changes: unknown,
    options:
      | { expectedRevision: number; source?: 'local' | 'system'; history?: boolean }
      | { expectedRevision: number; source: 'remote'; history?: never }
  ): OperationResult<DocumentCommit<S>>;
  replace(
    value: Infer<S>,
    options?: { source?: 'system' | 'remote' }
  ): OperationResult<DocumentCommit<S>>;
  snapshot(): Infer<S>;
  readonly history: LocalHistory<DocumentCommit<S>>;
  dispose(): void;
};
```

`update` is synchronous and atomic. It accepts only non-Promise callback results. `apply` always requires `expectedRevision`. `replace` is a whole-document reset operation.

### Transaction and operation results

```ts
type TransactionResult<V, C> =
  | { status: 'committed'; value: V; commit: C; observerErrors: readonly ObserverError[] }
  | { status: 'unchanged'; value: V; revision: number }
  | { status: 'rejected'; issues: readonly DocumentProblem[]; revision: number };

type OperationResult<C> =
  | { status: 'committed'; commit: C; observerErrors: readonly ObserverError[] }
  | { status: 'unchanged'; revision: number }
  | { status: 'rejected'; issues: readonly MutationIssue[]; revision: number };
```

Throw `new TransactionRejected(issueOrIssues)` inside `update` for expected application rejection. The runtime converts it to `status: 'rejected'`. Any other thrown value rolls back and is rethrown unchanged.

### Commits, ChangeSets, impact, and history

```ts
type DocumentCommit<S> = {
  revision: number;
  source: 'local' | 'system' | 'history' | 'remote';
  changes: ChangeSet;
  impact: DocumentImpact<S>;
};

type ChangeSet = { changes: readonly Change[] };

type Change =
  | {
      kind: 'members';
      at: readonly string[];
      members: readonly MemberChange[];
      order?: { before: readonly string[]; after: readonly string[] };
    }
  | {
      kind: 'tree';
      at: readonly string[];
      before: string | null;
      after: string | null;
      nodes: readonly ({ id: string } & ValueTransition<DocumentTreeNode<unknown>>)[];
    }
  | { kind: 'reset'; before: unknown; after: unknown };
```

Member transitions are exactly one of:

```ts
{
  kind: 'added';
  key: string;
  after: T;
}
{
  kind: 'updated';
  key: string;
  before: T;
  after: T;
}
{
  kind: 'removed';
  key: string;
  before: T;
}
```

`DocumentImpact` provides:

```ts
impact.affects(path => path.some.member): boolean
impact.collection(path => path.some.collection):
  | { kind: 'reset' }
  | { kind: 'incremental'; added: ReadonlySet<K>; removed: ReadonlySet<K>; updated: ReadonlySet<K>; orderChanged: boolean }
```

History:

```ts
type LocalHistory<C> = Readable<{ undoDepth: number; redoDepth: number }> & {
  undo(): OperationResult<C>;
  redo(): OperationResult<C>;
  clear(): void;
  group(): { end(): void; cancel(): OperationResult<C> };
};
```

### Document reads and selectors

```ts
read(document, selector): TResult
select(document, selector, equality?): Readable<TResult>
```

A selector receives borrowed `Read<S>`. `read` executes once. `select` returns a standard `Readable` and dynamically tracks the locations actually read by the selector.

```ts
type Readable<T> = {
  current(): T;
  revision(): number;
  subscribe(listener: () => void): Unsubscribe;
};
```

### Projection declarations

```ts
input<T>(initial: T, equality?): Input<T>
input.collection<K,V>(initial?: ReadonlyMap<K,V>, equality?): CollectionInput<K,V>

observe(document): Projection<Infer<S>>
observe(document, path => collectionPath): KeyedProjection<K,V>
observe(document, path => valuePath): Projection<T>
observe(readable): Projection<T>
observe(externalValueSource): Projection<T>
observe(externalCollectionSource): KeyedProjection<K,V>

derive({ dependencyName: projection, ... }, values => result, equality?): Projection<T>
```

The keyed family:

```ts
derive.keyed(source, (value, key) => result, equality?): KeyedProjection<K,T>
derive.keyed(source, dependencies, (value, key, dependencies) => result, equality?): KeyedProjection<K,T>

derive.keyed.keys(source): Projection<readonly K[]>
derive.keyed.values(source): Projection<readonly V[]>
derive.keyed.entries(source): Projection<readonly (readonly [K,V])[]>
derive.keyed.get(source, keyProjection, equality?): Projection<V | undefined>
derive.keyed.subset(source, orderedKeysOrProjection): KeyedProjection<K,V>
derive.keyed.filter(source, predicate): KeyedProjection<K,V>
derive.keyed.filter(source, dependencies, predicate): KeyedProjection<K,V>
derive.keyed.compact(source, selector, equality?): KeyedProjection<K,T>
derive.keyed.compact(source, dependencies, selector, equality?): KeyedProjection<K,T>
derive.keyed.groupBy(source, selector): KeyedProjection<GroupKey, readonly K[]>
derive.keyed.groupBy(source, dependencies, selector): KeyedProjection<GroupKey, readonly K[]>
derive.keyed.singleton(sourceProjection, keyOf, equality?): KeyedProjection<K,V>
```

Dynamic keyed dependency entries are either ordinary global `Projection`s or:

```ts
{ source: keyedProjection, key: (driverValue, driverKey) => sourceKey | undefined }
{ source: keyedProjection, keys: (driverValue, driverKey) => readonly sourceKey[] }
```

The singular resolved value is `V | undefined`; plural resolves to `ReadonlyMap<K,V>` in the requested key order, including only currently present entries.

### Projection runtime and scope

```ts
const runtime = createProjectionRuntime({
  onError?: (error: ProjectionError) => void,
});
```

```ts
type ProjectionRuntime = {
  read<T>(projection: Projection<T>): T;
  select<T>(projection: Projection<T>): Readable<T>;
  select<T,R>(projection: Projection<T>, selector: (value: T) => R, equality?): Readable<R>;
  items<K,V>(projection: KeyedProjection<K,V>): ProjectionItems<K,V>;
  update<T>(input: Input<T>, value: T): void;
  update<K,V>(input: CollectionInput<K,V>, run: (draft: CollectionInputDraft<K,V>) => void): void;
  batch<T>(run: () => T, options?: { cause?: unknown }): T;
  scope(): ProjectionScope;
  dispose(): void;
};

type ProjectionScope = ProjectionRuntime-like surface & {
  own<P extends Projection<unknown>>(projection: P): P;
  own<T extends nested projection tree>(tree: T): T;
};

type ProjectionItems<K,V> = {
  readonly keys: Readable<readonly K[]>;
  get(key: K): Readable<V | undefined>;
};

type CollectionInputDraft<K,V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  remove(key: K): void;
};
```

### External projection sources

```ts
type ExternalValueSource<T> = {
  kind: 'value';
  current(): T;
  revision(): number;
  subscribe(listener: (event: ExternalValueEvent<T>) => void): Unsubscribe;
};

type ExternalValueEvent<T> = {
  value: T;
  revision: number;
  reset?: boolean;
  cause?: unknown;
};

type ExternalCollectionRead<K, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
};

type ExternalCollectionSource<K, V> = {
  kind: 'collection';
  current(): ExternalCollectionRead<K, V>;
  revision(): number;
  subscribe(listener: (event: ExternalCollectionEvent<K, V>) => void): Unsubscribe;
};

type ExternalCollectionEvent<K, V> = {
  previous: ExternalCollectionRead<K, V>;
  revision: number;
  impact?: CollectionImpact<K>;
  cause?: unknown;
};
```

The external collection event carries the stable previous read and may provide an impact hint. Doxum resolves the exact processor-facing collection change before processors consume it.

### Public error classes

| Error                     | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `ParseError`              | `parse` rejected unknown input; inspect `.issues`.                                       |
| `TransactionRejected`     | Expected application rejection thrown inside `update`; runtime returns rejected result.  |
| `DocumentReentrancyError` | Operation violates document reentrancy rules.                                            |
| `DocumentDisposedError`   | Document accessed after disposal.                                                        |
| `ProjectionError`         | Projection `phase` is `processor`, `listener`, `source`, or `blocked`; inspect `.cause`. |
| `ProjectionDisposedError` | Projection Runtime/scope access after disposal.                                          |

`MutationIssueCode` values are:
`invalid-address`, `invalid-value`, `invalid-key`, `invalid-changes`, `baseline-mismatch`, `required-field`, `invalid-anchor`, `duplicate-entity`, `missing-entity`, `invalid-collection`, `invalid-list-keys`, `invalid-list-key`, `duplicate-list-item`, `missing-list-item`, `invalid-tree`, `duplicate-tree-node`, `missing-tree-parent`, `invalid-tree-index`, `missing-tree-node`, `tree-cycle`.

## `doxum/advanced`

Use this package only for retained or directly incremental processing that ordinary public derive primitives cannot express.

### Public symbol inventory

<!-- exports:doxum/advanced:start -->

| Public export                     | Role                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `IncrementalValueContext`         | Value processor context type                              |
| `IncrementalValueDefinition`      | Value processor definition type                           |
| `IncrementalCollectionContext`    | Collection processor context type                         |
| `IncrementalCollectionDefinition` | Collection processor definition type                      |
| `IncrementalKeyedContext`         | Per-driver-key processor context type                     |
| `IncrementalKeyedDefinition`      | Per-driver-key processor definition type                  |
| `IncrementalGroupOutput`          | Group output declaration token type                       |
| `IncrementalGroupResult`          | Group declaration-to-projection-tree result type          |
| `IncrementalGroupContext`         | Multi-output processor context type                       |
| `incremental`                     | Value/collection/keyed/group incremental processor family |
| `collectionChange`                | Helpers for incremental collection changes                |
| `CollectionChange`                | Processor-facing keyed change transport type              |

<!-- exports:doxum/advanced:end -->

### `CollectionChange`

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

collectionChange.keys(incrementalChange): Iterable<K>
```

`collectionChange.keys` yields added, then updated, then removed transition keys. It accepts only an incremental change and does not interpret reset or order changes.

### Incremental value

```ts
incremental(
  dependencies,
  {
    state?: () => State,
    process: ({ values, changes, previous, reset, cause, state? }) => T,
  }
): Projection<T>
```

### Incremental collection

```ts
incremental.collection(
  dependencies,
  {
    state?: () => State,
    process: ({ values, changes, previous, next, output, reset, cause, state? }) => void,
  }
): KeyedProjection<K,V>
```

`output` provides `set(key,value)`, `remove(key)`, and `order(ids)`.

### Incremental keyed

```ts
incremental.keyed(
  driver,
  dependencies,
  {
    state?: (driverValue, driverKey) => State,
    equality?: (previous, next) => boolean,
    process: ({ key, value, dependencies, reset, cause, state? }) => result,
  }
): KeyedProjection<DriverKey,Result>
```

The driver owns output membership/order. Each output key has an independent membership lifecycle and optional retained state.

### Incremental group

```ts
incremental.group(
  dependencies,
  {
    output: define => ({
      someCollection: define.collection<K,V>(equality?),
      someValue: define.value<T>(equality?),
    }),
    state?: () => State,
    process: ({ values, changes, previous, next, output, reset, cause, state? }) => void,
  }
): same-shaped projection tree
```

Every declared output must be returned from the static output tree exactly once.

## `doxum/react`

### Public symbol inventory

<!-- exports:doxum/react:start -->

| Public export         | Role                                               |
| --------------------- | -------------------------------------------------- |
| `ProjectionProvider`  | Provide a `ProjectionRuntime` or `ProjectionScope` |
| `useDocumentSelector` | React adapter for Core document `select`           |
| `useReadable`         | Subscribe to any Doxum `Readable`                  |
| `useHistory`          | Read history state and expose undo/redo callbacks  |
| `useProjection`       | Read projection or projection selector             |
| `useInput`            | Read/update scalar or collection projection input  |

<!-- exports:doxum/react:end -->

```ts
<ProjectionProvider value={runtimeOrScope}>...</ProjectionProvider>

useProjection(projection): T
useProjection(projection, selector, equality?): R
useInput(input): readonly [T, (value: T) => void]
useInput(collectionInput): readonly [ReadonlyMap<K,V>, (edit: (draft: CollectionInputDraft<K,V>) => void) => void]
useDocumentSelector(document, selector, equality?): R
useReadable(readable): T
useHistory(history): HistoryState & { undo(): OperationResult<C>; redo(): OperationResult<C> }
```

## `doxum/local-sync`

### Public symbol inventory

<!-- exports:doxum/local-sync:start -->

| Public export             | Role                                                |
| ------------------------- | --------------------------------------------------- |
| `attachLocalSync`         | Attach browser persistence/leadership to a document |
| `AttachLocalSyncOptions`  | Attach options type                                 |
| `LocalSync`               | Attached sync handle                                |
| `LocalSyncState`          | Leader/follower/error/disposed state union          |
| `LocalSyncError`          | Operational local-sync error class                  |
| `LocalSyncErrorCode`      | Local-sync error code union                         |
| `defaultJsonChangeLimits` | Resolved default admission limits                   |
| `JsonChangeLimits`        | Configurable local-commit limits                    |
| `JsonPrimitive`           | JSON primitive type                                 |
| `JsonValue`               | Recursive JSON value type                           |

<!-- exports:doxum/local-sync:end -->

```ts
const sync = await attachLocalSync({
  runtime: document,
  database: 'app',
  documentId: 'document:1',
  schemaVersion?: 1,
  changeLimits?: {
    maxChanges?: number,
    maxBytes?: number,
    maxDepth?: number,
    maxStringLength?: number,
  },
  onError?: error => {},
});
```

```ts
type LocalSync = {
  readonly state: Readable<LocalSyncState>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

type LocalSyncState =
  | { status: 'leader' | 'follower'; headSeq: number; checkpointSeq: number }
  | { status: 'error'; headSeq: number; checkpointSeq: number; error: LocalSyncError }
  | { status: 'disposed' };
```

`LocalSyncErrorCode` is one of `unavailable`, `schema-mismatch`, `consistency`, `read-only`, `unsupported-operation`, `disposed`, `invalid-data`.
