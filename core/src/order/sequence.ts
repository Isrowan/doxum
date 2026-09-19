import { profile } from '../profile';

export type KeyOrder = {
  readonly length: number;
  readonly at: (index: number) => string | undefined;
  readonly index: (key: string) => number;
};

export type OrderedKeys = readonly string[] | KeyOrder;

export type ListSequence = {
  readonly order: readonly string[];
  readonly values: ReadonlyMap<string, unknown>;
};

const length = (keys: OrderedKeys): number => keys.length;
const keyAt = (keys: OrderedKeys, index: number): string | undefined =>
  Array.isArray(keys) ? keys[index] : keys.at(index);

export const equal = (left: readonly string[], right: OrderedKeys): boolean => {
  profile.equality.call();
  if (left === right) return true;
  profile.equality.container();
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++)
    if (left[index] !== keyAt(right, index)) return false;
  return true;
};

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

const knownKeys = (values: readonly string[]): KeyOrder => {
  let positions: Map<string, number> | undefined;
  return {
    length: values.length,
    at: index => values[index],
    index: key => {
      if (!positions) {
        positions = new Map();
        for (let index = 0; index < values.length; index++) positions.set(values[index], index);
        profile.address.listIndex(values.length);
      }
      return positions.get(key) ?? -1;
    },
  };
};

const cacheKnownKeys = (
  values: readonly unknown[],
  keyOf: (value: unknown) => string,
  order: readonly string[]
): void => {
  listIndexes.set(values, { keyOf, order: knownKeys(order) });
};

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
        for (let index = 0; index < values.length; index++)
          positions.set(keyOf(values[index]), index);
        profile.address.listIndex(values.length);
      }
      return positions.get(key) ?? -1;
    },
  };
  listIndexes.set(values, { keyOf, order });
  return order;
};

export const toArray = (keys: OrderedKeys): string[] => {
  const result = new Array<string>(length(keys));
  for (let index = 0; index < result.length; index++) result[index] = keyAt(keys, index) as string;
  return result;
};

/** One operation-local list scan provides both stable keys and item association. */
export const listSequence = (
  values: readonly unknown[],
  keyOf: (value: unknown) => string
): ListSequence => {
  const current = indexedKeys(values, keyOf);
  const order = new Array<string>(values.length);
  const byKey = new Map<string, unknown>();
  for (let index = 0; index < values.length; index++) {
    const key = current.at(index) as string;
    order[index] = key;
    byKey.set(key, values[index]);
  }
  cacheKnownKeys(values, keyOf, order);
  return { order, values: byKey };
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

/** Installs an exact string-key sequence such as table ids in one structural write. */
export const installKeys = (values: string[], order: readonly string[]): void => {
  values.length = order.length;
  for (let index = 0; index < order.length; index++) values[index] = order[index];
};

/** Installs a pre-resolved list sequence without running keyOf again. */
export const installList = (
  values: unknown[],
  keyOf: (value: unknown) => string,
  sequence: ListSequence,
  order: readonly string[]
): void => {
  values.length = order.length;
  for (let index = 0; index < order.length; index++)
    values[index] = sequence.values.get(order[index]);
  cacheKnownKeys(values, keyOf, order);
};

export const install = (
  values: unknown[],
  keyOf: (value: unknown) => string,
  order: readonly string[]
): void => {
  installList(values, keyOf, listSequence(values, keyOf), order);
};

export const matches = (order: readonly string[], members: readonly string[]): boolean => {
  if (order.length !== members.length) return false;
  const ids = new Set(order);
  return ids.size === order.length && members.every(id => ids.has(id));
};
