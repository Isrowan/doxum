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
// Keep the regular suite quick; run the 100k stress case with
// DOXUM_PROJECTION_BENCH_SIZE=100000 when profiling a large collection.
const benchmarkEnv = (process as unknown as { readonly env?: Record<string, string | undefined> })
  .env;
const collectionSize = Number(benchmarkEnv?.DOXUM_PROJECTION_BENCH_SIZE ?? 10000);
const ids = Array.from({ length: collectionSize }, (_, i) => String(i));
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
const keyedInput = input.collection(new Map(ids.map((id, index) => [id, index] as const)));
const viewport = input(1);
const summary = derive(
  [rows, viewport],
  (values, factor) => (values.get('42')?.value ?? 0) * factor
);
// Materialize the graph before timing updates so the benchmark measures
// incremental publication rather than one-time collection construction.
store.get(rows);
store.get(keyedInput);
store.get(summary);
let revision = 0;
describe('explicit projection runtime', () => {
  bench(
    `one mapped row in ${collectionSize} without all`,
    () => {
      runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
      store.get(rows).get('42');
    },
    { iterations: 1, time: 1 }
  );
  bench(
    'document and external source in one batch',
    () => {
      store.batch(() => {
        runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
        store.set(viewport, revision);
      });
      store.get(summary);
    },
    { iterations: 1, time: 1 }
  );
  bench(
    `one keyed input in ${collectionSize} without all`,
    () => {
      store.update(keyedInput, draft => draft.set('42', ++revision));
      store.get(keyedInput).get('42');
    },
    { iterations: 1, time: 1 }
  );
  bench(
    'lazy all after one update',
    () => {
      runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
      store.get(rows).keys();
    },
    { iterations: 1, time: 1 }
  );
});
afterAll(() => {
  store.dispose();
  runtime.dispose();
});
