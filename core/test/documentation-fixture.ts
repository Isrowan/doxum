import {
  assign,
  createDocument,
  createProjectionRuntime,
  field,
  list,
  map,
  object,
  parse,
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
    const item = draft.tasks.a;
    if (!item) throw new TransactionRejected({ code: 'missing', message: 'Missing task.' });
    item.done = true;
    draft.tasks.b = { title: 'Review', done: false };
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
  track(document, state => state.tasks.a?.done);
  const projection = createProjectionRuntime({ onError: console.error });
  const titles = projection.map(
    projection.document(document).collection(path => path.tasks),
    (id, item) => `${id}: ${item.title}`
  );
  const count = projection.value({ titles }, ({ titles }) => titles.ids().length);
  const zoom = projection.input(1);
  projection.value({ count, zoom: zoom.source }, ({ count, zoom }) => count.value * zoom.value);
  projection.batch(() => {
    zoom.set(2);
    document.update(d => {
      d.title = 'Done';
    });
  });
  const board = createDocument({
    schema: object({ entries: map(object({ rows: table(task) })) }),
    initial: { entries: {} },
  });
  board.update(d => {
    assign(d.entries, 'a', { rows: { ids: [], byId: {} } });
    d.entries.a!.rows.create({ id: 'x', value: { title: 'X', done: false } });
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
  projection.dispose();
  document.dispose();
  board.dispose();
  return { tasks, structure, parsed };
};
