import { afterAll, bench, describe } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  input,
  object,
  derive,
  observe,
  table,
} from '../src';
const model = object({ rows: table(object({ value: field<number>() })) });
const ids = Array.from({ length: 100000 }, (_, i) => String(i));
const runtime = createDocument({
  schema: model,
  history: false,
  initial: { rows: { ids, byId: Object.fromEntries(ids.map((id, i) => [id, { value: i }])) } },
});
const store = createProjectionRuntime({
  onError: error => {
    throw error;
  },
});
const rows = observe(runtime, path => path.rows);
const viewport = input(1);
const summary = derive(
  [rows, viewport],
  (values, factor) => (values.get('42')?.value ?? 0) * factor
);
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
    store.get(rows).keys();
  });
});
afterAll(() => {
  store.dispose();
  runtime.dispose();
});
