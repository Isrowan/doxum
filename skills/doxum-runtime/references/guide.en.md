# Doxum Guide

## Define, Update And Read

```ts
import { createDocument, field, map, object, select, snapshot, type Infer } from 'doxum';

const task = object({ title: field<string>(), done: field<boolean>() });
const model = object({ tasks: map(task) });
type DocumentValue = Infer<typeof model>;
const document = createDocument({
  schema: model,
  initial: { tasks: { a: { title: 'Write', done: false } } },
});
document.update(draft => {
  const task = draft.tasks.a;
  if (task) task.done = !task.done;
  draft.tasks.b = { title: 'Review', done: false };
  return { warnings: [] };
});
const done = select(document, state => state.tasks.a?.done);
const tasks = select(document, state => snapshot(state.tasks));
document.subscribe(
  path => path.tasks.item('a').done,
  commit => console.log(commit.changes)
);
```

Root object is definition identity; runtime owns its data/revision. Updates are
synchronous and atomic. Reads see preceding writes. Draft and trusted internal
readWith scopes are borrowed for the synchronous callback and must not escape.
Throw TransactionRejected for expected rejection; ordinary throws
restore all work and rethrow unchanged. False/undefined returns are business values.

Object exposes editable members; field is atomic, including arrays and objects.
Atomic values are deeply readonly in Infer and scoped access. Inputs, snapshots,
commits and history share payload references. Object/variant structure accepts only
declared own properties (plus the variant discriminant); extra string, symbol and
non-enumerable properties are rejected. Use maps for dynamic keys and fields for
arbitrary payload objects. Never mutate payloads through any alias,
even after removal. Snapshot copies schema structure only; snapshot(rawPayload)
returns its original readonly reference. Published data is not frozen. Field copiers
are not supported; mutable exports and serialization belong to application boundaries.

Infer preserves optional properties and flat variant unions. Read/Draft contain
collection tools; assign(scope, key, inferValue) handles plain replacements containing
nested table/list/tree data.

## Containers And Validation

| Definition                       | Data          | Draft methods                                                 |
| -------------------------------- | ------------- | ------------------------------------------------------------- |
| map(valueSchema, { key }?)       | record        | indexing, assignment, delete                                  |
| table(objectOrVariant, { key }?) | ids/byId      | get/has/ids/create/remove/move                                |
| list(field, { keyOf })           | array         | get/has/ids/insert/set/remove/move/replace                    |
| tree(field)                      | rootId?/nodes | get/has/rootId/parent/children/insert/set/remove/move/replace |

Read scopes expose only read methods. Map supports field/object/variant values.
List replacement retains the addressed key. Simple arrays and strokes can be one
atomic field. Optional supports field/variant/map/list/tree. Absent differs from
present undefined. Variant tags are readonly; change branch by whole replacement.

Pure synchronous functions and Standard Schema v1 validators receive original input.
They must not mutate it; successful output is ignored, with no copy or deep conversion
check. Transform values before entering Doxum. parse(model, unknown) copies validated
structure and shares readonly payloads; strict parse requires atomic validators.
Branded map/table keys flow through access, symbolic paths and impact.
Path callbacks describe locations, including absent entries, and compile at registration.
React useDocumentSelector tracks actual reads and changes dependencies when branching.

## Changes And Consumers

Commits contain revision/source/changes/impact. ChangeSet groups members by owning
container, with direct added/removed/updated transitions and optional before/after
order in the same group. Order-only groups have empty members; standalone order
changes and duplicate groups are invalid. Each group is applied completely before
the next. Touched tree
nodes retain structural semantics; reset is an explicit whole-document transition.
Root member groups remain incremental. Net-zero changes do not publish.
apply(changes, { expectedRevision }) rejects a missing or mismatched local baseline.
Received before values are untrusted; local undo records actual old state.
History travels complete ChangeSets; grouped travel is atomic. Local replace is a
reversible root reset; remote commits invalidate local history. Observer errors occur
after acceptance.

Use `project(document, path => path.tasks, mapper)` for incremental mapping.
Pure values use `project(sources, compute)`; stateful algorithms use tagged value
or collection specs. Definitions are lazy and are materialized by a
`createProjectionStore({ onError })` instance. Sources remain explicit.
`input` and `project(readable)` connect external boundary values. Dispose the store
with the owning service. `store.batch` defers projection settlement/listeners, not document commits/listeners. Reads
inside a batch see the last publication; no cross-document rollback is provided.

doxum/local-sync attaches IndexedDB and Web Lock leadership. Only the leader writes;
followers replay contiguous durable sequence. Writes become visible before async
persistence; flush waits for durability. External replace and external remote-marked
apply are forbidden while attached. Version 5 / format 3 rejects old storage without
deleting or migrating it. The adapter accepts JSON values only. Change limits count
logical members and tree nodes, not just outer groups.
Limits govern new local commits only; existing durable commits remain readable
under smaller current limits. Treat the whole published ChangeSet as readonly:
its identity carries reusable structural validation, not authority to skip local
revision, schema or actual-before checks.
