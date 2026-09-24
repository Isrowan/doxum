import { performance } from 'node:perf_hooks';
import { createProjectionRuntime, derive, input } from 'doxum';
import { startProfile } from '@/profile';
import { createExpansionWorkload } from './keyed-expansion';

export const profileKeyedExpansion = (): void => {
  for (const [parents, children] of [
    [10000, 3],
    [10, 1000],
  ]) {
    for (const mode of ['flatMap', 'scalar'] as const) {
      for (const action of ['update', 'reorder', 'transfer'] as const) {
        const workload = createExpansionWorkload(mode, parents, children);
        workload.resetSelectors();
        const measuring = startProfile();
        const start = performance.now();
        workload[action]();
        const elapsed = performance.now() - start;
        const counters = measuring.stop();
        console.log(
          JSON.stringify({
            workload: 'keyed-expansion',
            mode,
            parents,
            children,
            action,
            elapsed,
            selectors: workload.selectors(),
            counters,
          })
        );
        if (
          mode === 'flatMap' &&
          workload.selectors() !== (action === 'update' ? 1 : action === 'transfer' ? 2 : 0)
        )
          throw new Error('Keyed expansion selector budget exceeded.');
        if (mode === 'flatMap' && action === 'update' && counters.collectionView.idsScanned !== 0)
          throw new Error('Value-only expansion scanned formal order.');
        workload.runtime.dispose();
      }
    }
  }
  const source = input.collection(new Map(Array.from({ length: 10000 }, (_, i) => [String(i), i])));
  const metadata = input.collection(new Map([['0', 0]]));
  let selectors = 0;
  const expanded = derive.keyed.flatMap(
    source,
    { metadata: { source: metadata } },
    (_value, key, deps) => {
      selectors++;
      return [[key, deps.metadata]];
    }
  );
  const runtime = createProjectionRuntime();
  runtime.read(expanded);
  selectors = 0;
  const measuring = startProfile();
  const start = performance.now();
  runtime.update(metadata, draft => draft.set('0', 1));
  const elapsed = performance.now() - start;
  const counters = measuring.stop();
  console.log(
    JSON.stringify({ workload: 'keyed-expansion-dependency', selectors, elapsed, counters })
  );
  if (selectors !== 1 || counters.collectionView.idsScanned !== 0)
    throw new Error('Dependency invalidation budget exceeded.');
  runtime.dispose();
};
