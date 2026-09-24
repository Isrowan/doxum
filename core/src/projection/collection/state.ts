import type { CollectionRead } from '@/projection/contract';
import { PersistentKeyedIndex } from './index';

export type CollectionEntry<V> =
  { readonly present: true; readonly value: V } | { readonly present: false };

export type CollectionState<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  keys(): IterableIterator<K>;
  size(): number;
  ids(): readonly K[];
  read(check: () => void): CollectionRead<K, V>;
  install(staged: ReadonlyMap<K, CollectionEntry<V>>, ids: readonly K[], reset: boolean): void;
  release(): void;
};

export const createCollectionState = <K extends string, V>(
  initial?: ReadonlyMap<K, V>
): CollectionState<K, V> => {
  // Hot current-generation lookups stay O(1); the persistent index keeps public
  // reads durable across later advances without copying the whole collection.
  const values = new Map<K, V>(initial);
  let ids: readonly K[] = Object.freeze([...values.keys()]);
  let index: PersistentKeyedIndex<K, V> | undefined;

  return {
    get: key => values.get(key),
    has: key => values.has(key),
    keys: () => values.keys(),
    size: () => values.size,
    ids: () => ids,
    read: check => {
      const snapshotIndex = (index ??= PersistentKeyedIndex.from(values));
      const snapshotIds = ids;
      return Object.freeze({
        get: key => {
          check();
          return snapshotIndex.get(key);
        },
        has: key => {
          check();
          return snapshotIndex.has(key);
        },
        ids: () => {
          check();
          return snapshotIds;
        },
      });
    },
    install: (staged, nextIds, reset) => {
      if (reset) {
        values.clear();
        for (const [key, entry] of staged) if (entry.present) values.set(key, entry.value);
        if (index) index = PersistentKeyedIndex.from(values);
      } else {
        for (const [key, entry] of staged) {
          if (index) index = entry.present ? index.set(key, entry.value) : index.remove(key);
          if (entry.present) values.set(key, entry.value);
          else values.delete(key);
        }
      }
      ids = nextIds;
    },
    release: () => {
      values.clear();
      ids = Object.freeze([]);
      index = undefined;
    },
  };
};
