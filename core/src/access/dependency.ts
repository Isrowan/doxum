import type { ImpactTarget } from '../schema';
import * as target from '../impact/target';

export type DependencyTracker = {
  readonly record: (target: ImpactTarget<unknown>) => void;
  readonly snapshot: () => readonly ImpactTarget<unknown>[];
};

export const createDependencyTracker = (): DependencyTracker => {
  const targets: ImpactTarget<unknown>[] = [];
  return {
    record: value => {
      if (!targets.some(entry => target.same(entry, value))) targets.push(value);
    },
    snapshot: () => Object.freeze(targets.slice()),
  };
};
