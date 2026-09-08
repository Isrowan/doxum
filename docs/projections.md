# Projection Contracts

Create one projection runtime per owning service. `document(runtime)` binds a
document source; `.collection(path => path.rows)` binds a table or any map;
`.targets(path => path.settings, ...)` restricts a document source. Paths compile
at source creation and source identity is interned by internal compiled targets.

`map(source, (key, entry) => value)` maps document collections or projected
collections. Structural document entries are scoped `Read` values; atomic map
entries are atomic values. Key types propagate through downstream collections.
Store `snapshot(entry)` when the output needs a stable structural value. Snapshots
copy schema structure and share immutable payloads; raw payload snapshots retain
their identity. Treat projection outputs as readonly.

`value(sources, compute, { isEqual }?)` handles pure derivation. Stateful processors
use `value({ sources, build })`, returning `{ value, update }`. Custom incremental
collections use `collection<T>()({ sources, build })`; their writer stages
`set/remove/order/replace`, while previous and next are read-only scoped views.

Document collection contexts expose `read.get/has/ids`, `revision`, `commits`,
`reset`, and `candidates.keys/orderDirty`. Across a batch, candidates are the union
of committed keys, even if separate commits later cancel out. Read final canonical
state to decide the output. A single net-zero document transaction emits no commit.
Use `commit.impact.collection(path => path.rows)` for individual commit details.

Dependencies are explicit. A mapper that consults another collection must declare
that source in a custom processor and maintain the appropriate dependency index.
Automatic read tracking is confined to React/integration selectors.

`input(initial)` represents application boundary values with `.set` and `.source`.
`fromReadable(readable)` bridges another observable owner. Neither is a second
canonical document store. Equality preserves output references and revisions.

`batch` defers graph settlement and projection notifications while document
commits/listeners remain synchronous. Readers inside the batch see the previous
publication. Nesting and exceptions preserve already committed source updates;
there is no cross-document rollback. Batch the complete application action before
its first commit.

Processors settle before listeners. A failed update discards processor state and
attempts a fresh build; persistent faults block dependent nodes and leave
independent branches operational. Errors reach `onError` and committed observer
errors where applicable. Disposal invalidates handles and releases subscriptions.
