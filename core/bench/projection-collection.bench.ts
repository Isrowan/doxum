import { bench, describe } from 'vitest';
import { createCollectionChange, diffCollection } from '@/projection/collection/change';
import { PersistentKeyedIndex } from '@/projection/collection/index';
import { createCollectionOutput } from '@/projection/output/collection';

const size = 10_000;
const entries = Array.from({ length: size }, (_, index) => [`key-${index}`, index] as const);
const order = entries.map(([key]) => key);

describe('projection collection internals', () => {
  let index = PersistentKeyedIndex.from(entries);
  let indexRevision = 0;
  bench(
    'persistent index single set in 10000',
    () => {
      index = index.set('key-5000', ++indexRevision);
      index.get('key-5000');
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'persistent index bulk build 10000',
    () => {
      PersistentKeyedIndex.from(entries);
    },
    { iterations: 5, time: 100 }
  );

  const output = createCollectionOutput<string, number>({
    owner: () => {
      throw new Error('Benchmark output has no graph owner.');
    },
    check: () => undefined,
    cause: () => undefined,
  });
  const initial = output.begin(() => true, true);
  for (const [key, value] of entries) initial.output.set(key, value);
  initial.output.order(entries.map(([key]) => key));
  output.seal(true, Object.is);
  output.publish();
  output.clear();
  let outputRevision = 0;

  bench(
    'collection output one staged update in 10000',
    () => {
      const evaluation = output.begin(() => true, false);
      evaluation.output.set('key-5000', ++outputRevision);
      output.seal(false, Object.is);
      output.publish();
      output.clear();
    },
    { iterations: 10, time: 100 }
  );

  const durable = output.current();
  bench(
    'durable collection snapshot lookup in 10000',
    () => {
      durable.get('key-5000');
    },
    { iterations: 10, time: 100 }
  );

  const before = new Map(entries);
  const after = new Map(entries);
  after.set('key-5000', -1);
  bench(
    'fallback map diff one update in 10000',
    () => {
      diffCollection(before, after);
    },
    { iterations: 5, time: 100 }
  );

  const oneUpdate = [{ key: 'key-5000', before: 5_000, after: -1 }];
  bench(
    'collection change one value update in 10000',
    () => {
      createCollectionChange({
        added: [],
        updated: oneUpdate,
        removed: [],
        beforeOrder: order,
        afterOrder: order,
      });
    },
    { iterations: 10, time: 100 }
  );

  const membershipAfter = [...order.slice(1), 'key-new'];
  const oneAdded = [{ key: 'key-new', after: -1 }];
  const oneRemoved = [{ key: 'key-0', before: 0 }];
  bench(
    'collection change one membership swap in 10000',
    () => {
      createCollectionChange({
        added: oneAdded,
        updated: [],
        removed: oneRemoved,
        beforeOrder: order,
        afterOrder: membershipAfter,
      });
    },
    { iterations: 10, time: 100 }
  );

  const reordered = [...order];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  bench(
    'collection change one reorder in 10000',
    () => {
      createCollectionChange({
        added: [],
        updated: [],
        removed: [],
        beforeOrder: order,
        afterOrder: reordered,
      });
    },
    { iterations: 10, time: 100 }
  );
});
