import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  map,
  object,
  observe,
  parse,
  type Infer,
} from 'doxum';

export const documentationExamples = () => {
  const task = object({ title: field<string>(), done: field<boolean>() });
  const model = object({ title: field<string>(), tasks: map(task) });
  type Value = Infer<typeof model>;
  const initial: Value = { title: 'Launch', tasks: { a: { title: 'Write', done: false } } };
  const document = createDocument({ schema: model, initial });
  const tasks = observe(document, path => path.tasks);
  const titles = derive(
    { tasks },
    ({ tasks }) => new Map([...tasks].map(([id, item]) => [id, item.title]))
  );
  const count = derive({ titles }, ({ titles }) => titles.size);
  const zoom = input(1);
  const scaled = derive({ count, zoom }, ({ count, zoom }) => count * zoom);
  const runtime = createProjectionRuntime({ onError: console.error });
  expectSnapshot(runtime.read(scaled));
  runtime.batch(() => {
    runtime.update(zoom, 2);
    document.update(draft => {
      draft.title = 'Done';
    });
  });
  runtime.dispose();
  document.dispose();
  return {
    tasks,
    structure: model,
    parsed: parse(object({ title: field<string>() }), { title: 'Parsed' }),
  };
};

const expectSnapshot = (value: unknown): void => {
  if (typeof value !== 'number') throw new Error('Expected a numeric projection.');
};
