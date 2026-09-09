import { afterAll, bench, describe } from 'vitest';
import {
  createDocument,
  createProjectionStore,
  field,
  input,
  object,
  project,
  table,
} from '../src';
const model = object({ rows: table(object({ value: field<number>() })) });
const ids = Array.from({ length: 100000 }, (_, i) => String(i));
const runtime = createDocument({
  schema: model,
  history: false,
  initial: { rows: { ids, byId: Object.fromEntries(ids.map((id, i) => [id, { value: i }])) } },
});
const store = createProjectionStore({
  onError: error => {
    throw error;
  },
});
const rows = project(
  runtime,
  path => path.rows,
  (_id, row) => row.value
);
const viewport = input(1);
const summary = project({
  kind: 'value',
  sources: { rows, viewport },
  build: ({ rows, viewport }) => ({
    value: (rows.get('42') ?? 0) * viewport.value,
    update: ({ rows, viewport }) => ({
      kind: 'changed',
      value: (rows.get('42') ?? 0) * viewport.value,
    }),
  }),
});
let revision = 0;
describe('explicit projection runtime', () => {
  bench('one mapped row in 100k without all', () => {
    runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
    store.get(rows).get('42');
  });
  bench('document and external source in one batch', () => {
    store.batch(() => {
      runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
      store.set(viewport, revision);
    });
    store.get(summary);
  });
  bench('lazy all after one update', () => {
    runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
    store.get(rows).ids();
  });
});
afterAll(() => {
  store.dispose();
  runtime.dispose();
});
