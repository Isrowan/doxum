import { bench, describe } from 'vitest';
import { createIndex, createIndexChanges } from './collection-index';

describe('persistent collection batches', () => {
  for (const count of [10000, 100000]) {
    const index = createIndex(count);
    for (const changed of [1, 50, 500, count / 2]) {
      for (const scenario of ['contiguous', 'spread', 'insert', 'remove', 'mixed'] as const) {
        const changes = createIndexChanges(count, changed, scenario);
        bench(
          `${scenario} ${changed} in ${count}`,
          () => {
            index.apply(changes);
          },
          { time: 100, iterations: 10 }
        );
      }
    }
  }
});
