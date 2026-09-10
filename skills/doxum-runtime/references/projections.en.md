# Doxum Projection Reference

Use this reference when choosing, implementing, or reviewing a projection. The
[public long-form contract](../../../docs/projections.md) provides a complete join
example; source code inspection should not be necessary for normal application work.

## Choose The Form

| Relationship                                  | API                                               |
| --------------------------------------------- | ------------------------------------------------- |
| Whole document source                         | `project(document)`                               |
| Target-limited document source                | `project(document, [pick, ...])`                  |
| Document collection source                    | `project(document, pick)`                         |
| One source key to the same output key         | `project(collection, mapper)`                     |
| Pure current values to one value              | `project(sources, compute)`                       |
| Stateful incremental value                    | `project({ kind: 'value', sources, build })`      |
| Multiple sources or cross-key collection work | `project({ kind: 'collection', sources, build })` |
| Application input                             | `input(initial)` and `store.set(input, value)`    |
| Existing `Readable`                           | `project(readable)`                               |

Definitions are lazy and reusable. `createProjectionStore({ onError })` owns one
materialization graph. Every store has independent published values, revisions,
inputs, subscriptions, processor instances, and closure indexes.

An ordinary mapper is deliberately limited to:

```text
source key K changed -> output key K may change
```

It rebuilds on reset and follows source order, but does not track reads performed
inside the mapper. Never read another collection in a mapper and assume it becomes
a dependency. Declare all sources in an advanced processor instead.

## Source Event Contract

Advanced processors receive events, not just current values:

```ts
type ValueEvent<T> = {
  value: T;
  previous: T;
  changed: boolean;
  revision: number;
  reset: boolean;
};

type CollectionEvent<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
  change: CollectionImpact<K> | undefined;
  revision: number;
  reset: boolean;
};

type DocumentEvent<S> = {
  read: Read<S>;
  revision: number;
  commits: readonly DocumentCommit<S>[];
  reset: boolean;
};

type DocumentCollectionEvent<S, N, K extends string> = {
  read: CollectionAccess<K, N>;
  revision: number;
  commits: readonly DocumentCommit<S>[];
  reset: boolean;
  candidates: { keys: readonly K[]; orderDirty: boolean };
};
```

Projected collection `change` is incremental (`added`, `removed`, `updated`,
`orderChanged`), reset, or undefined. Document collection candidates are the
union across all relevant commits in a store batch. A later commit may cancel an
earlier one without removing its candidate key. Always derive from final `read`
state. Use `commit.impact.collection(pick)` for per-commit relationship changes.

Across a batch, a value event's `previous` is the pre-batch value and `value` is
the final value. A net-zero document transaction produces no commit or candidates.

## Advanced Value Processor

```ts
const value = project({
  kind: 'value',
  sources,
  build: events => ({
    value: buildValue(events),
    update: events =>
      needsRebuild(events)
        ? { kind: 'rebuild' }
        : changed(events)
          ? { kind: 'changed', value: updateValue(events) }
          : { kind: 'unchanged' },
  }),
});
```

Prefer `project(sources, compute)` unless retained state prevents meaningful work.

## Advanced Collection Processor

```ts
const result = project({
  kind: 'collection',
  sources,
  name: 'optional diagnostic name',
  isEqual: Object.is,
  build: ({ sources, previous, next, writer }) => {
    // Build the complete output and any store-local indexes.
    return {
      update: ({ sources, previous, next, writer }) => {
        // Stage only affected keys, or return { kind: 'rebuild' }.
      },
    };
  },
});
```

`build` runs on first materialization, source reset, explicit `store.rebuild`, an
update-requested rebuild, and fault recovery. Build starts from a cleared output
and must stage the complete result. Its closure state is local to one store and
must be reconstructible from sources.

`update` runs when a declared source participates in settlement. Returning
`{ kind: 'rebuild' }` discards staged update writes and performs a fresh build.
All callbacks are synchronous; Promises and thenables are rejected. Reads and
writes during processing or notification must not reenter a source or document.

`previous`, `next`, source readers, and `writer` are borrowed for the current
synchronous callback only:

- `previous` sees only published output.
- `next` immediately sees current staged writes.
- `writer.set(key, value)` stages presence.
- `writer.remove(key)` stages absence; a missing removal is a no-op.
- Repeated operations on one key use the last operation.
- `writer.order(ids)` supplies the entire next order, with every key exactly once.
- `writer.replace(entries)` clears and replaces all output in entry order; keys
  must be unique.

Staged output publishes atomically. Equality defaults to `Object.is`; equal sets
keep the old reference. Net-zero output does not increment revision or notify.

## Cross-Collection Join Pattern

Do not add a generic join abstraction. The domain owns missing references,
cardinality, reconnect, delete, ordering, and result-key policy. Model the join as
an advanced collection with explicit sources and indexes.

For routes derived from `edges(from, to)` and node geometry, maintain:

```text
endpoints: edgeId -> [fromNodeId, toNodeId]
adjacency: nodeId -> Set<edgeId>
```

On build, scan edges once, populate both indexes, and write the complete routes.
On an edge event:

1. Read exact changed edge ids from each commit's collection impact.
2. Detach every changed id from its old endpoints.
3. Read final edge state; attach its final endpoints, or delete its forward entry.
4. Add that edge id to the affected output set.

On a node collection event, map added/updated/removed node ids through `adjacency`
and add only adjacent edges to the affected set. Finally read current endpoint
geometry and set or remove each affected route. Rebuild on either source reset.

After an edge reconnects, the old node must no longer select it. Deleting an edge
must remove both forward and reverse entries. Missing endpoint behavior is an
explicit domain decision. Do not scan all edges for every node change unless the
known collection size makes that tradeoff intentional.

Closure indexes are not part of the writer's staged transaction. An uncaught
processor failure triggers fresh-build recovery, but a processor that catches a
failure and continues keeps its own mutations. Perform fallible work before
mutating live indexes, stage temporary index changes and commit them on success,
or request a complete rebuild.

## Batching, Faults, And Lifetime

`store.batch` defers projection settlement and projection listeners only. Document
commits and document listeners remain synchronous. Reads inside the batch return
the last publication; settlement after the outer batch uses final source state.
There is no cross-document rollback.

Processor or writer validation failure publishes no partial output. The runtime
may retry with a fresh build; persistent failure faults that projection and blocks
its descendants while independent branches continue. Reads then throw
`ProjectionError`. A later source update or `store.rebuild(projection)` can recover.
`onError` also receives source, blocked, and listener failures. Listener failures
never undo published projection state or accepted document commits.

`store.release(projection)` releases an independently releasable materialization;
do not release a node still used by a materialized downstream projection.
`store.dispose()` invalidates the complete graph and releases its subscriptions.

## Review Checklist

- All result-changing sources are declared.
- Candidate selection covers add, update, remove, reconnect, and missing reference.
- Batch logic reads final state instead of replaying imagined intermediate states.
- Reset and explicit rebuild reconstruct complete output, order, and indexes.
- Build never depends on prior output or a previous processor closure.
- `writer.order` is complete and valid whenever used.
- Equal values preserve references; unrelated changes produce no output revision.
- A thrown update cannot silently corrupt closure indexes.
- Tests cover unrelated commits, dynamic dependencies, stable references, reset,
  batch behavior, recovery, and disposal.
