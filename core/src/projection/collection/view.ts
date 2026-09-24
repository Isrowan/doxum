import type { CollectionRead } from '@/projection/contract';

export const mapRead = <K extends string, V>(value: ReadonlyMap<K, V>): CollectionRead<K, V> => {
  let ids: readonly K[] | undefined;
  return {
    get: key => value.get(key),
    has: key => value.has(key),
    ids: () => (ids ??= Object.freeze([...value.keys()])),
  };
};

/** Immutable map-like view over a CollectionRead. */
export const collectionView = <K extends string, V>(
  read: CollectionRead<K, V>,
  knownIds?: readonly K[]
): ReadonlyMap<K, V> => {
  const ids = knownIds ?? read.ids();
  const iterate = <T>(select: (key: K) => T): IterableIterator<T> => {
    read.ids();
    let index = 0;
    return {
      next() {
        read.ids();
        if (index === ids.length) return { done: true, value: undefined };
        return { done: false, value: select(ids[index++]) };
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  };
  const entries = (): IterableIterator<[K, V]> => iterate(key => [key, read.get(key) as V]);
  const values = (): IterableIterator<V> => iterate(key => read.get(key) as V);
  const view: ReadonlyMap<K, V> = {
    get: key => read.get(key),
    has: key => read.has(key),
    get size() {
      read.ids();
      return ids.length;
    },
    keys: () => iterate(key => key),
    values,
    entries,
    forEach: (callback, thisArg) => {
      read.ids();
      for (const key of ids) callback.call(thisArg, read.get(key) as V, key, view);
    },
    [Symbol.iterator]: entries,
  };
  return Object.freeze(view);
};

/** Eager durable view used when a processor result may retain its dependency value. */
export const snapshotCollectionView = <K extends string, V>(
  read: CollectionRead<K, V>
): ReadonlyMap<K, V> => {
  const ids = read.ids();
  const values = new Map<K, V>();
  for (const key of ids) values.set(key, read.get(key) as V);
  return collectionView(mapRead(values), ids);
};
