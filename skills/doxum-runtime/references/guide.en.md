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
synchronous and atomic. Reads see preceding writes. Structural scopes expire at
callback return. Throw TransactionRejected for expected rejection; ordinary throws
restore all work and rethrow unchanged. False/undefined returns are business values.

Object exposes editable members; field is atomic, including arrays and objects.
Scoped atomic values are deeply readonly. Canonical copies preserve atomic references:
honor their ownership contract and stop mutating supplied payloads. Snapshot detaches
values. Snapshot a structural subtree to invoke configured field copiers; a raw atomic
value has no schema association and uses generic copying.

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

Synchronous value-preserving functions and Standard Schema v1 validators are supported.
parse(model, unknown) returns independent validated data; strict parse requires atomic
validators. Branded map/table keys flow through access, symbolic paths and impact.
Path callbacks describe locations, including absent entries, and compile at registration.
React useDocumentSelector tracks actual reads and changes dependencies when branching.

## Changes And Consumers

Commits contain revision/source/changes/impact. ChangeSet holds final value/presence,
order and touched tree-node facts. Net-zero changes do not publish.
apply(changes, { expectedRevision }) rejects a missing or mismatched local baseline.
Received before values are untrusted; local undo records actual old state.
History travels complete ChangeSets; grouped travel is atomic. Local replace is a
reversible root reset; remote commits invalidate local history. Observer errors occur
after acceptance.

Use projection.document(document).collection(path => path.tasks) and projection.map
for incremental mapping. Pure values use projection.value(sources, compute); stateful
algorithms use value specs or projection.collection<T>()(spec). Sources are explicit.
Input/fromReadable connect external boundary values. Dispose with the owning service.
Batch defers projection settlement/listeners, not document commits/listeners. Reads
inside a batch see the last publication; no cross-document rollback is provided.

doxum/local-sync attaches IndexedDB and Web Lock leadership. Only the leader writes;
followers replay contiguous durable sequence. Writes become visible before async
persistence; flush waits for durability. External replace and external remote-marked
apply are forbidden while attached. Version 3 / format 1 rejects old storage without
deleting or migrating it. The adapter accepts JSON values only.
