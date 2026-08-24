import {
  createCollectionView,
  createDocument,
  field,
  list,
  object,
  schema,
  select,
  table,
  tree,
} from '../src';

const task = object({
  title: field<string>(),
  completed: field<boolean>(),
});

const taskSchema = schema({
  title: field<string>(),
  tasks: table(task),
  tags: list<{ id: string; label: string }>({ keyOf: tag => tag.id }),
  outline: tree<{ label: string }>(),
});

const runtime = createDocument({
  schema: taskSchema,
  initial: {
    title: 'Launch',
    tasks: { ids: ['task-1'], byId: { 'task-1': { title: 'Write', completed: false } } },
    tags: [{ id: 'work', label: 'Work' }],
    outline: { rootId: 'root', nodes: { root: { children: [], value: { label: 'Root' } } } },
  },
});

const tasks = taskSchema.collection(path => path.tasks);
const title = taskSchema.value(path => path.title);
const taskTitle = taskSchema.value(path => path.tasks.item('task-1').title);
const view = createCollectionView({
  runtime,
  source: tasks,
  map: (_id, entry) => entry.title.get(),
});

runtime.update(transaction => {
  transaction.write.tasks.item('task-1').title.set('Written');
  return transaction.read.tasks.get('task-1')?.title.get();
});

const selectedTitle: string = select(runtime, read => read.title.get());
const selectedTaskTitle: string | undefined = select(runtime, read =>
  read.tasks.get('task-1')?.title.get()
);
const currentTitle: string = selectedTitle;
const currentTaskTitle: string | undefined = selectedTaskTitle;
const currentViewItem: string | undefined = view.item('task-1').current();
void [title, taskTitle, currentTitle, currentTaskTitle, currentViewItem];

view.dispose();
runtime.dispose();
