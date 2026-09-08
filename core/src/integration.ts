import type { ObjectNode, ImpactTarget } from './schema';
import type { Read } from './access/scope';
import type { DocumentReadable } from './runtime/contract';
import { createDependencyTracker } from './access/dependency';
import { readWith } from './runtime/access';
export { projectionDebug } from './projection/runtime';
export type { AddressRef } from './address';
export { contains, debugKey, overlaps, read as readAddress, resolveAddress } from './address';
export { subscribeDependencies } from './runtime/notification';
export { same as sameTarget } from './impact-target';
export type { ImpactTarget } from './schema';

export type TrackedSelection<TValue> = {
  readonly value: TValue;
  readonly targets: readonly ImpactTarget<unknown>[];
};

// Framework adapters receive one immutable result instead of coordinating a
// mutable collector with the reader's scoped lifetime themselves.
export const track = <TSchema extends ObjectNode, TValue>(
  runtime: DocumentReadable<TSchema>,
  selector: (read: Read<TSchema>) => TValue
): TrackedSelection<TValue> => {
  const dependencies = createDependencyTracker();
  const value = readWith(runtime, selector, dependencies);
  return Object.freeze({ value, targets: dependencies.snapshot() });
};
