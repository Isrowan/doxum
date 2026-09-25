import { performance } from 'node:perf_hooks';
import { createProjectionRuntime, derive, input } from 'doxum';
import { startProfile } from '@/profile';

export const profileKeyedSelection = (): void => {
  for (const count of [10000, 100000]) {
    const source = input.collection(
      new Map(Array.from({ length: count }, (_, i) => [String(i), i]))
    );
    const request = input<readonly string[]>(['0', '1']);
    let calls = 0;
    const subset = derive.keyed.subset(source, { request }, ({ request }) => {
      calls++;
      return request;
    });
    const member = derive.keyed.get(source, { request }, ({ request }) => {
      calls++;
      return request[0];
    });
    const runtime = createProjectionRuntime();
    runtime.read(subset);
    runtime.read(member);
    for (const scenario of [
      'unselected-value',
      'selected-value',
      'same-keys',
      'reorder',
    ] as const) {
      let tick = 0;
      const run = () => {
        tick++;
        if (scenario === 'unselected-value')
          runtime.update(source, draft => draft.set(String(count - 1), -tick));
        else if (scenario === 'selected-value')
          runtime.update(source, draft => draft.set('0', -tick));
        else if (scenario === 'same-keys') runtime.update(request, ['0', '1']);
        else runtime.update(request, tick % 2 ? ['1', '0'] : ['0', '1']);
      };
      for (let warmup = 0; warmup < 10; warmup++) run();
      calls = 0;
      const measuring = startProfile();
      const start = performance.now();
      run();
      const elapsed = performance.now() - start;
      const counters = measuring.stop();
      console.log(
        JSON.stringify({
          workload: 'keyed-selection',
          count,
          scenario,
          elapsed,
          selectors: calls,
          counters,
        })
      );
      const expectedCalls = scenario === 'same-keys' || scenario === 'reorder' ? 2 : 0;
      const expectedTouches =
        scenario === 'selected-value' ? 2 : scenario === 'unselected-value' ? 1 : 0;
      if (
        calls !== expectedCalls ||
        counters.projection.processedNodes !== 2 ||
        counters.projection.touchedKeys !== expectedTouches ||
        counters.collectionView.idsScanned !== 0 ||
        counters.collectionIndex.builds !== 0
      )
        throw new Error('Keyed selection performed unrelated computation or collection work.');
    }
    runtime.dispose();
  }
};
