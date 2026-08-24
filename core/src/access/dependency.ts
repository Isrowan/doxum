import type { ImpactTarget } from '../schema';
import * as impactTarget from '../impact-target';

export type DependencyTracker = {
  readonly record: (target: ImpactTarget<unknown>) => void;
  readonly clear: () => void;
  readonly size: () => number;
  readonly some: (test: (target: ImpactTarget<unknown>) => boolean) => boolean;
  readonly snapshot: () => readonly ImpactTarget<unknown>[];
};

export const createDependencyTracker = (): DependencyTracker => {
  const targets: ImpactTarget<unknown>[] = [];
  return {
    record: value => {
      if (!targets.some(entry => impactTarget.same(entry, value))) targets.push(value);
    },
    clear: () => {
      targets.length = 0;
    },
    size: () => targets.length,
    some: test => targets.some(test),
    snapshot: () => Object.freeze(targets.slice()),
  };
};
