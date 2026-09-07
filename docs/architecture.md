# Doxum Architecture

## Purpose

The `doxum` core entry owns the in-memory lifecycle of one typed document. It
turns mutations into reversible commits and makes their impact available to
history, subscribers, projections, and framework integrations.
`doxum/local-sync` is a browser attachment that gives one tab the synchronous
write lease for an IndexedDB-backed timeline and makes other tabs ordered
read-only mirrors. It persists completed commands in the background and uses
BroadcastChannel only for catch-up notifications. Core does not own network
synchronization, access control, or business authorization.

## Module Boundaries

| Module                             | Responsibility                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `core/src/schema.ts`               | Schema nodes, document value inference, and schema-owned selector construction.                 |
| `core/src/access`                  | Typed readers/writers and dependency tracking.                                                  |
| `core/src/mutation/operation.ts`   | Decode, normalize, publish, inverse metadata, and list-node metadata for operations.            |
| `core/src/mutation/issue.ts`       | Closed mutation failure vocabulary and `MutationIssue` construction.                            |
| `core/src/mutation/tree.ts`        | Tree validation, traversal, and single-root structural operations.                              |
| `core/src/mutation/anchor.ts`      | Ordered-key and Anchor position semantics shared by table, list, and journal code.              |
| `core/src/runtime.ts`              | Canonical document owner, transaction boundary, revision, history policy, and lifecycle.        |
| `core/src/runtime/driver.ts`       | Internal synchronous write-policy seam used by an owning adapter without changing runtime APIs. |
| `core/src/local-sync`              | Browser leader/follower attachment, append-only IndexedDB command log, and ordered tail replay. |
| `core/src/impact.ts`               | Commit-local path and collection impact queries.                                                |
| `core/src/impact-target.ts`        | One address, identity, equality, and notification-bucket interpretation for targets.            |
| `core/src/runtime/notification.ts` | Ordered processors and root/targeted commit delivery.                                           |
| `core/src/projection`              | Read-only derived views with explicit invalidation.                                             |
| `react/src`                        | React adapter; it depends on core but core never depends on React.                              |

## Canonical Data Flow

```text
Schema + initial value
        |
        v
createDocument
        |
        v
canonical mutable document --------------------------+
        |                                             |
        | update(reader, writer) or apply(operations) |
        v                                             |
mutation session                                      |
  - decode unknown operation input                    |
  - normalize one canonical operation shape           |
  - resolve address against schema and document       |
  - execute each operation                            |
  - retain inverses for rollback                      |
  - coalesce the final observable change              |
        |                                             |
        +-- rejected --> rollback --> result          |
        |                                             |
        v                                             |
commit { revision, operations, inverse, impact } <---+
        |
        +--> local history
        +--> materialized view processors, in creation order
        +--> targeted subscribers
        +--> root subscribers
```

`createDocument` is the only owner and mutation funnel for the canonical
document. The public API never exposes that document directly. Readers expose
typed accessors; structural reader results are snapshots where needed to avoid
creating another writable source of truth.

## Schema And Addressing

A `DocumentSchema` has two roles:

1. It derives the TypeScript document, reader, and writer shapes.
2. It defines the legal semantic address space for operations and selectors.

Addresses are immutable string paths. Static schema segments and dynamic
collection segments are cached by `core/src/address.ts`; the resolver combines
schema traversal with the current document when a variant branch or collection
entry must be selected.

Business selectors use `schema.value(...)` for value paths and
`schema.collection(...)` for collection paths. Raw `ImpactTarget` values remain
an advanced boundary for impact, notification, projection, and adapters.

Tables preserve a user-visible `ids` order plus an id-indexed `byId` record.
Maps are unordered id-indexed collections. Lists use an application-supplied
stable `keyOf`; trees use a `rootId` and `nodes` record with parent/children
relationships. The tree owner accepts only empty trees or trees with exactly
one root, reciprocal parent/child links, no duplicate children, complete
reachability, and no cycles. Complete validation happens for initial documents
and replacement snapshots; local tree operations enforce only the necessary
local invariants.

## Mutation Protocol

`runtime.update` creates a short-lived reader and writer. Writers emit typed
operations into one mutation session; they do not write canonical state
directly. `runtime.prepare` runs the same typed mutation pipeline but always
rolls it back: a `prepared` result has immutable forward operations, inverses,
impact, reports, and no revision or notification. It is available to an adapter
that explicitly needs a strict prepare-before-commit protocol. `runtime.snapshot`
returns an immutable, detached document value for checkpoint creation.
`runtime.apply` accepts boundary input as `unknown`; the operation
owner decodes it before journal, resolver, or executor code observes it. The
session then normalizes one canonical shape, resolves it, invokes the correct
executor, and saves inverse operations. Engine failures are closed
`MutationIssue` values with `source: "mutation"`; application validation uses
the separate `DocumentDiagnostic` shape through `report` and `reject`.
`MutationIssueCode` is a stable public union. Published application diagnostics
are copied and frozen. Rejections and exceptions roll back the session.

The change journal compares the document state observed before and after each
logical subject. It removes net-zero changes and emits a coalesced set of
paths and collection changes. This makes an update that creates and removes
the same entry report `unchanged` without publishing a commit.

Operations crossing a structural ownership boundary have separate guarantees:

- The initial document is cloned before becoming canonical state.
- Structural operation payloads are transferred into the canonical document.
- Commit and history payloads are frozen snapshots.
- Readers clone structural snapshots before returning them where appropriate.

## Commit, History, And Notification

Every committed mutation increments the runtime revision and creates a
`DocumentCommit`. Its `DocumentImpact` is a resolved, commit-local view: it
answers whether a value target is affected and returns collection additions,
removals, updates, and order changes.

History records forward and inverse operation groups only for local and system
commits. Undo and redo replay those groups through the same mutation pipeline.
`replace` and remote commits invalidate history because they establish a new
canonical baseline.

During notification, internal projection attachments capture source commits,
settle every attached graph, then flush projection listeners before normal
subscribers. Targeted subscribers are bucketed by the first address segment, then
filtered through `impact.affects`; root subscribers receive every commit.
Processor, flush, and listener failures are captured as `observerErrors` on
the committed operation or transaction result. A notification failure never
changes an already committed document into a rejected mutation.

## Read Models

`select(runtime, selector)` evaluates a reader once. `track(runtime, selector)`
also records the values and collection entries the selector accessed.

`createProjectionRuntime` owns source registration, an explicit DAG, synchronous
batching, fault recovery, and disposal. `projection.document(runtime)` shares
runtime identity through `asReadable`. Its `collection(path => path.items)`
delegates to the bound schema and caches a scoped collection source. Document
sources may also declare fixed `targets(...)`. Neither operation installs
automatic read dependencies. External `fromReadable` and `input` sources use
semantic equality; their values must not be mutated after submission.

`projection.map` is a one-to-one document collection mapping with stable keys and
order. `projection.collection` provides explicit incremental build/update
callbacks with scoped previous/next reads and a staged writer. It shares the
same scheduler with `projection.value`. Ordinary updates touch only candidate
keys; structural order/replace work may be linear. Equality preserves old item
references, aggregate arrays are lazy, and output revision is independent of
source progress. Collection changes reuse `CollectionImpact`; values expose
previous/current state without an arbitrary custom change protocol.

Processors read accepted upstream candidates through their callback context;
public readables retain the previous publication until settlement completes.
Failures discard staged output and the mutable processor instance. One fresh
build may recover a failed update. Persistent failure makes current() throw and
blocks descendants; unrelated branches continue. Listener exceptions are
isolated individually. Explicit rebuild follows the same dependency graph.

`projection.batch` defers projection settlement until the outer synchronous
callback exits, including when it throws. It does not defer canonical commits,
history, or document listeners, and it does not roll back sources. Enter the
batch before the first commit, covering synchronous editor reconciliation.
Document sources retain all ordered commits in a batch; processors union
candidate keys and read final state rather than treating the last impact as the
whole batch. Source reset rebuilds the affected node. No async cause graph or
cross-projection dependency graph is provided.

During processing and projection notifications, writes to declared documents
and inputs are forbidden independently of the local-sync write lease. Dispose
the projection before releasing external readables. Document disposal invalidates
dependent nodes; node disposal with downstream consumers is rejected. Disposed
readables throw. `doxum/integration` exposes read-only `projectionDebug` counts,
not internal mutable scheduler state.

## React Boundary

`doxum/react` uses `track` to calculate selector dependencies, installs a
matching runtime subscription, and delegates subscription consistency to
React's `useSyncExternalStore`. Its selector cache preserves a previous
reference when the configured equality function says the semantic result is
unchanged. Server rendering can provide an explicit `server` snapshot.

## Extension Boundaries

Keep integrations outside core:

- `doxum/local-sync` attaches to an existing runtime, hydrates it from an
  IndexedDB checkpoint and append-only tail, and uses a document Web Lock to
  select one leader. Its internal runtime write policy lets the leader retain
  the ordinary synchronous operation APIs while followers reject direct writes.
  The leader observes local, system, and history commits and appends their JSON
  operation batches asynchronously. `replace`, and external `apply` calls
  marked `remote`, are rejected while attached because they cannot be appended
  as local operation commands; hydration and tail replay use the driver's
  trusted lease instead. BroadcastChannel carries only a new-head hint;
  followers reload and apply the durable tail as `remote`, which invalidates
  their local history. There is no pending queue, rebase, actor history, or
  attachment-specific undo API. `flush()` waits for observed leader commands to
  persist or for a follower to catch up; it does not make a visible write
  retroactively durable.
- Other persistence should store and replay `DocumentOperation` batches, or use
  an application-defined snapshot strategy with `replace`.
- Network synchronization should assign ordering, acknowledgements, retry, and
  conflict semantics before calling `apply` or `replace`.
- Business validation belongs inside a transaction through `report` and
  `reject`, or in an application layer that decides whether to start one.
- UI-specific derived state should be a React state concern or a `Readable`,
  not another mutable copy of the Doxum document.
