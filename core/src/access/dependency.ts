import type { ImpactTarget } from '../schema/path';
import * as target from '../impact/target';

export type DependencyTracker = {
  readonly record: (target: ImpactTarget<unknown>) => void;
  readonly snapshot: () => readonly ImpactTarget<unknown>[];
};

export const createDependencyTracker = (): DependencyTracker => {
  const targets: ImpactTarget<unknown>[] = [];
  const buckets = new Map<string, ImpactTarget<unknown>[]>();
  return {
    record: value => {
      const key = target.dependencyBucket(value);
      let entries = buckets.get(key);
      if (!entries) {
        entries = [];
        buckets.set(key, entries);
      } else if (entries.some(entry => target.same(entry, value))) return;
      entries.push(value);
      targets.push(value);
    },
    snapshot: () => Object.freeze(targets.slice()),
  };
};
