import type { CollectionEntry } from '@/projection/collection/entry';
import { PersistentKeyedIndex } from '@/projection/collection/index';

export type IndexScenario = 'contiguous' | 'spread' | 'insert' | 'remove' | 'mixed' | 'unchanged';
export const indexKey = (i: number): string => `key-${String(i).padStart(6, '0')}`;

export const createIndexChanges = (
  count: number,
  changed: number,
  scenario: IndexScenario
): ReadonlyMap<string, CollectionEntry<number>> => {
  const changes = new Map<string, CollectionEntry<number>>();
  for (let i = 0; i < changed; i++) {
    const at =
      scenario === 'contiguous'
        ? Math.floor((count - changed) / 2) + i
        : Math.floor((i * count) / changed);
    if (scenario === 'remove' || (scenario === 'mixed' && i % 2 === 0))
      changes.set(indexKey(at), { present: false });
    else if (scenario === 'insert' || scenario === 'mixed')
      changes.set(indexKey(count + i), { present: true, value: -i - 1 });
    else
      changes.set(indexKey(at), { present: true, value: scenario === 'unchanged' ? at : -i - 1 });
  }
  return changes;
};

export const createIndex = (count: number): PersistentKeyedIndex<string, number> =>
  PersistentKeyedIndex.from(Array.from({ length: count }, (_, i) => [indexKey(i), i] as const));
