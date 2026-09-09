# Projection Contracts

Projection declarations are lazy. Create one `ProjectionStore` per owning
service; it owns materialized processor state, subscriptions, batching, errors
and disposal. Definitions can be shared by multiple stores.

`project(document)` binds a document source. `project(document, path => path.rows)`
binds a table or map collection. Pass a non-empty tuple such as
`project(document, [path => path.settings])` to restrict a document source to
explicit targets. Paths compile at materialization and source identity is
interned by compiled targets.

`project(document, path, (key, entry) => value)` and
`project(collection, (key, entry) => value)` map document or projected
collections incrementally. Structural document entries are scoped `Read` values;
atomic map entries are atomic values. Key types propagate through downstream
collections.
Store `snapshot(entry)` when the output needs a stable structural value. Snapshots
copy schema structure and share immutable payloads; raw payload snapshots retain
their identity. Treat projection outputs as readonly.

`project(sources, compute, { isEqual }?)` handles pure derivation. Stateful value
processors use `project({ kind: 'value', sources, build })`, returning
`{ value, update }`. Custom incremental collections use
`project({ kind: 'collection', sources, build })`; their writer stages
`set/remove/order/replace`, while previous and next are read-only scoped views.

Document collection contexts expose `read.get/has/ids`, `revision`, `commits`,
`reset`, and `candidates.keys/orderDirty`. Across a batch, candidates are the union
of committed keys, even if separate commits later cancel out. Read final canonical
state to decide the output. A single net-zero document transaction emits no commit.
Use `commit.impact.collection(path => path.rows)` for individual commit details.
Document commits group member transitions by owning container. Grouping does not
broaden candidates or invalidate sibling fields: projection sources derive their
keys from exact logical member changes. Document listener matching does not build
an impact trie; a projection's explicit `impact.affects` query can build one lazily.

Dependencies are explicit. A mapper that consults another collection must declare
that source in a custom processor and maintain the appropriate dependency index.
Automatic read tracking is confined to React/integration selectors.

`input(initial)` represents an application boundary value definition. Use
`store.set(inputDefinition, value)` to update it. `project(readable)` bridges
another observable owner. Neither is a second canonical document store.
Equality preserves output references and revisions.

`store.batch` defers graph settlement and projection notifications while document
commits/listeners remain synchronous. Readers inside the batch see the previous
publication. Nesting and exceptions preserve already committed source updates;
there is no cross-document rollback. Batch the complete application action before
its first commit.

Processors settle before listeners. A failed update discards processor state and
attempts a fresh build; persistent faults block dependent nodes and leave
independent branches operational. Errors reach `onError` and committed observer
errors where applicable. `store.release(projection)` may release one materialized
leaf early; it rejects when downstream consumers still depend on that projection.
`store.dispose()` invalidates all handles and releases subscriptions.
