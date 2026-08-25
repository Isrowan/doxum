import { profile } from '../profile';

export type CloneReason =
  'initial' | 'canonical' | 'commit' | 'inverse' | 'reader' | 'replace' | 'journal' | 'snapshot';

const stablePayloads = new WeakSet<object>();

const markStablePayload = <T>(value: T): T => {
  if (Array.isArray(value) || isPlainObject(value)) stablePayloads.add(value as object);
  return value;
};

export const isStablePayload = (value: unknown): boolean =>
  (Array.isArray(value) || isPlainObject(value)) && stablePayloads.has(value as object);

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const countCloneReason = (reason: CloneReason | undefined): void => {
  if (reason) profile.clone.node(reason);
};

export const cloneValue = <T>(value: T, reason?: CloneReason): T => {
  profile.clone.call();
  countCloneReason(reason);
  if (Array.isArray(value)) {
    profile.clone.container();
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1)
      result[index] = cloneValue(value[index], reason);
    return (
      reason === 'commit' || reason === 'inverse' || reason === 'snapshot'
        ? markStablePayload(Object.freeze(result))
        : result
    ) as T;
  }
  if (isPlainObject(value)) {
    profile.clone.container();
    const result: Record<string, unknown> = Object.create(Object.getPrototypeOf(value)) as Record<
      string,
      unknown
    >;
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key))
        result[key] = cloneValue(value[key], reason);
    }
    return (
      reason === 'commit' || reason === 'inverse' || reason === 'snapshot'
        ? markStablePayload(Object.freeze(result))
        : result
    ) as T;
  }
  return value;
};

// Structural document values cross an ownership boundary by cloning. Atomic
// values are shared because their schema contract treats them as immutable.
export const ownPayload = <T>(value: T, reason: CloneReason = 'canonical'): T =>
  Array.isArray(value) || isPlainObject(value) ? cloneValue(value, reason) : value;

// The caller transfers structural ownership to the mutable canonical document.
// Public commit/history boundaries use snapshotPayload instead.
export const transferPayload = <T>(value: T): T => {
  profile.batch.payloadTransferred();
  return value;
};
export const snapshotPayload = <T>(value: T, reason: CloneReason = 'commit'): T => (
  profile.batch.payloadSnapshot(),
  ownPayload(value, reason)
);

export const deepEqual = (left: unknown, right: unknown): boolean => {
  profile.clone.deepEqual();
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    profile.clone.deepEqualContainer();
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1)
      if (!deepEqual(left[index], right[index])) return false;
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    profile.clone.deepEqualContainer();
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key) || !deepEqual(left[key], right[key]))
        return false;
    }
    return true;
  }
  return false;
};

export const sameStructuralValue = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) ||
  ((Array.isArray(left) || isPlainObject(left)) && deepEqual(left, right));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
