# Runtime Architecture

## Ownership

`createDocument` owns canonical state, revision, write exclusion and notification.
`schema.ts` owns immutable node definitions and the symbolic path compiler.
The root `ObjectNode` is definition identity; the runtime is instance identity.
`address.ts` is the schema-driven address resolver and shared address index.
`impact-target.ts` owns internal target identity and address matching.

`access/scope.ts` implements both `Read` and `Draft`. Each visited structural
location has one scope-local proxy target containing its schema, canonical value,
parent and generation. Child caches hold structural accesses only; addresses are
materialized on demand for writes, snapshots and dependency tracking. Ordinary
field reads allocate neither addresses nor collection-method closures. Atomic
values are returned directly and never receive draft proxies.

Structural writes advance the mutation session generation. Retained proxies then
resolve through their current parents, sharing the renewed parent resolution.
`address.ts` owns full-path, container and compiled-member resolution. Draft assignments
reuse a `ResolvedContainer` for the current session generation and call
`setMember`/`removeMember`. They allocate no per-write address or resolved-member
wrapper. Address replay resolves a group container and uses the same write funnel;
`assign` enters the ordinary proxy assignment. No access or resolved
canonical location is reused across transactions.
Resolved containers carry a session identity token, not a reference back to the
MutationSession and its recorder. Existing atomic collection-member updates keep
their generation; membership and structural changes invalidate locations.

Fixed object and variant branch shapes are compiled once per schema shape into
immutable member descriptors. Their access path no longer performs a per-read
shape lookup or node-kind dispatch; the runtime only checks scope/generation and
reads the current parent. Dynamic map keys and ordered collections retain their
runtime lookup path, while their statically known value objects still use the
compiled descriptors. Compilation is schema-derived and contains no document
instance state.

## Mutation

```text
draft assignment / explicit collection method / decoded ChangeSet
  -> MutationSession
  -> schema/key/value validation
  -> ChangeRecorder first-touch capture
  -> immediate canonical write
  -> seal final differences
  -> commit + impact + history + projections + external listeners
```

`mutation/session.ts` coordinates writes. `anchor.ts` owns ordered-key semantics;
`tree.ts` owns topology validation and insert/remove/move/set algorithms.
`mutation/issue.ts` creates engine issues. Application `TransactionRejected`
is classified only at the transaction boundary. Ordinary exceptions are rethrown.

`mutation/recorder.ts` keeps one first-touch fact per value slot, one initial order
per changed sequence, and initial states only for touched tree nodes. Structural
captures absorb descendant facts by reconstructing the initial touched subtree.
Unrelated entities are not cloned or traversed. List slot identity uses stable
keys rather than moving array indices.

First-touch members are grouped by their owning structural container. Each member
map is also the deduplication registry, so there is no separate slot marker set.
Groups share their address, schema and canonical location. Only structural
operations build the recorder's logical-address coverage index. Absorption removes
covered members and deletes empty groups; current object identity is never used
as the authority for logical coverage across replacement.
Published before structures and order baselines transfer from
the recorder; after structures are copied away from canonical state. Payloads retain
their original references. Results are readonly by contract and are not frozen.
The resulting changes retain their deterministic lexicographic order.

Rollback restores value/tree facts in reverse first-touch order and installs
order baselines after their entries. It does not call validators or replay user
callbacks. Root replacement invalidates the session's address resolver too.

Seal compares atomic fields with `Object.is`; structural nodes follow their value
schemas. Expandable structures are diffed directly without first recursively testing
equality at each ancestor. Same-branch object replacements emit changed child facts, so deleting and
recreating an entry does not invalidate unchanged fields. Root reset remains one
explicit `reset` change. `schema-value.ts` owns one structure copier for canonical
installation, snapshots, parse, rollback and commit publication. It copies editable
schema structure and shares immutable payloads, including opaque classes, functions,
list items and tree values. Snapshots never expose mutable canonical structure.
There is no generic payload clone, field copier or separate snapshot copying protocol.

Validators run on original references under a pure, synchronous contract. Successful
outputs are ignored. There is no protective copy or deep transformation detection;
input mutation is a contract violation. Shape, key, tree and ChangeSet validation
remain enforced. An identical already-valid member value is a no-op before validator
invocation or first-touch capture. `Infer`, Read/Draft and raw snapshots expose readonly payload types.

## Change Boundary

`changes.ts` defines `members`, `order`, `tree` and `reset`. A member transition has
a key and an `added`, `removed` or `updated` kind with direct before/after values.
This distinguishes absence from present undefined without Presence objects. Tree
nodes use the same transition kinds; a tree root is a string or null for an empty
tree. A reset has complete before/after values and must be the only change.
A members group's address denotes its container, including `[]` for root members;
it does not denote replacement of that container. A single reversible ChangeSet
is stored on each commit. Member keys and tree node IDs are lexically sorted.
`mutation/changes.ts` is the only unknown-input decoder; it checks envelope shape,
duplicates and overlaps using the shared address index and establishes deterministic
lexicographic address/kind order. No string-path parser or command envelope enters
executors.

Application installs values first, tree units next/as encountered, then final
orders. Table/list membership and tree structure must validate before publication.
Conflicts are checked at logical member addresses, not group prefixes. Duplicate
groups/keys and parent replacements overlapping descendants are rejected; an
ancestor order can coexist with descendant member changes. Actual rollback facts are captured locally, independent of
received before values. Public apply requires `expectedRevision`; local sync
additionally checks durable sequence under exclusive Web Lock leadership.

## Derived Consumers

Impact is derived only from sealed changes. Field/order indexes and collection
query results are lazy. Collection queries do not construct a field trie.
Subscriptions use a registration-time index to avoid scanning unrelated listeners.
`impact-target.ts` classifies ordinary targets and membership-only targets, and
owns matching in both query directions. Notification traverses shared group
prefixes and changed member branches to collect exact hits, without expanding
flat changes or querying commit impact. Order changes reach ordinary ancestor
targets; member-internal edits do not reach membership-only targets. Multiple
hits invoke a listener once. The public impact trie remains lazy for explicit
queries, including those made by projections.
React's tracked selection uses internal dependency capabilities from `integration`;
application subscription APIs accept symbolic paths directly.

History stores sequences of complete commit ChangeSets. Undo reads before in
reverse commit order; redo reads after in forward order, within one session.
Local root reset is reversible. Remote commits invalidate local history.

Projection sources explicitly declare dependencies. Capture, settle, flush,
history listeners, filtered document listeners and root listeners retain their
ordering. Writes are forbidden while notifying or evaluating document reads.
Observer errors are attached to an already committed result.

## Cost Model

Scalar work is proportional to touched fields, not total entities. Repeated writes
retain one first-touch value. Structural replacement diffs only the touched subtree.
Untracked structural reads create one proxy per visited location, with no full
address arrays until needed. Scalar writes reuse the current container and
compiled schema member. Address allocation for repeated writes is bounded by
distinct accessed containers, not assignment count. Scope counters expose proxy,
address and cache-refresh work; recorder counters distinguish groups, first-touch
members and published transitions. Impact counters expose explicit index builds.
The first membership/order change of an ordered container may copy O(N) keys;
array moves and list key lookup can also cost O(N). Tree deletion touches its
subtree; child-order edits touch affected child arrays. These costs are deliberate
and instrumented, not hidden behind a constant-time promise.

Payload capture, publication and replay preserve references regardless of payload
size. Only application validation can traverse a payload. `profile.copy.structures`
counts schema structure nodes copied by the shared copier; `profile.equality` counts
ordered-key comparisons in `anchor.ts`. These replace the old generic clone counters, which did not
cover schema copies. Snapshot and whole-structure replacement still visit their
schema structure, and tree topology snapshots still copy affected child arrays.

There is no compatibility execution path. Reader/writer factories, operation
envelopes, inverse logs, journal inverse parsing, prepare, dictionary protocols,
root schema wrappers and public target constructors have been removed.
The previous flat value/Presence ChangeSet and resolved-slot write protocol have
also been removed. Local-sync uses IndexedDB version 4 and record format 2. Old
databases are rejected without modification; there is no implicit migration.
JSON change limits count individual members and `1 + nodes.length` for tree
changes, with one unit each for order/reset, rather than only outer groups.
