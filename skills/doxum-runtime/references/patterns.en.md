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
  (row, _rowId, { meta, density }) => formatRow(row, meta, density)
);
const count = derive({ labels }, ({ labels }) => labels.size);
const selection = input.collection<RowId, boolean>();
const runtime = createProjectionRuntime({ onError: console.error });
runtime.read(decorated);
runtime.read(count);
runtime.update(density, 'compact');
runtime.update(selection, draft => draft.set(rowId, true));
```

Use named-object `derive` for aggregate values. Use `derive.keyed` when one keyed
driver owns output keys/order. Its named dependency form handles dynamic keyed lookups;
the Runtime owns the binding/reverse index. Use `input.collection` for Runtime-local
keyed UI/application state rather than canonical document state.

Provide the Runtime or a scope through `ProjectionProvider`. `useProjection` reads
projections, including `useProjection(projection, selector, equality?)`; `useInput`
handles both scalar and collection inputs. Document selectors use
`useDocumentSelector(document, selector, equality?)` independently of the provider.

## Multi-output incremental processor

Use this only when outputs share retained state or cross-key work that pure `derive`
and `derive.keyed` cannot express:

```ts
const render = incremental.group(
  { scene },
  {
    output: define => ({
      cards: define.collection<string, Card>(),
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, output, state }) => {
      state.runs++;
      const cards = buildCards(values.scene);
      for (const [id, card] of cards) output.cards.set(id, card);
      output.cards.order([...cards.keys()]);
      output.count.set(cards.size);
    },
  }
);
```

`define.value` / `define.collection` exist only inside the `output` declaration.
The returned nested object mirrors ordinary Projection leaves from one processor.
Dependencies are named; declare `state()` only when retained state is needed. Runtime
recovery recreates declared state after a processor fault.
