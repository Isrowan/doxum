# Doxum Integrations

Use this reference for standard `Readable` integration, external projection sources, React bindings, and browser local-sync. Core document/projection semantics live in [Document runtime](document-runtime.md) and [Projections](projections.md); exact signatures are in [Public API](public-api.md).

## Standard `Readable`

Doxum exposes one small observable contract:

```ts
type Readable<T> = {
  current(): T;
  revision(): number;
  subscribe(listener: () => void): () => void;
};
```

`select(document, ...)`, `runtime.select(...)`, `runtime.items(...).keys`, item readables, history, and local-sync state all use this contract. Subscription listeners receive no payload; read the current value with `current()`.

Consumer listener failure does not retroactively roll back the source mutation that caused the notification.

## External value sources

Adapt a non-Doxum scalar source through `ExternalValueSource<T>` and then call `observe(source)`:

```ts
const source: ExternalValueSource<Theme> = {
  kind: 'value',
  current: () => currentTheme,
  revision: () => revision,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const theme = observe(source);
```

Publish events with `{ value, revision, reset?, cause? }`. The source owns its revision and stable current value. `reset` marks a reset boundary rather than ordinary incremental continuation.

External source callbacks are synchronous from Doxum's perspective. Do not expose an async `current()` or Promise-valued event.

## External keyed collection sources

Use the external collection contract when the source itself has keyed membership/order and can provide stable snapshots:

```ts
const source: ExternalCollectionSource<RowId, Row> = {
  kind: 'collection',
  current: () => ({
    get: id => rows.get(id),
    has: id => rows.has(id),
    ids: () => orderedIds,
  }),
  revision: () => revision,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
```

An event carries the stable read from before the external update/batch:

```ts
listener({
  previous,
  revision: nextRevision,
  impact?: {
    kind: 'incremental',
    added: new Set<RowId>(),
    removed: new Set<RowId>(),
    updated: new Set<RowId>(),
    orderChanged: false,
  },
  cause,
});
```

`impact` is an invalidation hint, not the processor-facing final change. Doxum reads the current source and normalizes source state into exact `CollectionChange` semantics before processors consume it. Use reset impact when the adapter cannot provide a trustworthy incremental hint.

The `previous` read must remain stable for that event/external batch. Do not back it with mutable data that changes underneath the event.

## React ownership

React consumes Doxum through `doxum/react` only. Do not duplicate Runtime subscriptions or reach into projection internals from components.

### Projection provider

```tsx
const runtime = useMemo(() => createProjectionRuntime({ onError: report }), []);

return (
  <ProjectionProvider value={runtime}>
    <App />
  </ProjectionProvider>
);
```

The provider accepts a root `ProjectionRuntime` or `ProjectionScope`. The component/service that creates it owns disposal. Do not create a new Runtime on every render.

### Reading projections

```tsx
const rows = useProjection(visibleRows);
const active = useProjection(rowsProjection, rows => rows.get(activeId));
```

Selector form reuses Core projection selector semantics, including keyed read tracking and optional result equality.

For stable per-membership item `Readable`s, use `runtime.items` / `scope.items` outside ad-hoc component caches and consume individual readables with `useReadable`.

### Projection inputs

```tsx
const [filter, setFilter] = useInput(filterInput);

const [selection, editSelection] = useInput(selectionInput);
editSelection(draft => {
  draft.set(rowId, true);
});
```

`useInput` writes through the provided Runtime/scope. The input definition must belong to that owner. Scalar setter arguments are always values, including functions; they do not use React's updater-function convention. Collection edit callbacks must be synchronous. For compound domain commands, call the Core Runtime/scope's `batch(() => ...)` and use ordinary `read`. Imperative reads can advance derived values before notifications drive the next React render. Do not implement a React-side source mirror or per-child flatMap cache.

### Document selectors

Document state does not require a `ProjectionProvider`:

```tsx
const title = useDocumentSelector(document, read => read.title);
```

This is the React adapter for Core document `select`; dependency tracking remains owned by Core.

### Generic Readable and history

```tsx
const value = useReadable(readable);
const history = useHistory(document.history);
```

`useHistory` returns current `undoDepth` / `redoDepth` plus `undo()` and `redo()` callbacks.

## Local sync

`doxum/local-sync` owns browser-local durability and leader/follower coordination for one `DocumentRuntime`:

```ts
const sync = await attachLocalSync({
  runtime: document,
  database: 'my-app',
  documentId: 'doc:123',
  schemaVersion: 1,
  changeLimits,
  onError: reportSyncError,
});
```

This boundary is intentionally local-browser only. It does not define network transport, authorization, server conflict resolution, distributed clocks, or collaborative undo.

### Leader/follower behavior

`sync.state` is a `Readable<LocalSyncState>`. Normal states are `{ status: 'leader' | 'follower', headSeq, checkpointSeq }`. Only the leader may author document writes while attached; followers replay durable contiguous sequence.

Error state carries `LocalSyncError`; disposal publishes `{ status: 'disposed' }`.

### Visibility and durability

Local writes become visible in the document runtime before asynchronous persistence completes. `await sync.flush()` waits until currently accepted local work is durable according to the local-sync contract. It is not a network acknowledgement.

### Unsupported attached operations

While local-sync owns the attached runtime boundary, whole-document external replacement and external remote-marked apply are unsupported. Keep collaboration/network ingestion at a separate owner.

### Storage compatibility

`schemaVersion` identifies the application storage schema version used for the attached document. A schema mismatch is an operational error; local-sync does not silently migrate unknown old storage. Perform migration explicitly before attaching the new runtime format.

### Admission limits

`JsonChangeLimits` controls new local commit admission:

```ts
{
  maxChanges?: number;
  maxBytes?: number;
  maxDepth?: number;
  maxStringLength?: number;
}
```

`defaultJsonChangeLimits` provides resolved defaults. These limits govern newly authored local commits. Previously admitted durable records remain replayable under smaller current limits while their JSON/ChangeSet structure is still validated.

### Local-sync errors

`LocalSyncErrorCode` values are:

- `unavailable`
- `schema-mismatch`
- `consistency`
- `read-only`
- `unsupported-operation`
- `disposed`
- `invalid-data`

`onError` receives the same `LocalSyncError` type used by the error state. A consumer exception thrown while observing `sync.state` is a consumer failure; it does not become local-sync fault state.

### Disposal

```ts
await sync.dispose();
```

Dispose local-sync before abandoning the attached application/service lifecycle. Dispose document/projection owners according to the application ownership order after the sync boundary no longer needs them.
