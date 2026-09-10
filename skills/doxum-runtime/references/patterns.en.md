# Doxum Patterns

## Payload Or Structure

```ts
const point = object({ x: field<number>(), y: field<number>() });
const model = object({
  position: point,
  stroke: field<readonly { x: number; y: number }[]>(),
  rows: list(field<{ id: string; label: string }>(), { keyOf: row => row.id }),
});
```

Edit position.x, replace stroke whole, and use rows.replace(key, value) for keyed item edits.

## Complex Replacement

```ts
const model = object({
  entries: map(object({ rows: table(object({ title: field<string>() })) })),
});
const document = createDocument({ schema: model, initial: { entries: {} } });
document.update(draft => {
  draft.entries.put('a', { rows: { ids: ['x'], byId: { x: { title: 'First' } } } });
  draft.entries.get('a')!.rows.get('x')!.title = 'Updated';
});
```

Map entries use put. Use top-level replace for object/variant members whose Draft
type contains collection tools; collection replace(next) handles whole containers.

## Domain Keys

```ts
type PersonId = string & { readonly __person: unique symbol };
const personId = (value: unknown): PersonId => {
  if (typeof value !== 'string' || !value.startsWith('person:')) throw new Error('Person ID');
  return value as PersonId;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('String required');
  return value;
};
const model = object({ people: map(object({ name: field(text) }), { key: personId }) });
const initial = parse(model, { people: { 'person:1': { name: 'Ada' } } });
```

Brands flow through map/table methods, symbolic paths and collection impact.

## Ordered Edits, History And Replay

Use table.create/remove/move with anchors such as { at: 'start' } or { before: id }.
Tree insert/move accept { parentId, index }; index is the final position after removal.
Never directly edit topology records.

A history group begins with document.history.group(); end() groups completed commits,
cancel() restores its start. undo/redo travel complete ChangeSets atomically.
Apply incoming changes with an expectedRevision and adapter-validated transport order.
Remote commits invalidate local history. Local revision is not a distributed clock.

Incoming member changes share the owning container address:

```ts
document.apply(
  {
    changes: [
      {
        kind: 'members',
        at: ['tasks', 'a'],
        members: [
          { key: 'complete', kind: 'updated', before: false, after: true },
          { key: 'title', kind: 'updated', before: 'First', after: 'Done' },
        ],
      },
    ],
  },
  { expectedRevision: document.revision() }
);
```

Use one group per container. Added members carry only after, removed members only
before; present undefined is still a value. Never expand a group into legacy value
envelopes or treat its container address as whole-container invalidation.

## Projection And React

```ts
const titles = project(
  document,
  path => path.tasks,
  (_id, task) => task.title
);
const total = project({ titles }, ({ titles }) => titles.ids().length);
const zoom = input(1);
const scaled = project({ total, zoom }, ({ total, zoom }) => total * zoom);
const store = createProjectionStore({ onError: console.error });
store.get(scaled);
```

Use `useProjection` with a store for projection definitions; use `useReadable`
for history and other existing Readable values. Custom collection processors stage
writer.set/remove/order/replace and use scoped previous/next reads. Candidates span
the complete batch; derive output from final state. Processor dependencies remain
explicit even though React selectors track actual reads. Use a mapper only when a
source key affects the same output key. For cross-collection joins, declare every
source and maintain the domain's reverse dependency index as described in the
[projection reference](projections.en.md).
