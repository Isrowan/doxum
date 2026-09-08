import type { DocumentAnchor } from '../schema';
import { profile } from '../profile';

export const equal = (left: readonly string[], right: readonly string[]): boolean => {
  profile.equality.call();
  if (left === right) return true;
  profile.equality.container();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
};

export type KeyOrder = {
  readonly length: number;
  readonly at: (index: number) => string | undefined;
  readonly index: (key: string) => number;
};

type Keys = readonly string[] | KeyOrder;

const length = (keys: Keys): number => keys.length;
const keyAt = (keys: Keys, index: number): string | undefined =>
  Array.isArray(keys) ? keys[index] : keys.at(index);
const keyIndex = (keys: Keys, key: string): number =>
  Array.isArray(keys) ? keys.indexOf(key) : (keys as KeyOrder).index(key);

export const keys = (values: readonly unknown[], keyOf: (value: unknown) => string): KeyOrder => ({
  length: values.length,
  at: index => (index >= 0 && index < values.length ? keyOf(values[index]) : undefined),
  index: key => {
    for (let index = 0; index < values.length; index += 1)
      if (keyOf(values[index]) === key) return index;
    return -1;
  },
});

const listIndexes = new WeakMap<
  readonly unknown[],
  { keyOf: (value: unknown) => string; order: KeyOrder }
>();

/** Canonical lists keep their key positions until a structural write invalidates them. */
export const indexedKeys = (
  values: readonly unknown[],
  keyOf: (value: unknown) => string
): KeyOrder => {
  const cached = listIndexes.get(values);
  if (cached?.keyOf === keyOf) return cached.order;
  let positions: Map<string, number> | undefined;
  const order: KeyOrder = {
    length: values.length,
    at: index => (index >= 0 && index < values.length ? keyOf(values[index]) : undefined),
    index: key => {
      if (!positions) {
        positions = new Map();
        for (let i = 0; i < values.length; i++) positions.set(keyOf(values[i]), i);
        profile.address.listIndex(values.length);
      }
      return positions.get(key) ?? -1;
    },
  };
  listIndexes.set(values, { keyOf, order });
  return order;
};

/** Structural sequence writes own invalidation, including rollback writes. */
export const insert = (values: unknown[], index: number, value: unknown): void => {
  values.splice(index, 0, value);
  listIndexes.delete(values);
};

export const remove = (values: unknown[], index: number): void => {
  values.splice(index, 1);
  listIndexes.delete(values);
};

export const move = (values: unknown[], from: number, to: number): void => {
  const [value] = values.splice(from, 1);
  values.splice(to, 0, value);
  listIndexes.delete(values);
};

export const install = (
  values: unknown[],
  keyOf: (value: unknown) => string,
  order: readonly string[]
): void => {
  const byKey = new Map<string, unknown>();
  for (const value of values) byKey.set(keyOf(value), value);
  values.length = order.length;
  for (let index = 0; index < order.length; index++) values[index] = byKey.get(order[index]);
  listIndexes.delete(values);
};

export const matches = (order: readonly string[], members: readonly string[]): boolean => {
  if (order.length !== members.length) return false;
  const ids = new Set(order);
  return ids.size === order.length && members.every(id => ids.has(id));
};

export const index = (keys: Keys, anchor?: DocumentAnchor): number => {
  if (!anchor) return length(keys);
  if ('at' in anchor) return anchor.at === 'start' ? 0 : length(keys);
  if ('before' in anchor) return keyIndex(keys, anchor.before);
  return keyIndex(keys, anchor.after) + 1;
};

export const at = (keys: Keys, position: number): DocumentAnchor =>
  position <= 0 ? { at: 'start' } : { after: keyAt(keys, position - 1) as string };

export const valid = (keys: Keys, anchor?: DocumentAnchor): boolean => {
  if (!anchor) return true;
  if (typeof anchor !== 'object' || anchor === null) return false;
  if (Number('at' in anchor) + Number('before' in anchor) + Number('after' in anchor) !== 1)
    return false;
  if ('at' in anchor) return anchor.at === 'start' || anchor.at === 'end';
  return keyIndex(keys, 'before' in anchor ? anchor.before : anchor.after) >= 0;
};

export const afterRemove = (keys: Keys, removedIndex: number, anchor?: DocumentAnchor): number => {
  const position = index(keys, anchor);
  return position > removedIndex ? position - 1 : position;
};

export const validPositions = (length: number, positions: readonly number[]): boolean => {
  let previous = -1;
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position <= previous ||
      position > length + index
    )
      return false;
    previous = position;
  }
  return true;
};

export const restore = (
  keys: string[],
  inserted: readonly string[],
  positions: readonly number[]
): void => {
  const currentLength = keys.length;
  if (inserted.length !== positions.length || !validPositions(currentLength, positions))
    throw new Error('Ordered restore positions are invalid.');
  let readIndex = currentLength - 1;
  let insertedIndex = inserted.length - 1;
  keys.length = currentLength + inserted.length;
  for (let writeIndex = keys.length - 1; writeIndex >= 0; writeIndex -= 1) {
    if (insertedIndex >= 0 && positions[insertedIndex] === writeIndex) {
      keys[writeIndex] = inserted[insertedIndex];
      insertedIndex -= 1;
    } else {
      keys[writeIndex] = keys[readIndex];
      readIndex -= 1;
    }
  }
};
