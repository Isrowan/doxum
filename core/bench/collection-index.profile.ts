import { performance } from 'node:perf_hooks';
import { createProjectionRuntime, derive, input } from 'doxum';
import { startProfile } from '@/profile';
import { createIndex, createIndexChanges, indexKey } from './collection-index';

export const profileCollectionIndex = (): void => {
  for (const count of [10000, 100000]) {
    const index = createIndex(count);
    for (const changed of [1, 50, 500, count / 2]) {
      for (const scenario of [
        'contiguous',
        'spread',
        'insert',
        'remove',
        'mixed',
        'unchanged',
      ] as const) {
        const changes = createIndexChanges(count, changed, scenario);
        for (let i = 0; i < 5; i++) index.apply(changes);
        const measuring = startProfile();
        const start = performance.now();
        const next = index.apply(changes);
        const elapsed = performance.now() - start;
        const counters = measuring.stop().collectionIndex;
        console.log(
          JSON.stringify({
            workload: 'collection-index-batch',
            count,
            changed,
            scenario,
            elapsed,
            counters,
          })
        );
        if (
          counters.builds !== 0 ||
          counters.batches !== 1 ||
          counters.sortedKeys !== (changed === 1 ? 0 : changed)
        )
          throw new Error('Index batch rebuilt the whole collection or sorted the wrong key set.');
        if (scenario === 'unchanged' && (next !== index || counters.nodes !== 0))
          throw new Error('Unchanged entries allocated a new persistent version.');
        if (
          (scenario === 'contiguous' || scenario === 'spread') &&
          (counters.nodes !== counters.visitedNodes || counters.nodes > count)
        )
          throw new Error('Value-only batch copied a shared search path more than once.');
        for (const [key, entry] of changes) {
          if (next.has(key) !== entry.present || (entry.present && next.get(key) !== entry.value))
            throw new Error('Index batch did not install its final entries.');
        }
      }
    }
    for (const scenario of ['contiguous', 'spread'] as const) {
      const source = input.collection(
        new Map(Array.from({ length: count }, (_, i) => [indexKey(i), i]))
      );
      let selectors = 0;
      const compute = (value: number) => {
        selectors++;
        return value + 1;
      };
      let leaf = derive.keyed(source, compute);
      for (let i = 1; i < 5; i++) leaf = derive.keyed(leaf, compute);
      const runtime = createProjectionRuntime();
      runtime.read(leaf);
      const changes = createIndexChanges(count, 500, scenario);
      let tick = 0;
      const run = () => {
        tick++;
        runtime.update(source, draft => {
          for (const [key, entry] of changes) if (entry.present) draft.set(key, entry.value - tick);
        });
      };
      for (let i = 0; i < 5; i++) run();
      selectors = 0;
      const measuring = startProfile();
      const start = performance.now();
      run();
      const elapsed = performance.now() - start;
      const counters = measuring.stop();
      console.log(
        JSON.stringify({
          workload: 'collection-index-five-projections',
          count,
          changed: 500,
          scenario,
          elapsed,
          selectors,
          counters,
        })
      );
      if (
        selectors !== 2500 ||
        counters.collectionIndex.builds !== 0 ||
        counters.collectionView.idsScanned !== 0
      )
        throw new Error(
          'Batch propagation performed unrelated computation or full collection work.'
        );
      runtime.dispose();
    }
  }
};
