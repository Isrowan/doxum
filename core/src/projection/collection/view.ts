import type { CollectionRead } from '../contract';

export const mapRead = <K extends string, V>(value: ReadonlyMap<K, V>): CollectionRead<K, V> => ({
  get: key => value.get(key),
  has: key => value.has(key),
  ids: () => Object.freeze([...value.keys()]),
});

/** Immutable map-like view over a CollectionRead. */
export const collectionView = <K extends string, V>(
  read: CollectionRead<K, V>
): ReadonlyMap<K, V> => {
  const ids = read.ids();
  const entries = function* (): IterableIterator<[K, V]> {
    for (const key of ids) yield [key, read.get(key) as V];
  };
  const values = function* (): IterableIterator<V> {
    for (const key of ids) yield read.get(key) as V;
  };
  const view: ReadonlyMap<K, V> = {
    get: key => read.get(key),
    has: key => read.has(key),
    get size() {
      return ids.length;
    },
    keys: () => ids[Symbol.iterator](),
    values,
    entries,
    forEach: (callback, thisArg) => {
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
  return collectionView(mapRead(values));
};
