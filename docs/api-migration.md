# Public API Consolidation

This is a direct migration to the final API. It changes Doxum internals,
examples, tests and package exports; application repositories are outside this
change. Canonical writes still belong exclusively to createDocument, and
projection dependencies remain explicit.

## Ownership And Replacement Ledger

| Final capability                       | Owner and lifecycle                  | Replaces                                                | Consumers                               |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------- | --------------------------------------- |
| object / dict                          | Schema configuration                 | single / record nodes and exports                       | Readers, writers, selectors, mutation   |
| Schema-owned path identities           | Schema callback scope                | Public address metadata and permissive paths            | Selectors, projection document sources  |
| Variant value reader                   | Scoped reader                        | Mismatched branch-name reader type                      | select, React, projection               |
| Pure value computation                 | Existing projection node             | Repeated build/update formulas                          | Application services                    |
| Typed collection factory               | Existing staged collection node      | Equality annotations used only for inference            | Incremental algorithms                  |
| Collection candidate summary           | Bound document source, one batch     | Repeated commit impact unions                           | map and custom processors               |
| Map of a projected collection          | Existing map and collection executor | Custom processors for one-to-one transforms             | Derived chains                          |
| Equality-specific external bindings    | Projection owner                     | Readable-only cache that ignored options                | fromReadable                            |
| Revision-cached selection              | React hook instance                  | Repeated allocations from getSnapshot                   | useDocumentSelector                     |
| Observable history and explicit groups | Document runtime                     | Unobservable history revisions and one entry per commit | React, projection, interaction services |
| Observable synchronization state       | Local-sync attachment                | Poll-only state()                                       | React, projection, persistence status   |
| DocumentOperation                      | Operation boundary                   | Duplicate union alias and unused schema generics        | Replay, commits, history                |

## Projection

The runtime retains eight methods: document, input, fromReadable, value, map,
collection, batch and dispose. There is no separate derive/computed API.

```ts
const projection = createProjectionRuntime({ onError: reportProjectionError });
const document = projection.document(runtime);
const tasks = document.collection(path => path.tasks);
const count = projection.value({ tasks }, ({ tasks }) => tasks.read.ids().length);
const titles = projection.map(tasks, (_id, task) => task.title.get());
const labels = projection.map(titles, (id, title) => `${id}: ${title}`);
```

Ordinary values use `value(sources, compute, options?)`. Stateful values use
`value({ sources, build }, options?)`; build still returns value and update.
Equality is inferred from the result through the separate options argument.
All computations are synchronous and run through the existing scheduler.

Custom collections use `projection.collection<Item>()(spec)` or
`projection.collection<Item, Key>()(spec)`. The output type is explicit; sources
are inferred. Build/update retain sources, previous, next and writer. Keep
isEqual only when semantic output equality requires it, not to specify a type.

Document collection contexts expose `reset`, `candidates.keys` and
`candidates.orderDirty`. The summary covers all relevant commits since the last
settlement. It contains candidate keys, including insert/remove and change/back
sequences; it does not claim an exact net output change. Read final state and
let the staged writer determine publication. Raw commits and target remain
available for algorithms that need operation detail.

Map preserves keys and order for both document and projected collections.
Present undefined output values remain distinct from missing entries. Mapping,
custom collection processing and pure/stateful values share the same fault,
rebuild, publication and disposal semantics.

Repeated fromReadable calls share one subscription, but each distinct equality
function has its own accepted value and revision. Keep equality function
identities stable when reusing bindings. Input continues to expose separate
set and source capabilities. Dispose projection before external owners.

## Schema And Access

- Replace single(entity) with entity itself and record<Key, Value>() with dict.
  Use object when all members of a fixed shape must exist.
- Variant readers expose get(), returning a discriminated union. Narrow by
  the configured tag. Writers replace the complete branch. Optional variants
  return undefined when absent, and initialize/clear with reversible operations.
- Optional accepts only field, variant, dict, list and tree nodes. Object,
  table and map do not expose partial presence protocols.
- Dict readers use get(key), has(key), keys() and values(). values() is a
  detached dictionary snapshot, normalized to empty for an absent optional dict.
  Key reads clone only the selected value. List get(key)/has(key) use schema
  keyOf; lookup scans the list without cloning unrelated entries.
- Tree insert and move take a named `{ parentId, index }` position. Index is
  the final position after removing the moved node, including same-parent moves.
  This also fixes backward-move inverses and rejected-batch rollback.
  Persisted logs containing tree moves from the previous index convention need
  an application migration to a fresh checkpoint/schema version before replay;
  changing the version alone does not translate old operations.
- Collection selectors reject non-collection paths at compile time and at
  runtime. Selector callbacks must return an authentic path from that callback.
  Business fields named address and item are supported.
- tx.report / tx.reject accept code, message and optional address. Runtime adds
  source: application when publishing diagnostics. Async update, prepare,
  projection batch and pure value computations are rejected by types and runtime.

## History And Sync

History implements Readable<HistoryState>. Its reference and revision change
only when the observable undo/redo depths change. Notifications occur after
projection settlement, isolate observer failures and forbid document writes.
Projection bindings to document-owned history participate in document capture,
so combined document/history graphs do not publish inconsistent intermediates.

```ts
const action = runtime.history.group();
runtime.update(tx => tx.write.title.set('Draft'));
runtime.update(tx => tx.write.title.set('Finished'));
action.end(); // one undo entry
```

Use action.cancel() to revert the group's committed operations in one atomic
apply. Cancel restores the pre-group history, including earlier redo entries
and entries evicted by capacity; it does not add the canceled action to redo.
End and cancel on a stale handle do
not affect a later group. Undo/redo, clear, remote/replace commits and committed
history:false writes end a group; rejected/unchanged updates do not. Groups
cannot nest or start when history is disabled. A net-zero replay consumes its
entry without publishing a document commit. A rejected inverse restores both
canonical state and history stack. Grouping retains operation batches rather
than repeatedly copying all previous operations.

Local-sync replaces state() with a stable `state` Readable. Use state.current(),
state.subscribe(listener), useReadable(localSync.state), or fromReadable. State
updates cover leadership, durable head/checkpoint, errors and disposal. Observer
failures are reported without failing persistence. Dispose publishes a terminal
snapshot and removes listeners; subscribing after disposal throws.

React selectors can return fresh arrays/objects without requiring equality to
avoid render loops. Equality still controls reference reuse across revisions.
Changing a selector's captured props or runtime refreshes its result.

## Exports

The root retains ProjectionRuntime, ProjectionSource, DocumentSource,
DocumentCollectionSource, ProjectionInput, ProjectionValue,
ProjectionCollection, ValueSpec and CollectionSpec. Contexts and writers are
inferred from those contracts rather than separately exported from the root.

AddressRef, contains, overlaps, debugKey, readAddress, resolveAddress and
command footprint APIs move to doxum/integration. DocumentOperation is the sole
operation union, without a schema parameter; individual operation types remain
available for transport code. Schema-specific typing belongs to typed writers.
