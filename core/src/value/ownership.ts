import { profile } from '../profile';

import type { CloneReason } from '../profile';

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
      if (Object.hasOwn(value, index)) result[index] = cloneValue(value[index], reason);
    return (reason === 'commit' || reason === 'snapshot' ? Object.freeze(result) : result) as T;
  }
  if (isPlainObject(value)) {
    profile.clone.container();
    const result: Record<string, unknown> = Object.create(Object.getPrototypeOf(value)) as Record<
      string,
      unknown
    >;
    for (const key of Reflect.ownKeys(value))
      Object.defineProperty(result, key, {
        value: cloneValue((value as Record<PropertyKey, unknown>)[key], reason),
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
        writable: true,
        configurable: true,
      });
    return (reason === 'commit' || reason === 'snapshot' ? Object.freeze(result) : result) as T;
  }
  return value;
};

export const deepEqual = (left: unknown, right: unknown): boolean => {
  profile.clone.deepEqual();
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    profile.clone.deepEqualContainer();
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1)
      if (
        Object.hasOwn(left, index) !== Object.hasOwn(right, index) ||
        !deepEqual(left[index], right[index])
      )
        return false;
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    profile.clone.deepEqualContainer();
    const leftKeys = Reflect.ownKeys(left);
    if (leftKeys.length !== Reflect.ownKeys(right).length) return false;
    for (const key of leftKeys) {
      if (
        !Object.prototype.hasOwnProperty.call(right, key) ||
        !deepEqual(
          (left as Record<PropertyKey, unknown>)[key],
          (right as Record<PropertyKey, unknown>)[key]
        )
      )
        return false;
    }
    return true;
  }
  return false;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
