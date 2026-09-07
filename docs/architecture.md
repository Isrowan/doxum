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
        +--> projection graph capture, settlement and publication
        +--> history listeners
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

`Infer<T>` is the public value inference entry for both nodes and complete
schemas. `core/src/schema.ts` owns the internal node and shape mappings;
readers, writers, snapshots and synchronization contracts consume the same
inference. Object properties are flattened after required/optional mapping,
and each variant branch is flattened after adding its readonly discriminant.
This retains discriminant correlation without leaking generated intersections
into the value type. User-provided scalar types remain opaque to this process.
Optional nodes infer a value or undefined, and optional shape members retain
their optional property modifier. Variant replacement accepts a present branch;
absence is expressed by clear. Optional variant selectors and readers both
include undefined in their result type.

Addresses are immutable string paths. Static schema segments and dynamic
collection segments are cached by `core/src/address.ts`; the resolver combines
schema traversal with the current document when a variant branch or collection
entry must be selected.

Business selectors use `schema.value(...)` for value paths and
`schema.collection(...)` for collection paths. Raw `ImpactTarget` values remain
an advanced boundary for impact, notification, projection, and adapters.
Path builders retain their identity and address in private WeakMaps; business
fields such as `address` and `item` remain available. Only collection paths have
the `item(id)` traversal method. Selectors validate callback ownership and node
kind against schema configuration, including inactive variant branches.

`object` owns structured shape; the redundant `single` node is removed. `dict`
is the sole keyed scalar container; the inconsistent `record` node is removed.
Variant readers return discriminated value snapshots through `get()`; writers
replace a complete branch. Optional is restricted to field, variant, dict,
list and tree, whose initialization and clear operations have exact inverses.
Dictionary keyed reads avoid copying unrelated entries. List keyed reads use
the same key resolver as mutation and scan without cloning the whole list.
Tree positions are named objects; move index is a final index after removal.

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
Callers supply code, message and optional address; runtime adds the application
source. Operation payloads use the non-generic `DocumentOperation` union;
schema-specific type safety lives at the reader/writer boundary.
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
History exposes a stable Readable snapshot. An explicit `history.group()`
collects committed batches into one entry without copying earlier batches on
each update. End keeps the group; cancel replays its inverses through apply.
Undo/redo stage the target stack before publication so commit listeners see
settled history. Rejected replay restores the stack. A net-zero replay consumes
the entry without creating a document commit. Non-recorded commits close the
group; remote/replace commits invalidate it. Groups cannot nest.

During notification, internal projection attachments capture source commits,
settle every attached graph, then flush projection and history listeners before normal
subscribers. Targeted subscribers are bucketed by the first address segment, then
filtered through `impact.affects`; root subscribers receive every commit.
Processor, flush, and listener failures are captured as `observerErrors` on
the committed operation or transaction result. A notification failure never
changes an already committed document into a rejected mutation.
History readables carry an internal document-owner association. `fromReadable`
captures them in the document notification phase, so a graph depending on both
document and history settles once with consistent inputs. This association is
internal runtime plumbing, not a public source protocol.

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

`projection.value(sources, compute, options?)` handles pure calculations. Its
stateful form takes `{ sources, build }` and separate equality options, and
uses the same node implementation. `projection.map` maps document or projected
collections one-to-one with stable keys and order.
`projection.collection<Item>()(spec)` provides explicit incremental build/update
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
Document sources retain all ordered commits in a batch; bound collection sources
also cache candidate keys and an order-dirty flag across the batch. Processors
read final state; candidate summaries deliberately retain net-zero touched keys.
External readable bindings share subscriptions and preserve each equality policy.
Source reset rebuilds the affected node. No async cause graph or
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
React's `useSyncExternalStore`. Each selector closure caches its result by
document revision, including newly allocated objects/arrays. Equality can retain
the previous reference across revisions. Selector/runtime changes create a new
cache, and subscriptions use Object.is when comparing published results.
Server rendering can provide an explicit `server` snapshot.

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
  Its `state` is a stable Readable of role, durable head/checkpoint or error;
  listeners are notified on persistence, leadership, failure and disposal.
  Observer errors are reported without converting successful persistence into
  a storage failure. Dispose publishes a terminal state and releases listeners.
- Other persistence should store and replay `DocumentOperation` batches, or use
  an application-defined snapshot strategy with `replace`.
- Network synchronization should assign ordering, acknowledgements, retry, and
  conflict semantics before calling `apply` or `replace`.
- Business validation belongs inside a transaction through `report` and
  `reject`, or in an application layer that decides whether to start one.
- UI-specific derived state should be a React state concern or a `Readable`,
  not another mutable copy of the Doxum document.
