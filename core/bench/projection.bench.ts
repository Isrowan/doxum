import { afterAll, bench, describe } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  input,
  map,
  object,
  derive,
  observe,
  table,
  tree,
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
  { rows, viewport },
  ({ rows, viewport }) => (rows.get('42')?.value ?? 0) * viewport
);
// Materialize the graph before timing updates so the benchmark measures
// incremental publication rather than one-time collection construction.
store.read(rows);
store.read(keyedInput);
store.read(summary);
let revision = 0;
describe('explicit projection runtime', () => {
  bench(
    `one mapped row in ${collectionSize} without all`,
    () => {
      runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
      store.read(rows).get('42');
    },
    { iterations: 1, time: 1 }
  );
  bench(
    'document and external source in one batch',
    () => {
      store.batch(() => {
        runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
        store.update(viewport, revision);
      });
      store.read(summary);
    },
    { iterations: 1, time: 1 }
  );
  bench(
    `one keyed input in ${collectionSize} without all`,
    () => {
      store.update(keyedInput, draft => draft.set('42', ++revision));
      store.read(keyedInput).get('42');
    },
    { iterations: 1, time: 1 }
  );
  bench(
    'lazy all after one update',
    () => {
      runtime.update(tx => (tx.rows.get('42')!.value = ++revision));
      store.read(rows).keys();
    },
    { iterations: 1, time: 1 }
  );
});
afterAll(() => {
  store.dispose();
  runtime.dispose();
});

const treeCount = Math.max(1, Math.min(collectionSize, 10_000));
const treeIds = Array.from({ length: treeCount }, (_, index) => `node-${index}`);
const outline = tree(field<number>());
const boardModel = object({ boards: map(object({ outline })) });
const treeInitial = () => ({
  boards: {
    board: {
      outline: {
        rootId: treeIds[0],
        nodes: Object.fromEntries(
          treeIds.map((id, index) => [
            id,
            index === 0
              ? { children: treeIds.slice(1), value: 0 }
              : { parentId: treeIds[0], children: [], value: index },
          ])
        ),
      },
    },
  },
});
const createTreeDocument = () =>
  createDocument({ schema: boardModel, history: false, initial: treeInitial() });
const createTreeStore = () =>
  createProjectionRuntime({
    onError: error => {
      throw error;
    },
  });
const createNativeTreeBench = () => {
  const document = createTreeDocument();
  const store = createTreeStore();
  const projection = observe(document, path => path.boards.item('board').outline.nodes);
  store.read(projection);
  return { document, store, projection };
};
const createAggregateTreeBench = () => {
  const document = createTreeDocument();
  const store = createTreeStore();
  const projection = observe(document, path => path.boards);
  store.read(projection);
  return { document, store, projection };
};
const nativeTree = createNativeTreeBench();
const aggregateTree = createAggregateTreeBench();
let nativeTreeRevision = 0;
let aggregateTreeRevision = 0;
describe('tree projection materialization', () => {
  bench(
    `one native tree node in ${treeCount}`,
    () => {
      nativeTree.document.update(tx =>
        tx.boards.get('board')!.outline.replace(treeIds[treeCount - 1], ++nativeTreeRevision)
      );
      nativeTree.store.read(nativeTree.projection).get(treeIds[treeCount - 1]);
    },
    { iterations: 10, time: 100 }
  );
  bench(
    `one nested tree node through outer map in ${treeCount}`,
    () => {
      aggregateTree.document.update(tx =>
        tx.boards.get('board')!.outline.replace(treeIds[treeCount - 1], ++aggregateTreeRevision)
      );
      aggregateTree.store.read(aggregateTree.projection).get('board');
    },
    { iterations: 10, time: 100 }
  );
});
afterAll(() => {
  nativeTree.store.dispose();
  nativeTree.document.dispose();
  aggregateTree.store.dispose();
  aggregateTree.document.dispose();
});
