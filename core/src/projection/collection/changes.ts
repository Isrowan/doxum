import type { CollectionChange } from '@/projection/contract';
import { createCollectionChange } from './change';
import type { CollectionEntry } from './state';

type Transition<V> = { before: CollectionEntry<V>; after: CollectionEntry<V> };

/** Net transitions for one consumer's unconsumed interval; bounded by touched keys. */
export const createCollectionChanges = <K extends string, V>() => {
  let first: CollectionChange<K, V> | undefined;
  let beforeOrder: readonly K[] = [];
  let afterOrder: readonly K[] = [];
  let cached: CollectionChange<K, V> | undefined;
  let valid = false;
  let transitions: Map<K, Transition<V>> | undefined;
  const merge = (change: Extract<CollectionChange<K, V>, { kind: 'incremental' }>) => {
    const write = (key: K, before: CollectionEntry<V>, after: CollectionEntry<V>) => {
      const previous = transitions!.get(key);
      const initial = previous?.before ?? before;
      if (
        initial.present === after.present &&
        (!initial.present || (after.present && Object.is(initial.value, after.value)))
      ) {
        transitions!.delete(key);
      } else if (previous) previous.after = after;
      else transitions!.set(key, { before, after });
    };
    for (const entry of change.added)
      write(entry.key, { present: false }, { present: true, value: entry.after });
    for (const entry of change.updated)
      write(
        entry.key,
        { present: true, value: entry.before },
        { present: true, value: entry.after }
      );
    for (const entry of change.removed)
      write(entry.key, { present: true, value: entry.before }, { present: false });
  };
  return {
    add(change: CollectionChange<K, V>, before: readonly K[], after: readonly K[]) {
      valid = false;
      afterOrder = after;
      if (!first) {
        first = change;
        beforeOrder = before;
        return;
      }
      if (first.kind === 'reset') return;
      if (change.kind === 'reset') {
        first = change;
        transitions = undefined;
        return;
      }
      if (!transitions) {
        transitions = new Map();
        merge(first);
      }
      merge(change);
    },
    current(): CollectionChange<K, V> | undefined {
      if (!transitions) return first;
      if (valid) return cached;
      const added: { key: K; after: V }[] = [];
      const updated: { key: K; before: V; after: V }[] = [];
      const removed: { key: K; before: V }[] = [];
      for (const [key, { before, after }] of transitions) {
        if (!before.present) {
          if (after.present) added.push({ key, after: after.value });
        } else if (!after.present) removed.push({ key, before: before.value });
        else if (!Object.is(before.value, after.value))
          updated.push({ key, before: before.value, after: after.value });
      }
      cached = createCollectionChange({ added, updated, removed, beforeOrder, afterOrder });
      valid = true;
      return cached;
    },
    reset: () => first?.kind === 'reset',
    clear() {
      first = undefined;
      cached = undefined;
      valid = false;
      transitions = undefined;
      beforeOrder = afterOrder = [];
    },
  };
};
