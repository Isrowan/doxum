import type { CollectionChange } from './contract';
import { defineSource, type CollectionInput, type Equality, type Input } from './definition';

const valueInput = <T>(
  initial: T,
  equality: (previous: T, next: T) => boolean = Object.is
): Input<T> =>
  defineSource<T>(
    { kind: 'value-input', initial, equality: equality as Equality },
    { kind: 'value', equality: equality as Equality }
  ) as unknown as Input<T>;

const collectionInput = <K extends string, V>(
  initial: ReadonlyMap<K, V> = new Map<K, V>(),
  equality: (previous: V, next: V) => boolean = Object.is
): CollectionInput<K, V> => {
  const entries = new Map<string, unknown>();
  for (const [key, value] of initial) {
    if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
    entries.set(key, value);
  }
  return defineSource<ReadonlyMap<K, V>, CollectionChange<K, V>>(
    { kind: 'collection-input', initial: entries, equality: equality as Equality },
    { kind: 'collection', equality: equality as Equality }
  ) as CollectionInput<K, V>;
};

export const input = Object.assign(valueInput, { collection: collectionInput });
