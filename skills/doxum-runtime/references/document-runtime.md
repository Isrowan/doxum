# Doxum Document Runtime

Use this reference for schema design, canonical document mutation, reads, subscriptions, history, replay, impact, validation, and tree behavior. Exact signatures and exported types are in [Public API](public-api.md).

## Mental model

A Doxum document has one canonical owner: `DocumentRuntime`. The schema defines structure and identity; the runtime owns canonical data, revision, mutation, ChangeSets, history, and commit publication.

Use these representation choices consistently:

| Requirement                                             | Model                         |
| ------------------------------------------------------- | ----------------------------- |
| Fixed named structure                                   | `object({...})`               |
| Tagged union of object branches                         | `variant(tag, variants)`      |
| Arbitrary payload replaced as one value                 | `field<T>()`                  |
| Dynamic keyed values without explicit order             | `map(valueSchema)`            |
| Ordered keyed object/variant entities                   | `table(entitySchema)`         |
| Ordered atomic items with stable identity from the item | `list(field<T>(), { keyOf })` |
| Parent/child topology                                   | `tree(field<T>())`            |
| Optional member                                         | `optional(schema)`            |

Do not model dynamic keys as undeclared object properties. Object/variant input is closed to declared own members; dynamic domains belong in maps or fields.

## Atomic payloads and structure

`field<T>` is atomic. If `T` is an object, array, `Map`, `Set`, or `Date`, Doxum still treats the whole payload as one value. Access is deeply readonly through `ReadonlyValue<T>` and mutation replaces the payload whole.

Use structure when Doxum must understand and address nested edits. For example:

```ts
const point = object({
  x: field<number>(),
  y: field<number>(),
});

const stroke = field<readonly { x: number; y: number }[]>();
```

`point.x` can change independently and participates in path impact. `stroke` changes as one atomic payload.

Published atomic payload references are shared across snapshots, commits, and history. Treat them as immutable through every alias. Doxum does not deep-freeze application payloads and does not clone them merely to defend against mutation.

## Schema handles and inferred types

Use `Schema<T>` / `ObjectSchema<T>` as the portable schema boundary and `Infer<typeof schema>` for the canonical value type.

```ts
const task = object({
  title: field<string>(),
  done: field<boolean>(),
});

const model = object({
  tasks: map(task),
});

type DocumentValue = Infer<typeof model>;
```

Export inferred schema constants directly. Do not expose internal node types or wrap public schemas in `ReturnType<typeof object>` to make declarations portable.

## Optionality

Optionality is structural presence, not an ordinary value convention.

```ts
const model = object({
  nickname: optional(field<string>()),
  settings: optional(map(field<string>())),
});
```

Absent and present-with-`undefined` are distinct where the schema permits an atomic `undefined` payload. Use the schema's optional shape rather than inventing sentinel members.

Tree optionality has two separate meanings:

- `tree(optional(field<T>()))`: each existing node may omit `value`.
- `optional(tree(field<T>()))`: the whole tree member may be absent.

## Validators and parse

Validators are synchronous and pure. A function validator may be a predicate or assertion:

```ts
const taskId = (value: unknown): value is TaskId =>
  typeof value === 'string' && value.startsWith('task:');
```

Returning `true` or `undefined` means success; returning `false` rejects. An assertion may throw. Standard Schema v1 validators are also accepted, but successful validation must return the same input by identity. Doxum does not accept validator transforms.

Transform external values before they enter Doxum. Use `parse(schema, unknownValue)` to validate unknown input and build schema-owned structure while sharing readonly atomic payloads.

Map/table key validators define the public key type and apply at parse/mutation boundaries:

```ts
const model = object({
  tasks: map(task, { key: taskId }),
});
```

Branded key types then flow through collection methods, typed paths, impact, and keyed projections.

## Creating the canonical runtime

```ts
const document = createDocument({
  schema: model,
  initial,
  history: { capacity: 100 },
});
```

`createDocument` is the only canonical state owner. Do not mirror canonical document state in a second writable store and synchronize both manually.

`document.readonly()` returns a read/subscription-only alias bound to the same runtime identity.

## Update lifecycle

```ts
const result = document.update(draft => {
  const task = draft.tasks.get(taskId);
  if (!task) throw new TransactionRejected({ code: 'missing-task', message: 'Task missing' });
  task.done = true;
  return taskId;
});
```

A transaction is synchronous and atomic:

- reads inside the callback see preceding writes in the same transaction;
- all accepted writes publish together as one commit;
- an ordinary thrown value rolls back all work and is rethrown unchanged;
- `TransactionRejected` rolls back and returns `status: 'rejected'` with application diagnostics;
- returning `false`, `undefined`, or any other ordinary value is just a callback result, not a rejection signal;
- a net-zero transaction returns `status: 'unchanged'` and publishes no commit.

The callback may not return a Promise.

### Source and history options

`update` accepts `{ source?: 'local' | 'system', history?: boolean }`.

- `local` is the default application-authored commit source.
- `system` is for application/system work that is still local canonical mutation.
- `history: false` prevents the commit from entering local undo history.

## Borrowed Draft/Read lifetime

Draft/read access objects are synchronous borrowed capabilities. Do not retain any Draft/Read object, collection accessor, or method past its callback.

Wrong:

```ts
let tasks;
document.update(draft => {
  tasks = draft.tasks;
});
tasks.put('later', value);
```

Use a durable value or a fresh callback instead. When a read must outlive the callback, use `snapshot`:

```ts
const tasks = read(document, state => snapshot(state.tasks));
```

`snapshot` copies schema structure and shares atomic payload references under the readonly ownership contract.

## Collection mutation rules

### Map

A map is unordered dynamic membership.

```ts
draft.tasks.put(id, value); // upsert
draft.tasks.remove(id); // missing is a no-op
draft.tasks.replace(nextRecord);
```

### Table

A table is ordered membership plus object/variant entities.

```ts
draft.rows.create(id, value, { at: 'start' });
draft.rows.create([{ id, value }, ...], { after: existingId });
draft.rows.remove(idOrIds);
draft.rows.move(idOrIds, { before: anchorId });
draft.rows.reorder(exactCurrentMembership);
draft.rows.replace(id, value);
draft.rows.replace({ ids, byId });
```

`replace(id,value)` preserves that member's order position. `reorder` requires an exact permutation of current membership.

### List

A list stores atomic items and derives stable identity from `keyOf`.

```ts
draft.rows.insert(value, { after: id });
draft.rows.remove(id);
draft.rows.move(idOrIds, { at: 'end' });
draft.rows.reorder(exactIds);
draft.rows.replace(id, replacementWithSameKey);
draft.rows.replace(nextArray);
```

Member replacement must retain the addressed stable key.

### Move semantics

For table/list `move(selection, anchor?)`, Doxum first removes the selection, preserves the selected members' current relative order, then resolves the anchor against the remaining sequence. Omitting the anchor means end.

### Tree

Trees are empty or one connected single-root tree. Nodes have reciprocal parent/children topology and no cycles.

```ts
draft.outline.insert(id, value, { parentId, index });
draft.outline.move(id, { parentId, index });
draft.outline.remove(id);
draft.outline.replace(id, newPayload);
draft.outline.replace(wholeTree);
```

`index` is the final child position after removal from the old location. A tree member replacement must satisfy full topology invariants at the boundary.

Do not edit `rootId`, `parentId`, `children`, or `nodes` as raw records through application code; use tree operations.

## Replacing complex object/variant members

Draft object/variant members that contain collection nodes expose collection capabilities rather than plain assignable data. To replace one such member from a plain `Infer` value, use top-level `replace`:

```ts
document.update(draft => {
  replace(draft.settings, 'rows', {
    ids: ['a'],
    byId: { a: { title: 'A' } },
  });
});
```

A collection's own `replace(next)` remains the normal whole-collection replacement when the collection itself is the mutation target.

## Reading canonical state

Use `document.snapshot()` for a durable whole-document value.

Use `read` for one synchronous selector read:

```ts
const done = read(document, state => state.tasks.get(taskId)?.done);
```

Use `select` for a revisioned `Readable`:

```ts
const selected = select(document, state => state.tasks.get(taskId)?.done);
const stop = selected.subscribe(() => render(selected.current()));
```

`select` tracks actual reads, including branching, and rebinds dependencies when the selector's read set changes. Equality defaults to `Object.is`; supply custom equality only for the projected result, not to redefine document semantics.

## Typed paths and subscriptions

Path callbacks describe schema locations without reading current data:

```ts
const stop = document.subscribe(
  path => path.tasks.item(taskId).done,
  commit => handle(commit)
);
```

You can subscribe to one path or a non-empty array of paths. Paths compile when the subscription/impact query is registered. They remain meaningful even when an optional/member path is currently absent.

Tree paths expose:

```ts
path.outline.rootId;
path.outline.nodes;
path.outline.nodes.item(nodeId);
```

## Commits and observer errors

An accepted commit contains:

- monotonic local `revision`;
- `source` (`local`, `system`, `history`, `remote`);
- exact normalized reversible `changes`;
- exact `impact` queries.

Commit listeners and projection processing occur after canonical acceptance. Their failures do not turn an accepted mutation into a rejected one. `TransactionResult` / `OperationResult` report post-commit observer failures in `observerErrors`.

## ChangeSet semantics

A member group owns one container address:

```ts
{
  kind: 'members',
  at: ['tasks', taskId],
  members: [
    { key: 'title', kind: 'updated', before: 'A', after: 'B' },
    { key: 'done', kind: 'updated', before: false, after: true },
  ],
}
```

An ordered container may include `order: { before, after }` in the same group. Order-only groups have an empty `members` array. There is no standalone order change kind.

Tree changes use one tree-container address plus changed node transitions and before/after root id. Whole-document reset is explicit.

ChangeSets are final net changes, not an operation log. Multiple writes that cancel out do not publish a change.

## Applying external ChangeSets

```ts
const result = document.apply(changes, {
  expectedRevision: document.revision(),
  source: 'remote',
});
```

`expectedRevision` is mandatory. External `before` data is transport input, not authority: Doxum checks local baseline/state and records actual local before values for reversible local history.

A remote commit invalidates local history. Treat local revision as a local concurrency baseline, not as a globally distributed clock.

## History

```ts
const group = document.history.group();
try {
  document.update(...);
  document.update(...);
  group.end();
} catch (error) {
  group.cancel();
  throw error;
}
```

`undo()` / `redo()` travel complete ChangeSets atomically. `group().end()` groups completed history entries; `cancel()` restores the group's start through history travel.

A local whole-document replace is reversible. Remote commits clear/invalidate local history because the old local history baseline no longer describes the canonical branch.

## Impact

Use commit impact instead of manually parsing ChangeSets for ordinary subscription/application invalidation questions:

```ts
if (commit.impact.affects(path => path.tasks.item(id).done)) { ... }

const impact = commit.impact.collection(path => path.tasks);
if (impact.kind === 'incremental') {
  impact.added;
  impact.removed;
  impact.updated;
  impact.orderChanged;
}
```

Use raw `ChangeSet` only when the exact reversible transport is itself the requirement.

## Disposal

`document.dispose()` ends the runtime. Later access throws `DocumentDisposedError`. Own the document runtime at the application/service boundary that owns its canonical state.
