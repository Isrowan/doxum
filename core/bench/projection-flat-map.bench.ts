import { afterAll, bench, describe } from 'vitest';
import { createProjectionRuntime, derive, input } from 'doxum';
import { createExpansionWorkload } from './keyed-expansion';

for (const [parents, children] of [
  [10000, 3],
  [10, 1000],
]) {
  describe(`keyed expansion ${parents} parents x ${children} children`, () => {
    for (const mode of ['flatMap', 'scalar'] as const) {
      const workload = createExpansionWorkload(mode, parents, children);
      afterAll(() => workload.runtime.dispose());
      bench(`${mode} one parent value`, workload.update, { time: 100, iterations: 5 });
      bench(`${mode} parent order`, workload.reorder, { time: 100, iterations: 5 });
      bench(`${mode} cross-parent transfer`, workload.transfer, { time: 100, iterations: 5 });
    }
  });
}

describe('keyed expansion dependency routing', () => {
  const parents = input.collection(
    new Map(Array.from({ length: 10000 }, (_, i) => [String(i), i]))
  );
  const metadata = input.collection(new Map([['0', 0]]));
  const result = derive.keyed.flatMap(
    parents,
    { metadata: { source: metadata } },
    (_value, key, deps) => [[key, deps.metadata]]
  );
  const runtime = createProjectionRuntime();
  runtime.read(result);
  let value = 0;
  afterAll(() => runtime.dispose());
  bench(
    'one dynamic dependency key in 10000 parents',
    () => runtime.update(metadata, d => d.set('0', ++value)),
    { time: 100, iterations: 5 }
  );
});
