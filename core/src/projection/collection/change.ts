import type { CollectionChange } from '@/projection/contract';
import { sameArray, snapshotArray } from '@/value/array';

type Added<K extends string, V> = { readonly key: K; readonly after: V };
type Updated<K extends string, V> = {
  readonly key: K;
  readonly before: V;
  readonly after: V;
};
type Removed<K extends string, V> = { readonly key: K; readonly before: V };

const transitionContains = <K extends string>(
  entries: readonly { readonly key: K }[],
  key: K
): boolean => {
  for (const entry of entries) if (entry.key === key) return true;
  return false;
};

const transitionSet = <K extends string>(
  entries: readonly { readonly key: K }[]
): ReadonlySet<K> | undefined => {
  // Small net membership changes are overwhelmingly common. Linear lookup avoids
  // allocating a Set while keeping large batches O(n).
  if (entries.length <= 4) return undefined;
  const keys = new Set<K>();
  for (const entry of entries) keys.add(entry.key);
  return keys;
};

const nextExcluding = <K extends string>(
  iterator: Iterator<K>,
  excluded: readonly { readonly key: K }[],
  index: ReadonlySet<K> | undefined
): IteratorResult<K> => {
  while (true) {
    const next = iterator.next();
    if (next.done || !(index ? index.has(next.value) : transitionContains(excluded, next.value)))
      return next;
  }
};

/** Compares common-member order from known transitions without materializing common arrays. */
const transitionOrderChanged = <K extends string>(
  before: Iterable<K>,
  after: Iterable<K>,
  removed: readonly { readonly key: K }[],
  added: readonly { readonly key: K }[]
): boolean => {
  const removedKeys = transitionSet(removed);
  const addedKeys = transitionSet(added);
  const beforeIterator = before[Symbol.iterator]();
  const afterIterator = after[Symbol.iterator]();
  while (true) {
    const left = nextExcluding(beforeIterator, removed, removedKeys);
    const right = nextExcluding(afterIterator, added, addedKeys);
    if (left.done || right.done) return left.done !== right.done;
    if (left.value !== right.value) return true;
  }
};

const nextPresentIn = <K, V>(
  iterator: Iterator<K>,
  membership: ReadonlyMap<K, V>
): IteratorResult<K> => {
  while (true) {
    const next = iterator.next();
    if (next.done || membership.has(next.value)) return next;
  }
};

/** Compares common-member order between two map snapshots without key snapshots or closures. */
const mapOrderChanged = <K, V>(before: ReadonlyMap<K, V>, after: ReadonlyMap<K, V>): boolean => {
  const beforeIterator = before.keys();
  const afterIterator = after.keys();
  while (true) {
    const left = nextPresentIn(beforeIterator, after);
    const right = nextPresentIn(afterIterator, before);
    if (left.done || right.done) return left.done !== right.done;
    if (left.value !== right.value) return true;
  }
};

const sealIncrementalChange = <K extends string, V>(
  added: Added<K, V>[],
  updated: Updated<K, V>[],
  removed: Removed<K, V>[],
  order?: { readonly before: readonly K[]; readonly after: readonly K[] }
): CollectionChange<K, V> | undefined => {
  if (!added.length && !updated.length && !removed.length && !order) return undefined;
  return Object.freeze({
    kind: 'incremental' as const,
    added: Object.freeze(added),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    ...(order
      ? {
          order: Object.freeze({
            before: snapshotArray(order.before),
            after: snapshotArray(order.after),
          }),
        }
      : {}),
  });
};

/** Builds the canonical incremental CollectionChange from already-known net transitions. */
export const createCollectionChange = <K extends string, V>(input: {
  readonly added: Added<K, V>[];
  readonly updated: Updated<K, V>[];
  readonly removed: Removed<K, V>[];
  readonly beforeOrder: readonly K[];
  readonly afterOrder: readonly K[];
}): CollectionChange<K, V> | undefined => {
  let orderChanged = false;
  if (input.beforeOrder !== input.afterOrder) {
    if (!input.added.length && !input.removed.length)
      orderChanged = !sameArray(input.beforeOrder, input.afterOrder);
    else
      orderChanged = transitionOrderChanged(
        input.beforeOrder,
        input.afterOrder,
        input.removed,
        input.added
      );
  }
  return sealIncrementalChange(
    input.added,
    input.updated,
    input.removed,
    orderChanged ? { before: input.beforeOrder, after: input.afterOrder } : undefined
  );
};

/** Exact fallback diff between two published map-like snapshots. */
export const diffCollection = <K extends string, V>(
  previous: ReadonlyMap<K, V>,
  current: ReadonlyMap<K, V>,
  isEqual: (previous: V, next: V) => boolean = Object.is
): CollectionChange<K, V> | undefined => {
  const added: Added<K, V>[] = [];
  const updated: Updated<K, V>[] = [];
  const removed: Removed<K, V>[] = [];
  for (const [key, before] of previous) {
    if (!current.has(key)) removed.push({ key, before });
    else {
      const after = current.get(key) as V;
      if (!isEqual(before, after)) updated.push({ key, before, after });
    }
  }
  for (const [key, after] of current) if (!previous.has(key)) added.push({ key, after });
  const orderChanged = mapOrderChanged(previous, current);
  return sealIncrementalChange(
    added,
    updated,
    removed,
    orderChanged
      ? {
          before: Object.freeze([...previous.keys()]),
          after: Object.freeze([...current.keys()]),
        }
      : undefined
  );
};

const changedKeys = function* <K extends string, V>(
  change: Extract<CollectionChange<K, V>, { readonly kind: 'incremental' }>
): IterableIterator<K> {
  if ((change as CollectionChange<K, V>).kind !== 'incremental')
    throw new TypeError('collectionChange.keys requires an incremental CollectionChange.');
  for (const entry of change.added) yield entry.key;
  for (const entry of change.updated) yield entry.key;
  for (const entry of change.removed) yield entry.key;
};

export const collectionChange: {
  readonly keys: <K extends string, V>(
    change: Extract<CollectionChange<K, V>, { readonly kind: 'incremental' }>
  ) => Iterable<K>;
} = Object.freeze({ keys: changedKeys });

export const collectionHasStructuralChange = <K extends string, V>(
  change: CollectionChange<K, V>
): boolean =>
  change.kind === 'reset' || Boolean(change.added.length || change.removed.length || change.order);

export const collectionChangeTouchesKey = <K extends string, V>(
  change: Extract<CollectionChange<K, V>, { readonly kind: 'incremental' }>,
  key: K
): boolean => {
  for (const entry of change.added) if (entry.key === key) return true;
  for (const entry of change.updated) if (entry.key === key) return true;
  for (const entry of change.removed) if (entry.key === key) return true;
  return false;
};

export const collectionChangeIntersects = <K extends string, V>(
  change: Extract<CollectionChange<K, V>, { readonly kind: 'incremental' }>,
  keys: ReadonlySet<K>
): boolean => {
  for (const entry of change.added) if (keys.has(entry.key)) return true;
  for (const entry of change.updated) if (keys.has(entry.key)) return true;
  for (const entry of change.removed) if (keys.has(entry.key)) return true;
  return false;
};
