import { performance } from 'node:perf_hooks';
import { startProfile } from '@/profile';
import { createCurrentReadWorkload } from './projection-current';

export const profileCurrentReads = (): void => {
  for (const demand of [false, true]) {
    const workload = createCurrentReadWorkload(demand);
    for (let i = 0; i < 10; i++) workload.run();
    workload.resetSelectors();
    const measuring = startProfile();
    const start = performance.now();
    workload.run();
    const elapsed = performance.now() - start;
    const counters = measuring.stop();
    console.log(
      JSON.stringify({
        workload: 'current-projection-reads',
        demand,
        elapsed,
        selectors: workload.selectors,
        counters,
      })
    );
    if (
      workload.selectors.left !== (demand ? 2 : 1) ||
      workload.selectors.right !== 1 ||
      counters.collectionView.idsScanned !== 0 ||
      counters.collectionIndex.builds !== 0
    )
      throw new Error('Demanded read performed unrelated collection work.');
    workload.runtime.dispose();
  }
};
