import { performance } from 'node:perf_hooks';
import { startProfile } from '@/profile';
import { createFromEntriesWorkload } from './keyed-from-entries';

export const profileFromEntries = (): void => {
  for (const mode of ['native', 'composed'] as const) {
    const workload = createFromEntriesWorkload(mode);
    for (let i = 0; i < 10; i++) workload.run();
    workload.resetCalls();
    const measuring = startProfile();
    const start = performance.now();
    workload.run();
    const elapsed = performance.now() - start;
    const counters = measuring.stop();
    console.log(
      JSON.stringify({
        workload: 'keyed-from-entries',
        mode,
        elapsed,
        calls: workload.calls,
        counters,
      })
    );
    if (
      workload.calls.compute !== 1 ||
      workload.calls.downstream !== 1 ||
      counters.projection.processedNodes !== (mode === 'native' ? 2 : 4) ||
      counters.collectionView.idsScanned !== 20000 ||
      counters.collectionIndex.builds !== 0
    )
      throw new Error('fromEntries computation or output publication budget exceeded.');
    workload.runtime.dispose();
  }
};
