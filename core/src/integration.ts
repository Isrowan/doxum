import type { DocumentSchema, ImpactTarget } from './schema';
import type { DocumentReader } from './access/reader';
import type { DocumentReadable } from './runtime/contract';
import { createDependencyTracker } from './access/dependency';
import { readWith } from './runtime/access';

export type TrackedSelection<TValue> = {
  readonly value: TValue;
  readonly targets: readonly ImpactTarget<unknown>[];
};

// Framework adapters receive one immutable result instead of coordinating a
// mutable collector with the reader's scoped lifetime themselves.
export const track = <TSchema extends DocumentSchema, TValue>(
  runtime: DocumentReadable<TSchema>,
  selector: (read: DocumentReader<TSchema>) => TValue
): TrackedSelection<TValue> => {
  const dependencies = createDependencyTracker();
  const value = readWith(runtime, selector, dependencies);
  return Object.freeze({ value, targets: dependencies.snapshot() });
};
