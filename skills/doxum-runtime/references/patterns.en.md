# Doxum Patterns

Exact call shapes and callback fields are listed in the [API reference](api.en.md).

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
const document = createDocument({
  schema: model,
  initial: {
    entries: {
      a: { rows: { ids: ['x'], byId: { x: { title: 'First' } } } },
    },
  },
});
document.update(draft => {
  const entry = draft.entries.get('a')!;
  replace(entry, 'rows', {
    ids: ['y'],
    byId: { y: { title: 'Replacement' } },
  });
});
```

Use top-level `replace(parent, key, value)` for object/variant members whose Draft
type contains collection tools. Map membership still uses `put`/`remove`; a
collection's own `replace(next)` handles replacement when the collection itself is
the mutation target.

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

Branded key types flow through map/table methods, symbolic paths and collection impact.

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
const rows = observe(document, path => path.rows);
const metadata = observe(document, path => path.metadata);
const density = input<'compact' | 'comfortable'>('comfortable');

const labels = derive.keyed(rows, row => row.label);
const decorated = derive.keyed(
  rows,
  {
    meta: { source: metadata, key: row => row.metadataId },
    density,
  },
  (row, { meta, density }) => formatRow(row, meta, density)
);
const count = derive([labels], labels => labels.size);
const runtime = createProjectionRuntime({ onError: console.error });
runtime.get(decorated);
runtime.get(count);
```

Provide the Runtime through `ProjectionProvider`, then use `useProjection` for
projection definitions and `useProjection(projection, selector)` for keyed reads.
`useInput` returns a value and setter. `derive.keyed` owns key-preserving selection
and declared dynamic keyed lookup; the Runtime owns its reverse dependency index.
Use tuple `derive` when the result is an aggregate or otherwise has no preserved
per-key identity.
Advanced collection processors in `doxum/advanced` stage `output.set/remove/order`
and use scoped previous/next reads for custom retained/cross-key algorithms.
Processor dependencies remain explicit even though React selectors track actual reads.

## Multi-output incremental processor

```ts
const render = incremental.group(
  [scene],
  define => ({
    cards: define.collection<string, Card>(),
    count: define.value<number>(),
  }),
  ({ sources, outputs }) => {
    const cards = buildCards(sources[0]);
    for (const [id, card] of cards) outputs.cards.set(id, card);
    outputs.cards.order([...cards.keys()]);
    outputs.count.set(cards.size);
  }
);
```

`define.value` / `define.collection` exist only inside the `incremental.group`
declaration callback. Return a nested plain object when related output namespaces belong
to the same processor.
