import { createProjectionRuntime, derive, input } from 'doxum';

/** Identical writes with either intermediate demand or only final settlement. */
export const createCurrentReadWorkload = (demand: boolean, count = 10000) => {
  const source = input.collection(new Map(Array.from({ length: count }, (_, i) => [String(i), 0])));
  const selectors = { left: 0, right: 0 };
  const branch = (name: keyof typeof selectors) =>
    derive.keyed(source, value => {
      selectors[name]++;
      return value * 2;
    });
  const left = branch('left');
  const right = branch('right');
  const runtime = createProjectionRuntime();
  runtime.read(left);
  runtime.read(right);
  let value = 0;
  return {
    runtime,
    selectors,
    resetSelectors() {
      selectors.left = selectors.right = 0;
    },
    run() {
      runtime.batch(() => {
        runtime.update(source, draft => draft.set('0', ++value));
        if (demand && runtime.read(left).get('0') !== value * 2)
          throw new Error('Intermediate read is stale.');
        runtime.update(source, draft => draft.set('0', ++value));
        if (demand && runtime.read(left).get('0') !== value * 2)
          throw new Error('Second intermediate read is stale.');
      });
      if (runtime.read(right).get('0') !== value * 2)
        throw new Error('Deferred consumer missed an update.');
    },
  };
};
