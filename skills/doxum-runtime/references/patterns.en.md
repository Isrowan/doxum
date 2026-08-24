# Doxum Patterns

Read this reference when implementing Doxum application code. It is organized by
the decisions that preserve the runtime model, rather than by an exhaustive
list of exported symbols.

## Model data by its mutation semantics

| Need                            | Schema node                | Canonical value     | Writer behavior                              |
| ------------------------------- | -------------------------- | ------------------- | -------------------------------------------- |
| One scalar or immutable leaf    | `field<T>()`               | `T`                 | `set`, and `clear` for an optional field     |
| Nested named fields             | `object({ ... })`          | object              | child writers                                |
| Tagged structural alternatives  | `variant('kind', { ... })` | tagged object       | `replace` the complete branch value          |
| One structured entity           | `single(entity)`           | object              | child writers                                |
| Ordered entities                | `table(entity)`            | `{ ids, byId }`     | `create`, `item`, `remove`, `move`           |
| Unordered entities              | `map(entity)`              | id record           | `create`, `item`, `remove`                   |
| Scalar record                   | `record<Id, T>()`          | complete record     | `set`, `delete`, `replace`                   |
| Sparse scalar dictionary        | `dict<Key, T>()`           | partial record      | `set`, `delete`, `replace`                   |
| Ordered scalar/structural items | `list({ keyOf })`          | array               | `insert`, `move`, `remove`, `replace`        |
| One rooted hierarchy            | `tree<T>()`                | `{ rootId, nodes }` | `insert`, `move`, `remove`, `set`, `replace` |

Use a table when ordering is product-visible. Do not use a map plus a separate
array of ids: that creates two mutation protocols and two sources of order.
Use a list only when every item has a stable, unique application key; never use
the current index as `keyOf`.

```ts
import { field, list, map, object, schema, table, tree } from 'doxum';

type Tag = { id: string; name: string };

const note = object({ body: field<string>() });
const documentSchema = schema({
  notes: table(note),
  tags: list<Tag>({ keyOf: tag => tag.id }),
  collaborators: map(object({ name: field<string>() })),
  outline: tree<{ title: string }>(),
});
```

## Local domain command: read, validate, write

Keep a domain command inside one transaction when all of its changes must
succeed or fail together. Read before creating operations when a business rule
depends on current state; call `tx.reject` for a blocking application rule.

```ts
function completeTask(id: string) {
  return runtime.update(tx => {
    const task = tx.read.tasks.get(id);
    if (!task) {
      tx.reject({
        source: 'application',
        code: 'task-not-found',
        message: `Task '${id}' does not exist.`,
        address: ['tasks', id],
      });
    }
    if (task.completed.get()) return { changed: false };

    tx.write.tasks.item(id).completed.set(true);
    tx.report({
      source: 'application',
      code: 'task-completed',
      message: 'Task marked complete.',
      address: ['tasks', id],
    });
    return { changed: true };
  });
}
```

`tx.report` does not reject the transaction. It is suitable for warnings,
audit-oriented feedback, or application messages that should accompany a valid
commit. `tx.reject` stops the transaction by returning a rejected result to the
outer caller. Neither is a substitute for malformed-operation handling:
engine failures are `MutationIssue` values supplied by Doxum.

## Apply external operations at one boundary

Keep serialization, authorization, network ordering, and conflict policy in an
application adapter. Once that adapter decides a batch may be applied, pass the
whole batch to Doxum.

```ts
async function receiveRemote(batch: unknown) {
  // Authenticate, order, de-duplicate, and choose conflict policy here.
  const result = runtime.apply(batch, {
    source: 'remote',
    history: false,
  });

  if (result.status === 'rejected') {
    logRejectedOperations(result.issues);
    return;
  }
  if (result.status === 'committed') reportObserverErrors(result.observerErrors);
}
```

The cast above belongs only at a dynamic boundary whose runtime input is
actually unknown. Keep it there; do not loosen operation types throughout the
application. Doxum still validates malformed envelopes and semantic invalidity
before publishing a commit.

Use `replace` only for a new, trusted canonical snapshot. It produces reset
impact and invalidates local history. It is not a convenient way to express a
small change.

## Place ordered entries with anchors

Tables and lists use one `DocumentAnchor` vocabulary:

```ts
{
  at: 'start';
}
{
  at: 'end';
}
{
  before: 'other-id';
}
{
  after: 'other-id';
}
```

Use anchors instead of calculating indices in application code. They name the
domain position, let Doxum validate missing references, and keep table, list,
and operation replay semantics aligned.

```ts
runtime.update(tx => {
  tx.write.tasks.create({ id: 'review', value: newTask }, { before: 'publish' });
  tx.write.tags.insert({ id: 'urgent', name: 'Urgent' }, { at: 'start' });
  tx.write.tags.move('urgent', { after: 'planning' });
});
```

## Work with trees as one invariant

A Doxum tree is either empty or a single connected root. Its `nodes` maintain
reciprocal parent/child links, unique children, full reachability, and no
cycles. Root replacement validates the whole snapshot; local writers preserve
the invariant incrementally.

```ts
runtime.update(tx => {
  tx.write.outline.insert('root', { title: 'Project' });
  tx.write.outline.insert('plan', { title: 'Plan' }, 'root');
  tx.write.outline.move('plan', 'root', 0);
  tx.write.outline.set('plan', { title: 'Plan release' });
});
```

Create the root with no `parentId` only when the tree is empty. Once a root
exists, every inserted node needs an existing parent. Do not move a non-root
node to `undefined`, re-parent the root, or directly edit `{ rootId, nodes }`
outside a validated `tree.replace` or runtime `replace` snapshot.

## Select and subscribe with the domain target

Create selectors once with their owning schema. This creates a stable public
contract for subscriptions and impact interpretation.

```ts
const notes = documentSchema.collection(path => path.notes);
const body = documentSchema.value(path => path.notes.item('a').body);

const unsubscribe = runtime.subscribe([notes, body], commit => {
  if (commit.impact.affects(body)) refreshNoteUI();

  const change = commit.impact.collection(notes);
  if (change.kind === 'incremental' && change.updated.has('a')) refreshRow('a');
});
```

Use `target.same(left, right)` only when you need to compare two impact targets
as values. Use `target.address`, `target.id`, `target.belongs`, and
`target.bucket` rather than duplicating their interpretation in a framework
adapter or local helper.

## Build a collection view for mapped rows

Use a collection view when a table or map needs a reusable read model. Its
mapping callback can read the entry's typed fields; `isEqual` lets the view
retain a previous mapped value when a remapped row is semantically unchanged.

```ts
const notes = documentSchema.collection(path => path.notes);

const noteSummaries = createCollectionView({
  runtime,
  source: notes,
  map: (id, note) => ({ id, preview: note.body.get().slice(0, 80) }),
  isEqual: (left, right) => left.id === right.id && left.preview === right.preview,
});

const stop = noteSummaries.item('a').subscribe(() => rerenderRow('a'));
const all = noteSummaries.all.current();
```

Do not make callers push changes into the view. It listens to its declared
source and recomputes from runtime state. Dispose `noteSummaries` and `stop`
with the UI or service that owns them.

## Build a materialized aggregate or index

Use a materialized view when you own an aggregate that can update from a
commit. During `update`, inspect the impact through the provided `impact`
object. That records the actual dependencies, so future unrelated commits can
skip this update.

```ts
const notes = documentSchema.collection(path => path.notes);

const noteCount = createMaterializedView(runtime, {
  build: ({ read }) => ({
    value: read.notes.ids().length,
    update: ({ impact, read }) => {
      const change = impact.collection(notes);
      if (
        change.kind === 'incremental' &&
        change.added.size === 0 &&
        change.removed.size === 0 &&
        change.updated.size === 0 &&
        !change.orderChanged
      ) {
        return { kind: 'unchanged' };
      }
      return {
        kind: 'changed',
        value: read.notes.ids().length,
        change,
      };
    },
  }),
});
```

Return `rebuild` if local incremental logic cannot safely handle a commit.
Views created later can name earlier views in `sources`; Doxum processes that
graph in creation order and flushes it before external listeners observe the
commit.

## Bind read models in React

For a direct document read, use `useDocumentSelector`. It tracks paths and
collection entries read during each selector execution, including dynamic
dependencies.

```tsx
function Note({ id }: { id: string }) {
  const body = useDocumentSelector(runtime, read => read.notes.get(id)?.body.get());
  return <p>{body ?? 'Missing note'}</p>;
}
```

For an existing read model, use its narrower hook:

```tsx
function NoteRow({ id }: { id: string }) {
  const summary = useReadable(noteSummaries.item(id));
  return <p>{summary?.preview}</p>;
}

function UndoButton() {
  const history = useHistory(runtime.history);
  return (
    <button disabled={history.undoDepth === 0} onClick={() => history.undo()}>
      Undo
    </button>
  );
}
```

Keep selectors pure. They should read Doxum state and calculate a value; do not
write, subscribe manually, or cause I/O while a selector is running.

## Test the behavior that changes

For a mutation change, cover the successful commit, rejected partial batch
rollback, inverse/history result, and relevant impact or subscription outcome.
For a projection, cover unrelated commits, dynamic dependencies, stable
references where expected, and disposal. For large tables, lists, and trees,
add a regression test that proves unrelated data is not copied or traversed.
