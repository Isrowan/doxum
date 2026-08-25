# Doxum Runtime Invariants

Read this reference before changing or reviewing mutation, addressing, impact,
notifications, history, trees, or projections. These are design boundaries,
not optional style preferences.

## One canonical write authority

`createDocument` owns canonical mutable document state. Canonical writes must
pass through `runtime.update`, `runtime.apply`, or `runtime.replace`.
`runtime.prepare` may use the same mutation session to produce a rolled-back,
uncommitted operation batch for a durable adapter; it is not a second write
path. Writers emit operations into a mutation session; they are not a public
escape hatch to mutate an object.

Never add:

- a parallel writable document cache;
- a reducer that edits document state outside the runtime;
- a view that callers manually keep synchronized; or
- an operation execution path that bypasses decode, normalization, inverse
  recording, rollback, impact, history, or notification.

## Transaction lifetime and atomicity

A transaction callback is synchronous. Its reader and writer objects are valid
only while it executes. An `async` callback, a retained reader/writer, nested
write, or write during notification violates the runtime boundary.

Every session is atomic. If one operation is rejected after prior operations
have changed state, all earlier work in that session must roll back. A callback
throw also rolls back, then the original error is rethrown. Expected rejection
is a returned result, not an exception protocol.

## Keep engine and application problems distinct

| Problem                                                  | Owner            | Result shape                                      | Correct response                                        |
| -------------------------------------------------------- | ---------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Malformed, unresolved, or semantically invalid operation | Doxum engine     | `MutationIssue` with `source: 'mutation'`         | Inspect a `rejected` operation/transaction result.      |
| Application business rule or validation                  | Application      | `DocumentDiagnostic` with `source: 'application'` | Use `tx.report` or `tx.reject`.                         |
| Callback defect or unexpected failure                    | Application code | thrown error after rollback                       | Fix or handle the exception outside the transaction.    |
| Processor, flush, or listener failure                    | Observer         | `observerErrors` on a committed result            | Repair the observer; do not replay the committed write. |

Do not create another generic `invalid` status, stringify every error into one
shape, or turn notification failures into mutation rejection. Mutation issue
codes are a closed public vocabulary and must remain exact.

## Schema owns addressing and selectors

The schema defines legal semantic addresses for operations and selectors.
Address resolution combines schema structure and current document state, which
is necessary for collection entries and variant branches.

Create long-lived targets with `schema.value(...)` and
`schema.collection(...)`. Use `runtime.address` for the runtime's address
domain. Use the exported `target` namespace for target identity and bucketing.
Do not add string-path parsers, another address type, custom selector IDs, or
separate impact-target equality helpers.

## Operations follow one pipeline

External operation input follows this order:

```text
decode -> normalize -> resolve -> execute -> inverse + journal -> publish
```

`apply` is the boundary for untrusted operation envelopes. The batch must be
decoded before executor code sees it, normalized to one canonical operation
shape, resolved against the schema, and either fully published or fully rolled
back. All committed operations need exact inverse data and exact impact.

Local application behavior should use writers, not manually assembled operation
objects. Direct operation construction is appropriate for boundary adapters,
fixtures, migrations, and intentional replay.

## Ownership is explicit

- `initial` is cloned before it becomes canonical state.
- Structural payloads in ordinary operations are transferred into canonical
  state. A caller that mutates one after submission may mutate canonical data.
- Commit and history operation payloads are immutable snapshots.
- Published diagnostics and selector addresses are copied and frozen.
- Tree replacement snapshots are validated and cloned.

Do not promise deep immutability where Doxum intentionally transfers a payload.
When a caller needs to retain mutable ownership, clone it before submission.

## Tree integrity is whole-document integrity

Every present tree must be empty or have exactly one root, complete
reachability from that root, no cycles, no duplicate child references, and
reciprocal parent/child relationships. This is checked for initial state and
replacement snapshots. Local tree operations preserve it incrementally.

Do not accept disconnected forests, orphan nodes, a non-root moved to no
parent, a root re-parented below another node, or direct edits to the tree's
internal records. A rejected tree operation leaves the entire transaction
unchanged.

## Impact and notification describe committed state

Every commit publishes a `DocumentImpact`; it is not a mutable change log for
callers to edit. Value impact answers `affects(target)`. Collection impact
reports exact added, removed, updated, and ordering changes, or `reset` after a
replacement/subtree reset.

Notification order is observable behavior:

```text
commit -> materialized processors -> processor flushes -> targeted listeners -> root listeners
```

Writes are forbidden during the update and notification windows. Processor,
flush, and listener errors are captured while the committed document, revision,
and history stay settled.

## Derived state is declared, not synchronized by callers

`CollectionView` derives one declared collection and incrementally maintains
ids, keyed values, and a lazy aggregate array. `MaterializedView` derives one
value from document reads, tracked impact dependencies, and optional earlier
materialized sources. A materialized view can only depend on views of the same
runtime that were created before it.

Do not cache derived values inside canonical document state unless they are
real domain data. Do not have UI code manually feed changes into a view. Dispose
views and subscriptions with their owner.

## Framework and product boundaries

`core` is framework-neutral. `doxum/react` is a one-way adapter from core to
React; core must not import React or UI concepts. `doxum/local-sync` is an
optional attachment to an application-owned runtime. It hydrates an IndexedDB
checkpoint/tail, holds a document Web Lock for exactly one leader, and uses a
small internal synchronous write policy to reject follower mutations without
changing the runtime API. The leader observes completed local, system, and
history commits, appends JSON operation batches asynchronously, and broadcasts
only a head hint. Followers read and apply the durable tail as `remote`; this
invalidates their history. There is no pending queue, rebase, actor history, or
attachment-specific undo API. While attached, external `replace` and external
`apply` marked `remote` are rejected because only operation commands are
appendable; the attachment's hydration and replay lease is the one trusted
exception. Local-sync does not promise strict durability;
application code uses `state()`, `onError`, and `flush()` when it needs to
observe persistence or catch-up. Doxum intentionally does not decide network
synchronization, authorization, retry, acknowledgement, ordering, or conflict
resolution. An application must make those decisions before applying operations
or replacing a snapshot.

## Change checklist

Before handing off a change that touches the runtime:

- Does every canonical write still flow through `createDocument`?
- Are success, rejected rollback, inverse history, and impact/subscription
  behavior tested where applicable?
- Are tree and collection paths free of accidental whole-document copying or
  traversal?
- Do public lifecycle changes update the README and architecture guide?
- Are obsolete protocol types, local helpers, and duplicate address/target
  interpretations removed rather than preserved for compatibility?
