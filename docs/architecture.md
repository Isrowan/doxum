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
`assignMember`/`removeMember`. They allocate no per-write address or resolved-member
wrapper. Address replay resolves a group container and uses the same write funnel;
`assign` enters the ordinary proxy assignment. No access or resolved
canonical location is reused across transactions.
Resolved containers carry a session identity token, not a reference back to the
MutationSession and its recorder. Existing atomic collection-member updates keep
their generation; membership and structural changes invalidate locations.

Collection methods resolve their current value once for reads and enter complete
session operations for writes. A retained method remains valid across replacement
under the same schema node. If the address now belongs to another schema branch,
the old method throws; reading the method again obtains the current branch's method.
All retained structural accesses and methods expire at callback completion.

Fixed object and variant branch shapes are compiled once per schema shape into
immutable member layouts. `FixedLayout` contains descriptors with mandatory slots;
dynamic layouts contain a shared collection-entry descriptor. `ResolvedContainer`
carries one discriminated layout rather than independently optional members and entry
fields. Field access looks up its compiled descriptor and reads the current parent.
Dynamic map keys and ordered collections retain their
runtime lookup path, while their statically known value objects still use the
compiled descriptors. Compilation is schema-derived and contains no document
instance state.

Fixed object members have schema-compiled lexical slot numbers. Scope child
caches and recorder first-touch storage use these slots instead of a Map per
object. Dynamic keys use Maps; variant access caches retain key identity across
branch changes. A changed object schema clears its child-slot layout, while
retained proxies continue resolving their logical addresses.
Fixed slot arrays allocate the schema's known width, without growth capacity.
Their storage and enumeration cost therefore depends on that fixed object shape;
this is not an O(1) storage promise for arbitrarily wide object schemas. Dynamic
collection size does not determine the slot array size. Session passes the compiled
member definition through to recorder, including its slot, without resolving it again.
Recorder member storage explicitly distinguishes fixed slots from dynamic keys;
lookup, deletion and empty-group checks stay local to recorder. Scope owns its own
fixed/dynamic child cache and renews the fixed cache when the object schema changes.

Object and variant structure is closed. `schema-value.ts` rejects undeclared own
properties (including symbols and non-enumerable properties) at construction, parse,
replacement and apply boundaries. Variants additionally allow their discriminant.
Dynamic keys belong to maps; arbitrary object interiors belong to atomic fields.
Structure copying preserves declared property presence, enumeration order and
enumerability. Equality and replacement diffs follow the compiled schema, with no
fallback for extra properties. Payload interiors remain opaque and shared.

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
Session owns complete table/list/tree operations; scope never composes tree capture
callbacks. A bulk table operation resolves its container once and reuses its member
layout. `ResolvedContainer` includes both the container value and its member storage
(for a table, the latter is `byId`). `mutation/state.ts` owns installation of validated
members and orders, shared by session and recorder restoration. It stores no second
document and performs no validation or capture of its own.
`mutation/issue.ts` creates engine issues. Application `TransactionRejected`
is classified only at the transaction boundary. Ordinary exceptions are rethrown.

Session entry points express assignment, removal or replacement. Ordinary assignment
checks its structural replacement policy before the common write path. That path
accepts a resolved location and a `set`/`remove` operation, with no replacement
permission flag or optional physical-index override. Located list operations pass
their already resolved index directly. No per-write command object is allocated.

Sequence insert/remove/move/install operations in `anchor.ts` invalidate list indexes
as part of the structural write. Session and rollback call these operations; neither
manually invalidates the index. Installing a same-key value preserves the index.

`mutation/recorder.ts` keeps one first-touch fact per value slot, one initial order
per changed sequence, and initial states only for touched tree nodes. Structural
captures absorb descendant facts by reconstructing the initial touched subtree.
Reconstruction uses the actual subtree schema, including map/list/tree roots; it
does not disguise a subtree as a root object or create a second canonical state.
Unrelated entities are not cloned or traversed. List slot identity uses stable
keys rather than moving array indices.

First-touch members are grouped by their owning structural container. The member
slots or dynamic-key Map are also the deduplication registry; there is no separate
slot marker set. Groups share their address, schema and canonical location.
The coverage index stores groups at container addresses, not individual scalar
leaves. Order and tree facts do not force scalar groups into the index; only
structural member capture needs group coverage and absorption. An ancestor group
is checked at the addressed key without scanning its other members. Absorption removes
covered members and deletes empty groups; current object identity is never used
as the authority for logical coverage across replacement.
Fact registration and removal update the fact set, parent identity registry and
coverage index through one recorder-owned lifecycle. The lazy group-index backfill
remains explicit, so scalar writes do not pay for structural coverage indexing.
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
explicit `reset` change. The module-local `diffMember` algorithm only consumes schema,
before/after values and output arrays; it cannot access recorder state. Capture,
coverage absorption and rollback remain recorder responsibilities. These algorithms
are separate without introducing another change representation or protocol.
`schema-value.ts` owns one structure copier for canonical
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

`changes.ts` defines `members`, `tree` and `reset`. A member transition has
a key and an `added`, `removed` or `updated` kind with direct before/after values.
This distinguishes absence from present undefined without Presence objects. Tree
nodes use the same transition kinds; a tree root is a string or null for an empty
tree. A reset has complete before/after values and must be the only change.
A members group's address denotes its container, including `[]` for root members;
it does not denote replacement of that container. Its optional `order` contains
the complete before/after key sequences. A pure order change has `members: []`;
an empty group without order is invalid. There is exactly one group per address,
and there is no standalone `order` change. For example:

```ts
{
  kind: 'members',
  at: ['tasks'],
  members: [{ key: 'b', kind: 'added', after: { title: 'B' } }],
  order: { before: ['a'], after: ['b', 'a'] },
}
```

A single reversible ChangeSet
is stored on each commit. Member keys and tree node IDs are lexically sorted.
`mutation/changes.ts` is the only unknown-input decoder; it checks envelope shape,
duplicates and overlaps using the shared address index and establishes deterministic
lexicographic address/kind order. No string-path parser or command envelope enters
executors.
Recorder publication merges member and order contributions at the same address
while sealing sorted groups. Unknown input must already have complete groups;
the decoder rejects split groups instead of silently merging them.

The decoder also owns the identity of validated publications. Recorder output and
normalized decoded ChangeSets are registered in a private WeakSet; JSON validation,
local-sync replay and public apply preserve the same ChangeSet object. Known
publications reuse shape/conflict validation, while fresh unknown envelopes are
always decoded. Revision checks, current schema/value validation and actual-local
before capture still run on every apply. The entire published ChangeSet, including
addresses, members, order arrays and payloads, is readonly by ownership contract.

Application makes one pass over the groups. Each members group resolves its
container, captures the local baseline, installs members, then validates and installs
its final order. Tree units validate after installing their touched nodes. There
is no ChangeSet-wide preparation pass, deferred order pass or touched-table registry.
Table/list membership and tree structure must validate before publication.
Conflicts are checked at logical member addresses, not group prefixes. Duplicate
groups/keys and parent replacements overlapping descendants are rejected; an
ancestor order can coexist with descendant member changes. Actual rollback facts are captured locally, independent of
received before values. Public apply requires `expectedRevision`; local sync
additionally checks durable sequence under exclusive Web Lock leadership.

Membership is determined from actual local presence, not the incoming transition
label. Ordered membership changes capture an order baseline before writing.
Pure existing-member updates validate only their new values. Explicit orders
must match the final member keys; table membership changes without a matching
final order are rejected. Valid values elsewhere in the collection are not
revalidated merely because one member or the order changed.

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
The first membership/order change of an ordered container may copy O(N) keys.
`anchor.ts` owns a lazy key-to-index cache for canonical list value access,
address resolution, writes and sealing. Building it costs O(N); subsequent key
lookups are O(1) until a membership/order change invalidates it. Cache identity
includes the array and keyOf function; externally supplied arrays are validated
without this cache. Pure key-preserving value updates reuse it across transactions.
One-off structural list operations locate their positions directly and do not
build a lookup index solely to discard it after moving elements. Array insertion,
removal and moves still cost O(N). `profile.address.listIndexes/listItems` counts
index builds and scanned items; `profile.recorder.indexedGroups` counts coverage
registrations. Tree deletion touches its
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
also been removed. Local-sync uses IndexedDB version 5 and record format 3. Old
databases are rejected without modification; there is no implicit migration.
JSON change limits count individual members and `1 + nodes.length` for tree
changes, with one unit each for order/reset, rather than only outer groups.
`changeLimits` is an admission policy for newly authored local commits, with
defaults applied when the attachment omits it. Reading existing durable commits
validates JSON and ChangeSet structure without applying today's admission limits.
This permits reopening or following a document whose earlier leader admitted a
larger commit. Stored data retains its existing format; decoded records carry the
normalized ChangeSet through replay without decoding it a second time.
