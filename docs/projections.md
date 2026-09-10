# Projection Contracts

Projections are lazy, reusable descriptions of derived state. A
`ProjectionStore` materializes those descriptions, owns their processor state,
settles the dependency graph, publishes revisions, reports errors, and disposes
subscriptions. Creating a projection definition does not start work:

```ts
import { createProjectionStore, input, project } from 'doxum';

const titles = project(
  document,
  path => path.tasks,
  (_id, task) => task.title
);
const total = project({ titles }, ({ titles }) => titles.ids().length);
const zoom = input(1);
const scaled = project({ total, zoom }, ({ total, zoom }) => total * zoom);

const store = createProjectionStore({ onError: console.error });
store.get(scaled); // Materializes scaled and its transitive dependencies.
store.set(zoom, 2);
```

Create one store per owning service or UI root. The same definitions may be
materialized in multiple stores; each store gets independent values, revisions,
processor instances, indexes, subscriptions, and input state.

## Choose A Projection Form

| Need                                                | Definition                                                         | Processor input                                  |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| Observe a whole document                            | `project(document)`                                                | `DocumentEvent` in advanced processors           |
| Observe selected document targets                   | `project(document, [pick, ...])`                                   | `DocumentEvent` in advanced processors           |
| Read one document collection                        | `project(document, pick)`                                          | `DocumentCollectionEvent` in advanced processors |
| Transform every collection entry under the same key | `project(collection, mapper)` or `project(document, pick, mapper)` | Current entry in `mapper`                        |
| Compute a pure value from current source values     | `project(sources, compute)`                                        | Current values, not events                       |
| Maintain state across value updates                 | `project({ kind: 'value', sources, build })`                       | Source events                                    |
| Maintain an incrementally updated collection        | `project({ kind: 'collection', sources, build })`                  | Source events, output readers, writer            |
| Accept an application-owned value                   | `input(initial)`                                                   | `ValueEvent` in advanced processors              |
| Bridge an existing Doxum `Readable`                 | `project(readable)`                                                | `ValueEvent` in advanced processors              |

`project(document, [path => path.settings])` uses a non-empty tuple and limits a
whole-document source to explicit targets. Paths compile when the definition is
materialized. Schema paths are the only document addressing syntax.

Use the shortest form whose dependency relationship is true. In particular, an
ordinary collection mapper has a deliberately narrow contract; it is not a
general join operator.

## Mapper Contract

An ordinary mapper preserves keys and has exactly one collection source:

```text
source key K changes -> output key K may change
```

Initial materialization visits every source key. An incremental source event
visits only its changed or candidate keys. A source reset rebuilds the mapped
collection. Structural changes also update the output order to match the source.
`isEqual` defaults to `Object.is`; equal mapped values keep their published
references and do not count as updates.

The mapper may read the entry passed to it, but reads of other documents,
collections, projection stores, or application state do not become dependencies.
For example, this is incorrect if moving a node must update its edges:

```ts
// Incorrect: node reads are invisible to the edges mapper.
const routes = project(edges, (edgeId, edge) => {
  const from = store.get(nodes).get(edge.from);
  const to = store.get(nodes).get(edge.to);
  return route(from, to);
});
```

Use an advanced collection processor when one source key can affect a different
output key, one output depends on multiple sources, or incremental work requires
processor-owned state such as a reverse dependency index.

If a structural mapper result must outlive the callback, return
`snapshot(entry)` or a value constructed from it. Scoped document `Read` values
must not escape. Projection outputs are readonly; atomic payloads retain their
readonly ownership contract.

## Source Events

Advanced processors receive an event for every explicitly declared source.
There is no automatic read tracking in core projections.

### Value Source

An `input`, bridged `Readable`, or value projection exposes:

```ts
type ValueEvent<T> = {
  readonly value: T;
  readonly previous: T;
  readonly changed: boolean;
  readonly revision: number;
  readonly reset: boolean;
};
```

`previous` is the value before the current settlement and `value` is the final
value. Across a store batch, they are the value before the batch and the final
value after all batched updates.

### Projected Collection Source

A mapped or advanced collection exposes current collection reads plus:

```ts
type CollectionEvent<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
  readonly change: CollectionImpact<K> | undefined;
  readonly revision: number;
  readonly reset: boolean;
};
```

An incremental `change` contains `added`, `removed`, `updated`, and
`orderChanged`. A reset event has `kind: 'reset'`. `change` can be undefined when
the source participated in settlement without publishing a net change.

### Document Source

`project(document)` and its target-restricted form expose:

```ts
type DocumentEvent<S> = {
  readonly read: Read<S>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
};
```

`read` is the final document state for the settlement. `commits` contains all
relevant commits accumulated by a store batch.

### Document Collection Source

`project(document, pick)` exposes:

```ts
type DocumentCollectionEvent<S, N, K extends string> = {
  readonly read: CollectionAccess<K, N>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
  readonly candidates: {
    readonly keys: readonly K[];
    readonly orderDirty: boolean;
  };
};
```

`candidates.keys` is the union of logical member keys touched by all relevant
commits. A key remains a candidate even when later commits in the same batch
cancel its earlier change. `orderDirty` is true when additions, removals, or
ordering changes may require output order work. A single net-zero document
transaction emits no commit or candidates.

Candidates identify work to reconsider; they do not describe intermediate
states. Always read `sources.<name>.read` to derive output from final canonical
state. Inspect `commit.impact.collection(path => path.rows)` only when the exact
per-commit transition is needed, such as maintaining a dependency index.

## Advanced Value Processors

A stateful value processor builds one store-local processor instance:

```ts
const summary = project({
  kind: 'value',
  sources: { tasks },
  build: ({ tasks }) => ({
    value: calculateAll(tasks),
    update: ({ tasks }) => {
      if (tasks.reset) return { kind: 'rebuild' };
      const next = updateSummary(tasks);
      return next.changed ? { kind: 'changed', value: next.value } : { kind: 'unchanged' };
    },
  }),
});
```

`build` returns the initial value and an `update` callback. `update` must return
`{ kind: 'changed', value }`, `{ kind: 'unchanged' }`, or
`{ kind: 'rebuild' }`. Use the pure `project(sources, compute)` form unless retained
state avoids meaningful work or implements a genuinely incremental algorithm.

## Advanced Collection Lifecycle

An advanced collection definition has this shape:

```ts
project({
  kind: 'collection',
  name: 'optional diagnostic name',
  sources,
  isEqual: Object.is,
  build: ({ sources, previous, next, writer }) => ({
    update: ({ sources, previous, next, writer }) => {
      // Stage an incremental output update, or return { kind: 'rebuild' }.
    },
  }),
});
```

`build` runs:

- on first materialization in a store;
- after a source reset;
- after `store.rebuild(projection)`;
- when `update` returns `{ kind: 'rebuild' }`;
- during fault recovery when a fresh build is required.

The existing candidate output is cleared for a build, so `build` must stage the
complete output. It may also construct store-local indexes in its closure and
returns the `update` callback that will reuse them.

`update` runs when any declared source participates in settlement. It may stage
only changed output keys. Returning `{ kind: 'rebuild' }` discards that update's
staged writes and immediately performs a fresh build.

All processor callbacks and mappers are synchronous. Returning a Promise or
thenable is an error. Document or source writes are forbidden while the graph is
processing or notifying listeners.

## Output Readers And Writer

`previous`, `next`, every source reader, and `writer` are borrowed views valid
only during the current synchronous callback. Do not retain them, their scoped
document entries, or methods bound from them.

- `previous.get/has/ids` reads the currently published output and never sees
  writes staged by the current evaluation.
- `next.get/has/ids` reads the candidate output and immediately sees staged
  `set`, `remove`, `order`, and `replace` operations.
- `writer.set(key, value)` stages a present value.
- `writer.remove(key)` stages absence. Removing a missing key is a net no-op.
- Repeated writes to one key are combined; the last staged operation wins.
- `writer.order(ids)` stages the complete output order. It must contain every
  next output key exactly once and no unknown or duplicate key.
- `writer.replace(entries)` clears the candidate output and installs the given
  entries in their iteration order. Duplicate keys are rejected.

Writes are validated and published atomically after the processor returns.
`isEqual`, which defaults to `Object.is`, removes equal `set` operations and keeps
the old published reference. A net-zero evaluation does not advance the
projection revision or notify listeners.

## Cross-Collection Dependencies

A cross-collection join is intentionally expressed as application logic in an
advanced processor. Declare every source and own the dependency relationship that
maps a changed source key to affected output keys.

For an edge route derived from edge endpoints and node geometry, the useful
indexes are:

```text
endpoints: edge id -> [from node id, to node id]
adjacency: node id -> set of edge ids
```

The forward index lets an edge be recalculated without rereading historical
state. The reverse index turns a changed node into only its adjacent output edge
keys. The complete pattern is:

```ts
import { project, type AdvancedCollectionSpec } from 'doxum';

const nodes = project(
  document,
  path => path.nodes,
  (_id, node) => node.x
);
const edges = project(document, path => path.edges);

const routes = project({
  kind: 'collection',
  sources: { nodes, edges },
  isEqual: (a: string, b) => a === b,
  build: ({ sources, writer }) => {
    const adjacency = new Map<string, Set<string>>();
    const endpoints = new Map<string, readonly string[]>();

    const detach = (edgeId: string) => {
      endpoints.get(edgeId)?.forEach(nodeId => {
        const edgeIds = adjacency.get(nodeId);
        edgeIds?.delete(edgeId);
        if (edgeIds?.size === 0) adjacency.delete(nodeId);
      });
      endpoints.delete(edgeId);
    };
    const attach = (edgeId: string, pair: readonly string[]) => {
      endpoints.set(edgeId, pair);
      pair.forEach(nodeId => {
        const edgeIds = adjacency.get(nodeId) ?? new Set<string>();
        edgeIds.add(edgeId);
        adjacency.set(nodeId, edgeIds);
      });
    };
    for (const edgeId of sources.edges.read.ids()) {
      const edge = sources.edges.read.get(edgeId)!;
      const pair = [edge.from, edge.to] as const;
      attach(edgeId, pair);
      const from = sources.nodes.get(pair[0]);
      const to = sources.nodes.get(pair[1]);
      if (from !== undefined && to !== undefined) writer.set(edgeId, `${from}:${to}`);
    }

    return {
      update: ({ sources, writer }) => {
        const affected = new Set<string>();
        if (sources.edges.reset || sources.nodes.reset) return { kind: 'rebuild' };
        const writeRoute = (edgeId: string) => {
          const pair = endpoints.get(edgeId);
          if (!pair) {
            writer.remove(edgeId);
            return;
          }
          const from = sources.nodes.get(pair[0]);
          const to = sources.nodes.get(pair[1]);
          if (from === undefined || to === undefined) writer.remove(edgeId);
          else writer.set(edgeId, `${from}:${to}`);
        };

        for (const commit of sources.edges.commits) {
          const change = commit.impact.collection(path => path.edges);
          if (change.kind === 'reset') return { kind: 'rebuild' };

          for (const edgeId of [...change.added, ...change.updated, ...change.removed]) {
            affected.add(edgeId);
            detach(edgeId);
            const edge = sources.edges.read.get(edgeId);
            if (edge) attach(edgeId, [edge.from, edge.to]);
          }
        }

        const nodeChange = sources.nodes.change;
        if (nodeChange?.kind === 'reset') return { kind: 'rebuild' };
        if (nodeChange)
          for (const nodeId of [...nodeChange.added, ...nodeChange.updated, ...nodeChange.removed])
            adjacency.get(nodeId)?.forEach(edgeId => affected.add(edgeId));

        affected.forEach(writeRoute);
      },
    };
  },
} satisfies AdvancedCollectionSpec<{ nodes: typeof nodes; edges: typeof edges }, string, string>);
```

This example defines missing endpoints as an absent route. An application could
instead publish an error value. The application also owns reconnect, delete,
duplicate-reference, and ordering policy; these are domain decisions rather than
generic projection semantics.

The index is derived processor state, not canonical state. It must be completely
reconstructible from declared sources in `build`. Update both directions when a
relationship changes: detach old references before attaching final references.
After reconnecting an edge, changes to its old node must no longer affect it.

Avoid scanning every primary entry when a secondary key changes unless the data
size makes that cost intentional. The reverse index is what preserves incremental
work for high-fanout or large collections.

Processor closure state is not part of the writer's staged transaction. An
uncaught processor failure triggers fresh-build recovery, but the runtime cannot
undo index mutations when processor code catches a failure and continues. Validate
and compute fallible work before mutating the live index, use temporary state and
swap it on success, or request a complete rebuild. `build` must always be able to
restore consistency.

## Reset, Failure And Recovery

Treat any source reset that invalidates processor-owned assumptions as a rebuild:

```ts
if (sources.rows.reset) return { kind: 'rebuild' };
if (sources.mapped.change?.kind === 'reset') return { kind: 'rebuild' };
```

An exception from `build`, `update`, equality, or order validation does not publish
partial staged output. The scheduler may attempt one fresh build after an update
failure. If recovery also fails, the projection becomes faulted; reads throw a
`ProjectionError`, downstream projections are blocked, and independent graph
branches continue to operate. A later source update or explicit
`store.rebuild(projection)` can recover the branch.

`onError` receives processor, source, blocked, and listener failures. A listener
failure does not undo an already published projection or document commit.

## Batching And Publication

`store.batch(run)` delays projection graph settlement and projection listeners
until the outer batch exits. It does not delay document commits or document
listeners. Projection reads inside the batch return the last published value:

```ts
store.batch(() => {
  document.update(changeNodes);
  document.update(changeEdges);
  store.set(zoom, 2);
  store.get(routes); // Last publication, not the pending result.
});
// The graph has now settled once against final source state.
```

Batch the complete application action before its first commit. Nested batches and
exceptions do not provide cross-document rollback; source commits that already
happened remain committed.

Processors settle before external projection listeners. Processor dependencies
are explicit and determine graph order. React selectors may track actual reads,
but that behavior does not extend to core projection processors.

## Performance And Correctness Checklist

Before shipping an advanced collection processor, verify:

- Every source capable of changing the result is declared in `sources`.
- Each source event maps to a bounded set of output candidate keys.
- Final source state, not imagined intermediate batch state, determines output.
- Adds, updates, removals, reconnects, and missing references update all indexes.
- Relevant resets and explicit rebuilds reconstruct the complete output and index.
- `build` does not depend on prior closure state or prior output still existing.
- Output order is either intentionally preserved or staged as a complete valid order.
- Equal output values keep stable references through `isEqual` or `Object.is`.
- Unrelated commits perform no output writes and publish no projection revision.
- Failure cannot leave closure state silently inconsistent with published output.
- Tests cover dynamic dependencies, unrelated commits, stable references, reset,
  batching, fault recovery, and disposal.

Use `store.revision(projection)` to inspect a published revision and
`store.subscribe(projection, listener)` for external observation. Release a
materialized leaf early with `store.release(projection)` only when no materialized
downstream consumer still depends on it. `store.dispose()` invalidates all handles
and releases all source subscriptions owned by the store.
