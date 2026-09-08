import { afterAll, bench, describe } from 'vitest';
import { createDocument, createProjectionRuntime, field, object, table } from '../src';
const model = object({ rows: table(object({ value: field<number>() })) });
const ids = Array.from({ length: 100000 }, (_, i) => String(i));
const runtime = createDocument({
  schema: model,
  history: false,
  initial: { rows: { ids, byId: Object.fromEntries(ids.map((id, i) => [id, { value: i }])) } },
});
const projection = createProjectionRuntime({
  onError: error => {
    throw error;
  },
});
const rows = projection.map(
  projection.document(runtime).collection(path => path.rows),
  (_id, row) => row.value
);
const viewport = projection.input(1);
const summary = projection.value({
  sources: { rows, viewport: viewport.source },
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
    rows.item('42').current();
  });
  bench('document and external source in one batch', () => {
    projection.batch(() => {
      runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
      viewport.set(revision);
    });
    summary.current();
  });
  bench('lazy all after one update', () => {
    runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
    rows.all.current();
  });
});
afterAll(() => {
  projection.dispose();
  runtime.dispose();
});
