import { performance } from 'node:perf_hooks';
import { createKeyRelation } from '@/projection/keyed/relation';
import { startProfile } from '@/profile';

export const profileKeyRelation = (): void => {
  for (const count of [1000, 10000]) {
    const original = Object.freeze(Array.from({ length: count }, (_, index) => String(index)));
    const replacement = [...original];
    replacement[count / 2] = 'new';
    const reordered = [...original].reverse();
    const scattered = [...reordered];
    scattered[count / 2] = 'new';
    const scenarios = [
      { name: 'equal-sequence', next: [...original], added: 0, removed: 0, diffKeys: 0 },
      { name: 'single-replacement', next: replacement, added: 1, removed: 1, diffKeys: 0 },
      { name: 'append', next: [...original, 'new'], added: 1, removed: 0, diffKeys: 0 },
      { name: 'truncate', next: original.slice(0, -1), added: 0, removed: 1, diffKeys: 0 },
      { name: 'reorder', next: reordered, added: 0, removed: 0, diffKeys: 0 },
      { name: 'scattered-overlap', next: scattered, added: 1, removed: 1, diffKeys: count },
      {
        name: 'disjoint',
        next: original.map(key => `new:${key}`),
        added: count,
        removed: count,
        diffKeys: 0,
      },
    ];
    for (const scenario of scenarios) {
      const next = Object.freeze(scenario.next);
      const relation = createKeyRelation();
      relation.replace('left', original);
      for (let warmup = 0; warmup < 10; warmup++) {
        relation.replace('left', next);
        relation.replace('left', original);
      }
      const measuring = startProfile();
      const start = performance.now();
      relation.replace('left', next);
      const elapsed = performance.now() - start;
      const counters = measuring.stop().keyRelation;
      console.log(
        JSON.stringify({
          workload: 'key-relation',
          count,
          scenario: scenario.name,
          elapsed,
          counters,
        })
      );
      if (
        counters.attachedEdges !== scenario.added ||
        counters.detachedEdges !== scenario.removed ||
        counters.createdBuckets !== scenario.added ||
        counters.deletedBuckets !== scenario.removed ||
        counters.diffSets !== (scenario.diffKeys ? 1 : 0) ||
        counters.diffKeys !== scenario.diffKeys
      )
        throw new Error('Key relation replaced retained edges or indexed unchanged key ranges.');
    }
  }
};
