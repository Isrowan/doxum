import { createProjectionRuntime, derive, input } from 'doxum';

/** Native computation vs the equivalent public composition, with entry equality in both. */
export const createFromEntriesWorkload = (mode: 'native' | 'composed', count = 10000) => {
  const source = input(0);
  const calls = { compute: 0, downstream: 0 };
  const compute = ({ source }: { source: number }): readonly (readonly [string, number])[] => {
    calls.compute++;
    return Array.from({ length: count }, (_, i) => [String(i), i === 0 ? source : i]);
  };
  const rows =
    mode === 'native'
      ? derive.keyed.fromEntries({ source }, compute)
      : derive.keyed(
          derive.keyed.from(
            derive({ source }, compute),
            entry => entry[0],
            (left, right) => Object.is(left[1], right[1])
          ),
          entry => entry[1]
        );
  const downstream = derive.keyed(rows, value => {
    calls.downstream++;
    return value * 2;
  });
  const runtime = createProjectionRuntime();
  runtime.read(downstream);
  let version = 0;
  return {
    runtime,
    calls,
    resetCalls() {
      calls.compute = calls.downstream = 0;
    },
    run() {
      runtime.update(source, ++version);
      if (runtime.read(downstream).get('0') !== version * 2)
        throw new Error('fromEntries benchmark produced a stale result.');
    },
  };
};
