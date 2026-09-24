import { afterAll, bench, describe } from 'vitest';
import { createCurrentReadWorkload } from './projection-current';

describe('current projection reads: two sparse writes in 10000 members', () => {
  for (const demand of [false, true]) {
    const workload = createCurrentReadWorkload(demand);
    afterAll(() => workload.runtime.dispose());
    bench(demand ? 'intermediate demand' : 'final settlement', workload.run, {
      time: 100,
      iterations: 5,
    });
  }
});
