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

Edit position.x, replace stroke whole, use rows.set(key, value) for keyed item edits.

## Complex Replacement

```ts
const model = object({
  entries: map(object({ rows: table(object({ title: field<string>() })) })),
});
const document = createDocument({ schema: model, initial: { entries: {} } });
document.update(draft => {
  assign(draft.entries, 'a', { rows: { ids: ['x'], byId: { x: { title: 'First' } } } });
  draft.entries.a!.rows.get('x')!.title = 'Updated';
});
```

TypeScript cannot express different read/write types for mapped properties.
assign checks Infer replacement data and uses the same mutation session.

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

Brands flow through indexed access, table methods, symbolic paths and collection impact.

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
const projection = createProjectionRuntime({ onError: console.error });
const titles = projection.map(
  projection.document(document).collection(path => path.tasks),
  (_id, task) => task.title
);
const total = projection.value({ titles }, ({ titles }) => titles.ids().length);
const zoom = projection.input(1);
const scaled = projection.value(
  { total, zoom: zoom.source },
  ({ total, zoom }) => total.value * zoom.value
);
```

Use useReadable for values, ids, all and item(id); useHistory for document.history.
Custom collection processors stage writer.set/remove/order/replace and use scoped
previous/next reads. Candidates span the complete batch; derive output from final state.
Processor dependencies are explicit even though React selectors track actual reads.
