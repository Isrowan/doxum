import { afterAll, bench, describe } from 'vitest';
import { createFromEntriesWorkload } from './keyed-from-entries';

describe('scalar to 10000 keyed entries, one changed value', () => {
  for (const mode of ['native', 'composed'] as const) {
    const workload = createFromEntriesWorkload(mode);
    for (let i = 0; i < 20; i++) workload.run();
    afterAll(() => workload.runtime.dispose());
    bench(mode, workload.run, { time: 500, iterations: 50 });
  }
});
