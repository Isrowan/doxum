import {
  createDocument,
  createProjectionStore,
  field,
  list,
  map,
  input,
  object,
  parse,
  project,
  select,
  snapshot,
  table,
  tree,
  variant,
  TransactionRejected,
  type Infer,
} from '../src';
import { track } from '../src/integration';

export const documentationExamples = () => {
  const task = object({ title: field<string>(), done: field<boolean>() });
  const model = object({ title: field<string>(), tasks: map(task) });
  type Value = Infer<typeof model>;
  const initial: Value = { title: 'Launch', tasks: { a: { title: 'Write', done: false } } };
  const document = createDocument({ schema: model, initial });
  const commit = document.update(draft => {
    const item = draft.tasks.get('a');
    if (!item) throw new TransactionRejected({ code: 'missing', message: 'Missing task.' });
    item.done = true;
    draft.tasks.put('b', { title: 'Review', done: false });
    return { warnings: [] };
  });
  const tasks: Infer<typeof model>['tasks'] = select(document, state => snapshot(state.tasks));
  const stop = document.subscribe(
    [path => path.title, path => path.tasks.item('b').done],
    () => {}
  );
  if (commit.status === 'committed') {
    commit.commit.impact.affects(path => path.tasks.item('a').done);
    commit.commit.impact.collection(path => path.tasks);
    const replica = createDocument({ schema: model, initial });
    replica.apply(commit.commit.changes, { expectedRevision: 0, source: 'remote' });
    replica.dispose();
  }
  track(document, state => state.tasks.get('a')?.done);
  const titles = project(
    document,
    path => path.tasks,
    (id, item) => `${id}: ${item.title}`
  );
  const count = project({ titles }, ({ titles }) => titles.ids().length);
  const zoom = input(1);
  const scaled = project({ count, zoom }, ({ count, zoom }) => count * zoom);
  const store = createProjectionStore({ onError: console.error });
  store.get(scaled);
  store.batch(() => {
    store.set(zoom, 2);
    document.update(d => {
      d.title = 'Done';
    });
  });
  const board = createDocument({
    schema: object({ entries: map(object({ rows: table(task) })) }),
    initial: { entries: {} },
  });
  board.update(d => {
    d.entries.put('a', { rows: { ids: [], byId: {} } });
    d.entries.get('a')!.rows.create('x', { title: 'X', done: false });
  });
  const item = field<{ id: string; title: string }>();
  const structure = object({
    rows: list(item, { keyOf: v => v.id }),
    outline: tree(item),
    choice: variant('kind', {
      a: object({ n: field<number>() }),
      b: object({ text: field<string>() }),
    }),
  });
  const text = (value: unknown): string => {
    if (typeof value !== 'string') throw new Error('String required');
    return value;
  };
  const parsed = parse(object({ title: field(text) }), { title: 'Parsed' });
  stop();
  store.dispose();
  document.dispose();
  board.dispose();
  return { tasks, structure, parsed };
};
