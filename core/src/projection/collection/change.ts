import type { CollectionChange } from '../contract';

type Added<K extends string, V> = { readonly key: K; readonly after: V };
type Updated<K extends string, V> = {
  readonly key: K;
  readonly before: V;
  readonly after: V;
};
type Removed<K extends string, V> = { readonly key: K; readonly before: V };

const commonOrderChanged = <K extends string>(
  before: readonly K[],
  after: readonly K[],
  added: ReadonlySet<K>,
  removed: ReadonlySet<K>
): boolean => {
  const beforeCommon = before.filter(key => !removed.has(key));
  const afterCommon = after.filter(key => !added.has(key));
  return beforeCommon.some((key, index) => afterCommon[index] !== key);
};

/** Builds the canonical incremental CollectionChange from already-known net transitions. */
export const createCollectionChange = <K extends string, V>(input: {
  readonly added: readonly Added<K, V>[];
  readonly updated: readonly Updated<K, V>[];
  readonly removed: readonly Removed<K, V>[];
  readonly beforeOrder: readonly K[];
  readonly afterOrder: readonly K[];
}): CollectionChange<K, V> | undefined => {
  const addedKeys = new Set(input.added.map(entry => entry.key));
  const removedKeys = new Set(input.removed.map(entry => entry.key));
  const orderChanged =
    input.beforeOrder !== input.afterOrder &&
    commonOrderChanged(input.beforeOrder, input.afterOrder, addedKeys, removedKeys);
  if (!input.added.length && !input.updated.length && !input.removed.length && !orderChanged)
    return undefined;
  return Object.freeze({
    kind: 'incremental' as const,
    added: Object.freeze([...input.added]),
    updated: Object.freeze([...input.updated]),
    removed: Object.freeze([...input.removed]),
    ...(orderChanged
      ? {
          order: Object.freeze({
            before: Object.freeze([...input.beforeOrder]),
            after: Object.freeze([...input.afterOrder]),
          }),
        }
      : {}),
  });
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
  return createCollectionChange({
    added,
    updated,
    removed,
    beforeOrder: [...previous.keys()],
    afterOrder: [...current.keys()],
  });
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
