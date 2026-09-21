# Doxum Recipes

These are end-to-end public-API patterns. Adapt names and domain types; keep ownership and lifecycle semantics intact. Exact signatures live in [Public API](public-api.md).

## Canonical document with dynamic entities

```ts
import { createDocument, field, map, object, read, snapshot, type Infer } from 'doxum';

const task = object({
  title: field<string>(),
  done: field<boolean>(),
});

export const model = object({
  tasks: map(task),
});

export type DocumentValue = Infer<typeof model>;

const document = createDocument({
  schema: model,
  initial: {
    tasks: {
      a: { title: 'Write', done: false },
    },
  },
});

document.update(draft => {
  const task = draft.tasks.get('a');
  if (task) task.done = true;
  draft.tasks.put('b', { title: 'Review', done: false });
});

const done = read(document, value => value.tasks.get('a')?.done);
const durableTasks = read(document, value => snapshot(value.tasks));
```

Use `object` for addressable structure, `map` for dynamic membership, and `field` for atomic payloads.

## Atomic payload versus addressable structure

```ts
const position = object({
  x: field<number>(),
  y: field<number>(),
});

const model = object({
  position,
  stroke: field<readonly { x: number; y: number }[]>(),
  rows: list(field<{ id: string; label: string }>(), {
    keyOf: row => row.id,
  }),
});
```

Mutate `position.x` independently. Replace `stroke` whole. Edit `rows` through keyed list methods.

## Replace a nested member that contains collections

```ts
import { createDocument, field, map, object, replace, table } from 'doxum';

const model = object({
  entries: map(
    object({
      rows: table(object({ title: field<string>() })),
    })
  ),
});

const document = createDocument({
  schema: model,
  initial: {
    entries: {
      a: {
        rows: {
          ids: ['x'],
          byId: { x: { title: 'First' } },
        },
      },
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

Use top-level `replace(parent,key,value)` for object/variant members whose Draft representation contains collection tools. Use a collection's own `replace(next)` when the collection itself is the mutation target.

## Branded domain keys

```ts
type PersonId = string & { readonly __person: unique symbol };

const personId = (value: unknown): value is PersonId =>
  typeof value === 'string' && value.startsWith('person:');

const model = object({
  people: map(object({ name: field<string>() }), { key: personId }),
});

const initial = parse(model, {
  people: {
    'person:1': { name: 'Ada' },
  },
});
```

The branded key type flows through map/table methods, typed paths, impact, `observe`, and keyed projections.

## Ordered table edits

```ts
document.update(draft => {
  draft.rows.create('c', { title: 'C' }, { after: 'b' });
  draft.rows.move(['a', 'c'], { at: 'start' });
  draft.rows.replace('b', { title: 'Updated B' });
});
```

A multi-key move preserves the selected members' current relative order. `reorder(ids)` is for an exact full-membership permutation.

## Ordered list edits

```ts
const rows = list(field<{ id: string; label: string }>(), {
  keyOf: row => row.id,
});

document.update(draft => {
  draft.rows.insert({ id: 'c', label: 'C' }, { at: 'start' });
  draft.rows.move('c', { after: 'a' });
  draft.rows.replace('a', { id: 'a', label: 'A+' });
});
```

Member replacement keeps the addressed stable key.

## Tree edits

```ts
const model = object({
  outline: tree(field<{ title: string }>()),
});

document.update(draft => {
  draft.outline.insert('root', { title: 'Root' });
  draft.outline.insert('child', { title: 'Child' }, { parentId: 'root', index: 0 });
  draft.outline.move('child', { index: 0 });
  draft.outline.replace('child', { title: 'Renamed' });
});
```

Use tree operations for topology. Never manually patch `rootId`, `parentId`, or `children` records.

## Expected transaction rejection

```ts
const result = document.update(draft => {
  const row = draft.rows.get(id);
  if (!row) {
    throw new TransactionRejected({
      code: 'missing-row',
      message: 'Row does not exist',
    });
  }
  row.title = title;
});

if (result.status === 'rejected') {
  showIssues(result.issues);
}
```

Use `TransactionRejected` only for expected application rejection. Ordinary exceptions are bugs/infrastructure failures and are rethrown after rollback.

## Fine-grained document selector

```ts
const selectedTitle = select(document, value => value.rows.get(activeId)?.title);

const stop = selectedTitle.subscribe(() => {
  render(selectedTitle.current());
});
```

The selector dynamically tracks what it actually reads and rebinds when branches change.

## Commit path subscription

```ts
const stop = document.subscribe(
  path => path.rows.item(rowId).title,
  commit => {
    console.log(commit.revision, commit.changes);
  }
);
```

Use path subscription when the consumer cares about canonical commit occurrence at a known schema location.

## History group

```ts
const group = document.history.group();
try {
  document.update(draft => editPartA(draft));
  document.update(draft => editPartB(draft));
  group.end();
} catch (error) {
  group.cancel();
  throw error;
}
```

Undo/redo travels committed ChangeSets. Grouping is a history concern, not a cross-transaction rollback mechanism for arbitrary external side effects.

## Apply external ChangeSet

```ts
const result = document.apply(incomingChanges, {
  expectedRevision: document.revision(),
  source: 'remote',
});

if (result.status === 'rejected') {
  handleMutationIssues(result.issues);
}
```

Always provide the baseline revision. Do not trust incoming `before` fields as authority over local state.

## Basic projection pipeline

```ts
const rows = observe(document, path => path.rows);
const filter = input<'all' | 'open'>('all');

const visible = derive.keyed.filter(
  rows,
  { filter },
  (row, _id, { filter }) => filter === 'all' || !row.done
);

const labels = derive.keyed(visible, row => row.title);
const count = derive({ labels }, ({ labels }) => labels.size);

const runtime = createProjectionRuntime({ onError: reportProjectionError });

runtime.read(labels);
runtime.read(count);
runtime.update(filter, 'open');
```

Use projection input for Runtime-local UI/application state. Keep it out of the canonical document unless the state needs document history/persistence/replay semantics.

## Dynamic keyed join

```ts
const cards = derive.keyed(
  items,
  {
    record: { source: records, key: item => item.recordId },
    related: { source: records, keys: item => item.relatedRecordIds },
    density,
  },
  (item, itemId, { record, related, density }) => buildCard(itemId, item, record, related, density)
);
```

The Runtime owns reverse invalidation. Do not subscribe to `records` and manually maintain `recordId -> itemIds` just for dependency routing.

## Ordered keyed entries as a scalar value

```ts
const entries = derive.keyed.entries(records);
```

Use this instead of a two-stage `derive.keyed(records, (value,key) => [key,value])` followed by `values`.

## Active keyed lookup

```ts
const activeId = input<RowId | undefined>(undefined);
const activeRow = derive.keyed.get(rows, activeId);
```

The binding remains meaningful while the selected key is absent and reacts if that key appears later.

## Reverse index / groupBy

```ts
const recordIdsBySection = derive.keyed.groupBy(records, record => record.sectionIds);
```

Output is keyed by section id; each value is ordered source record ids. Use this instead of maintaining a global reverse-index Map in application code.

Group keys follow first appearance in the source's formal order. If one source record returns several groups, those groups use the selector's returned order for that record when they first appear together.

## Optional scalar to keyed singleton

```ts
const activeRecordCollection = derive.keyed.singleton(activeRecord, record => record.id);
```

`undefined` becomes empty membership; present value becomes one keyed member.

## Stable keyed item Readables

```ts
const items = runtime.items(rows);
const row = items.get(rowId);

const stop = row.subscribe(() => {
  renderRow(row.current());
});
```

Use `items.keys` for ordered membership and `items.get(key)` for one membership-lifecycle readable. Avoid business/React layers maintaining their own selector cache.

## Runtime-local keyed UI state

```ts
const selection = input.collection<RowId, boolean>();

runtime.update(selection, draft => {
  draft.set(rowId, true);
  draft.remove(previousId);
});
```

If the edit callback or entry equality throws, no partial next collection state is installed.

## Scoped projection lifecycle

```ts
const scope = runtime.scope();

const localFilter = scope.own(input<'all' | 'open'>('all'));
const localVisible = scope.own(
  derive.keyed.filter(
    rows,
    { filter: localFilter },
    (row, _id, { filter }) => filter === 'all' || !row.done
  )
);

scope.read(localVisible);
scope.update(localFilter, 'open');
scope.dispose();
```

Own the definition before it is first materialized as a root. Use scope for lifecycle, not as a second graph implementation.

## Stateful keyed calculation

```ts
import { incremental } from 'doxum/advanced';

const sectionTotals = incremental.keyed(
  sections,
  {
    records: { source: records, keys: section => section.recordIds },
  },
  {
    state: () => ({ runs: 0 }),
    process: ({ dependencies, state }) => {
      state.runs++;
      let total = 0;
      for (const record of dependencies.records.values()) total += record.amount;
      return total;
    },
  }
);
```

Use this when each driver key truly needs retained state. If the value is a pure function of current dependencies, ordinary `derive.keyed` is simpler.

## Direct incremental collection patch

```ts
const projected = incremental.collection(
  { rows },
  {
    process: ({ values, changes, output, reset }) => {
      if (reset) {
        for (const [id, row] of values.rows) output.set(id, project(row));
        output.order([...values.rows.keys()]);
        return;
      }

      const change = changes.rows;
      if (!change || change.kind === 'reset') return;
      for (const item of change.added) output.set(item.key, project(item.after));
      for (const item of change.updated) output.set(item.key, project(item.after));
      for (const item of change.removed) output.remove(item.key);
      if (change.order) output.order([...values.rows.keys()]);
    },
  }
);
```

Prefer ordinary keyed derive for pure per-entry projection. Use direct patching when the incremental algorithm itself is the requirement.

## Multi-output incremental processor

```ts
const render = incremental.group(
  { scene },
  {
    output: define => ({
      cards: define.collection<CardId, Card>(),
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

Use one group only when outputs actually share retained state or incremental work.

## React provider and hooks

```tsx
const runtime = useMemo(() => createProjectionRuntime({ onError: report }), []);
useEffect(() => () => runtime.dispose(), [runtime]);

return (
  <ProjectionProvider value={runtime}>
    <Rows />
  </ProjectionProvider>
);
```

Inside components:

```tsx
const rows = useProjection(visibleRows);
const active = useProjection(rowsProjection, rows => rows.get(activeId));
const [filter, setFilter] = useInput(filterInput);
const title = useDocumentSelector(document, value => value.title);
```

Keep Runtime creation/disposal at a stable application/component boundary.

## External source adapter

```ts
const external: ExternalValueSource<number> = {
  kind: 'value',
  current: () => current,
  revision: () => revision,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const projected = observe(external);
```

On update, update the source's current state/revision, then notify listeners with `{ value, revision, cause? }`.

## Local sync

```ts
const sync = await attachLocalSync({
  runtime: document,
  database: 'app',
  documentId: 'doc:1',
  schemaVersion: 1,
  onError: reportSyncError,
});

await sync.flush();
await sync.dispose();
```

Local-sync provides browser durability and leadership. Keep network collaboration, server authorization, and distributed merge policy in a separate boundary.
