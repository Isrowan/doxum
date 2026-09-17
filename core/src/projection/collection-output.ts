import { profile } from '../profile';
import type {
  CollectionChange,
  CollectionContext,
  CollectionDraft,
  CollectionRead,
} from './contract';
import { assertScope } from './scheduler';

type Entry<V> = { readonly present: true; readonly value: V } | { readonly present: false };

type TreeNode<K extends string, V> = {
  readonly key: K;
  readonly value: V;
  readonly height: number;
  readonly left?: TreeNode<K, V>;
  readonly right?: TreeNode<K, V>;
};

const height = <K extends string, V>(node: TreeNode<K, V> | undefined): number => node?.height ?? 0;

const makeTreeNode = <K extends string, V>(
  key: K,
  value: V,
  left?: TreeNode<K, V>,
  right?: TreeNode<K, V>
): TreeNode<K, V> =>
  Object.freeze({
    key,
    value,
    left,
    right,
    height: Math.max(height(left), height(right)) + 1,
  });

const rotateLeft = <K extends string, V>(node: TreeNode<K, V>): TreeNode<K, V> => {
  const right = node.right!;
  return makeTreeNode(
    right.key,
    right.value,
    makeTreeNode(node.key, node.value, node.left, right.left),
    right.right
  );
};

const rotateRight = <K extends string, V>(node: TreeNode<K, V>): TreeNode<K, V> => {
  const left = node.left!;
  return makeTreeNode(
    left.key,
    left.value,
    left.left,
    makeTreeNode(node.key, node.value, left.right, node.right)
  );
};

const rebalance = <K extends string, V>(node: TreeNode<K, V>): TreeNode<K, V> => {
  const balance = height(node.left) - height(node.right);
  if (balance > 1) {
    if (height(node.left!.left) < height(node.left!.right))
      return rotateRight(makeTreeNode(node.key, node.value, rotateLeft(node.left!), node.right));
    return rotateRight(node);
  }
  if (balance < -1) {
    if (height(node.right!.right) < height(node.right!.left))
      return rotateLeft(makeTreeNode(node.key, node.value, node.left, rotateRight(node.right!)));
    return rotateLeft(node);
  }
  return node;
};

const treeSet = <K extends string, V>(
  node: TreeNode<K, V> | undefined,
  key: K,
  value: V
): TreeNode<K, V> => {
  if (!node) return makeTreeNode(key, value);
  if (key === node.key) return makeTreeNode(key, value, node.left, node.right);
  if (key < node.key)
    return rebalance(
      makeTreeNode(node.key, node.value, treeSet(node.left, key, value), node.right)
    );
  return rebalance(makeTreeNode(node.key, node.value, node.left, treeSet(node.right, key, value)));
};

const treeMin = <K extends string, V>(node: TreeNode<K, V>): TreeNode<K, V> =>
  node.left ? treeMin(node.left) : node;

const treeRemove = <K extends string, V>(
  node: TreeNode<K, V> | undefined,
  key: K
): TreeNode<K, V> | undefined => {
  if (!node) return undefined;
  if (key < node.key)
    return rebalance(makeTreeNode(node.key, node.value, treeRemove(node.left, key), node.right));
  if (key > node.key)
    return rebalance(makeTreeNode(node.key, node.value, node.left, treeRemove(node.right, key)));
  if (!node.left) return node.right;
  if (!node.right) return node.left;
  const next = treeMin(node.right);
  return rebalance(makeTreeNode(next.key, next.value, node.left, treeRemove(node.right, next.key)));
};

const treeGet = <K extends string, V>(node: TreeNode<K, V> | undefined, key: K): V | undefined => {
  let current = node;
  while (current) {
    if (key === current.key) return current.value;
    current = key < current.key ? current.left : current.right;
  }
  return undefined;
};

const treeHas = <K extends string, V>(node: TreeNode<K, V> | undefined, key: K): boolean => {
  let current = node;
  while (current) {
    if (key === current.key) return true;
    current = key < current.key ? current.left : current.right;
  }
  return false;
};

const treeFromSorted = <K extends string, V>(
  entries: readonly (readonly [K, V])[],
  start = 0,
  end = entries.length
): TreeNode<K, V> | undefined => {
  if (start >= end) return undefined;
  const middle = (start + end) >> 1;
  const [key, value] = entries[middle];
  return makeTreeNode(
    key,
    value,
    treeFromSorted(entries, start, middle),
    treeFromSorted(entries, middle + 1, end)
  );
};

export type CollectionOutputEvaluation<K extends string, V> = {
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly output: CollectionDraft<K, V>;
};

export type CollectionOutputState<K extends string, V> = {
  begin(active: () => boolean, initialize: boolean): CollectionOutputEvaluation<K, V>;
  seal(reset: boolean, isEqual: (previous: V, next: V) => boolean): boolean;
  context(active: () => boolean, cause: unknown): CollectionContext<K, V>;
  current(check: () => void): CollectionRead<K, V>;
  revision(): number;
  reset(): boolean;
  publish(): void;
  emit(call: (listener: () => void) => void): void;
  clear(): void;
  release(): void;
  subscribe(listener: (change: CollectionChange<K, V>) => void): void;
  unsubscribe(listener: (change: CollectionChange<K, V>) => void): void;
};

/** Owns staged keyed intent, exact transitions and the persistent published lookup. */
export const createCollectionOutput = <K extends string, V>(): CollectionOutputState<K, V> => {
  const values = new Map<K, V>();
  let ids: readonly K[] = Object.freeze([]);
  let staged = new Map<K, Entry<V>>();
  let nextIds = ids;
  let change: CollectionChange<K, V> | undefined;
  let initialized = false;
  let reset = false;
  let revision = 0;
  let publishedRoot: TreeNode<K, V> | undefined;
  let explicitOrder: readonly K[] | undefined;
  let cleared = false;
  const listeners = new Set<(change: CollectionChange<K, V>) => void>();

  const hasNext = (key: K): boolean =>
    staged.has(key) ? staged.get(key)!.present : !cleared && values.has(key);
  const getNext = (key: K): V | undefined => {
    const entry = staged.get(key);
    return entry
      ? entry.present
        ? entry.value
        : undefined
      : cleared
        ? undefined
        : values.get(key);
  };
  const deriveIds = (): readonly K[] => {
    const result = cleared ? [] : ids.filter(hasNext);
    for (const [key, entry] of staged)
      if (entry.present && (cleared || !values.has(key))) result.push(key);
    return result;
  };

  const begin = (active: () => boolean, initialize: boolean): CollectionOutputEvaluation<K, V> => {
    staged = new Map();
    nextIds = ids;
    change = undefined;
    explicitOrder = undefined;
    cleared = initialize;
    reset = initialize;
    const read = (next: boolean): CollectionRead<K, V> => ({
      get: key => {
        assertScope(active);
        return next ? getNext(key) : values.get(key);
      },
      has: key => {
        assertScope(active);
        return next ? hasNext(key) : values.has(key);
      },
      ids: () => {
        assertScope(active);
        return next ? Object.freeze(explicitOrder ? [...explicitOrder] : [...deriveIds()]) : ids;
      },
    });
    const output: CollectionDraft<K, V> = {
      set: (key, value) => {
        assertScope(active);
        if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
        staged.set(key, { present: true, value });
      },
      remove: key => {
        assertScope(active);
        staged.set(key, { present: false });
      },
      order: order => {
        assertScope(active);
        explicitOrder = Object.freeze([...order]);
      },
    };
    return { previous: read(false), next: read(true), output };
  };

  const seal = (nextReset: boolean, isEqual: (previous: V, next: V) => boolean): boolean => {
    if (cleared)
      for (const key of values.keys()) if (!staged.has(key)) staged.set(key, { present: false });

    profile.projection('touchedKeys', staged.size);
    const added = new Set<K>();
    const removed = new Set<K>();
    const updated = new Set<K>();
    for (const [key, entry] of staged) {
      const existed = values.has(key);
      if (entry.present) {
        if (!existed) added.add(key);
        else if (!isEqual(values.get(key) as V, entry.value)) updated.add(key);
        else if (!nextReset) staged.delete(key);
      } else if (existed) removed.add(key);
      else staged.delete(key);
    }

    if (explicitOrder || added.size || removed.size) {
      const order = explicitOrder ?? [...ids.filter(key => !removed.has(key)), ...added];
      const seen = new Set(order);
      if (
        seen.size !== order.length ||
        order.length !== values.size + added.size - removed.size ||
        order.some(key => !hasNext(key))
      )
        throw new TypeError('Projection order must contain every key exactly once.');
      nextIds =
        ids.length === order.length && ids.every((key, index) => key === order[index])
          ? ids
          : Object.freeze([...order]);
    } else nextIds = ids;

    const changedKeys = new Set<K>([...added, ...removed, ...updated]);
    profile.projection('changedKeys', changedKeys.size);
    const addedEntries: { readonly key: K; readonly after: V }[] = [];
    const updatedEntries: {
      readonly key: K;
      readonly before: V;
      readonly after: V;
    }[] = [];
    const removedEntries: { readonly key: K; readonly before: V }[] = [];
    for (const key of changedKeys) {
      const beforePresent = values.has(key);
      const afterPresent = hasNext(key);
      if (beforePresent === afterPresent) {
        if (!beforePresent || isEqual(values.get(key) as V, getNext(key) as V)) continue;
      }
      if (!beforePresent) addedEntries.push({ key, after: getNext(key) as V });
      else if (!afterPresent) removedEntries.push({ key, before: values.get(key) as V });
      else
        updatedEntries.push({
          key,
          before: values.get(key) as V,
          after: getNext(key) as V,
        });
    }

    const orderChanged = nextIds !== ids;
    if (nextReset) change = Object.freeze({ kind: 'reset' as const });
    else if (
      addedEntries.length ||
      updatedEntries.length ||
      removedEntries.length ||
      orderChanged
    ) {
      let commonOrderChanged = false;
      if (orderChanged) {
        const before = ids.filter(key => !removed.has(key));
        const after = nextIds.filter(key => !added.has(key));
        commonOrderChanged = before.some((key, index) => after[index] !== key);
      }
      change = Object.freeze({
        kind: 'incremental' as const,
        added: Object.freeze(addedEntries),
        updated: Object.freeze(updatedEntries),
        removed: Object.freeze(removedEntries),
        ...(commonOrderChanged
          ? {
              order: Object.freeze({
                before: Object.freeze([...ids]),
                after: Object.freeze([...nextIds]),
              }),
            }
          : {}),
      });
    }
    reset = nextReset;
    return change !== undefined;
  };

  const context = (active: () => boolean, cause: unknown): CollectionContext<K, V> =>
    Object.freeze({
      kind: 'collection' as const,
      read: {
        get: key => {
          assertScope(active);
          return getNext(key);
        },
        has: key => {
          assertScope(active);
          return hasNext(key);
        },
        ids: () => {
          assertScope(active);
          return nextIds;
        },
      },
      change,
      revision,
      reset,
      cause,
    });

  const current = (check: () => void): CollectionRead<K, V> => {
    const root = publishedRoot;
    const publishedIds = ids;
    return Object.freeze({
      get: key => {
        check();
        return treeGet(root, key);
      },
      has: key => {
        check();
        return treeHas(root, key);
      },
      ids: () => {
        check();
        return publishedIds;
      },
    });
  };

  return {
    begin,
    seal,
    context,
    current,
    revision: () => revision,
    reset: () => reset,
    publish: () => {
      if (change) {
        if (change.kind === 'reset') {
          const entries: [K, V][] = [];
          for (const [key, entry] of staged) if (entry.present) entries.push([key, entry.value]);
          entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
          publishedRoot = treeFromSorted(entries);
        } else {
          for (const [key, entry] of staged)
            publishedRoot = entry.present
              ? treeSet(publishedRoot, key, entry.value)
              : treeRemove(publishedRoot, key);
        }
      }
      for (const [key, entry] of staged) {
        if (entry.present) values.set(key, entry.value);
        else values.delete(key);
      }
      if (change && initialized) revision++;
      ids = nextIds;
      initialized = true;
    },
    emit: call => {
      const resetEvent = Object.freeze({ kind: 'reset' as const });
      Array.from(listeners).forEach(listener => call(() => listener(change ?? resetEvent)));
    },
    clear: () => {
      staged.clear();
      nextIds = ids;
      change = undefined;
      reset = false;
      explicitOrder = undefined;
      cleared = false;
    },
    release: () => {
      values.clear();
      staged.clear();
      publishedRoot = undefined;
      listeners.clear();
      ids = nextIds = Object.freeze([]);
      change = undefined;
      initialized = false;
      revision = 0;
      reset = false;
      explicitOrder = undefined;
      cleared = false;
    },
    subscribe: listener => listeners.add(listener),
    unsubscribe: listener => listeners.delete(listener),
  };
};

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

export type CollectionStageOptions<K extends string, V> = {
  readonly reset: boolean;
  readonly candidates?: Iterable<K>;
  readonly orderMayChange?: boolean;
  readonly isEqual?: (previous: V, next: V) => boolean;
};

/**
 * The one source-to-CollectionChange kernel. Candidate keys only narrow value work;
 * exact membership/value/order semantics remain owned here.
 */
export const stageCollectionRead = <K extends string, V>(
  state: CollectionOutputState<K, V>,
  read: CollectionRead<K, V>,
  active: () => boolean,
  options: CollectionStageOptions<K, V>
): boolean => {
  const evaluation = state.begin(active, options.reset);
  if (options.reset) {
    const ids = read.ids();
    profile.collectionView.idsScanned(ids.length);
    for (const key of ids) {
      profile.collectionView.mapped();
      evaluation.output.set(key, read.get(key) as V);
    }
    evaluation.output.order(ids);
  } else {
    const previous = state.current(() => undefined);
    const keys = options.candidates
      ? [...new Set(options.candidates)]
      : [...new Set([...previous.ids(), ...read.ids()])];
    if (!options.candidates) profile.collectionView.idsScanned(keys.length);
    for (const key of keys) {
      if (read.has(key)) {
        profile.collectionView.mapped();
        evaluation.output.set(key, read.get(key) as V);
      } else evaluation.output.remove(key);
    }
    if (options.orderMayChange || !options.candidates) {
      const ids = read.ids();
      if (options.candidates) profile.collectionView.idsScanned(ids.length);
      evaluation.output.order(ids);
    }
  }
  return state.seal(options.reset, options.isEqual ?? Object.is);
};

/** Exact net transition between two published map-like snapshots. */
export const collectionChangeBetween = <K extends string, V>(
  previous: ReadonlyMap<K, V>,
  current: ReadonlyMap<K, V>,
  isEqual: (previous: V, next: V) => boolean = Object.is
): CollectionChange<K, V> | undefined => {
  const added: { readonly key: K; readonly after: V }[] = [];
  const removed: { readonly key: K; readonly before: V }[] = [];
  const updated: { readonly key: K; readonly before: V; readonly after: V }[] = [];
  for (const [key, before] of previous) {
    if (!current.has(key)) removed.push({ key, before });
    else {
      const after = current.get(key) as V;
      if (!isEqual(before, after)) updated.push({ key, before, after });
    }
  }
  for (const [key, after] of current) if (!previous.has(key)) added.push({ key, after });
  const beforeKeys = new Set(previous.keys());
  const afterKeys = new Set(current.keys());
  const beforeCommon = [...previous.keys()].filter(key => afterKeys.has(key));
  const afterCommon = [...current.keys()].filter(key => beforeKeys.has(key));
  const orderChanged = beforeCommon.some((key, index) => afterCommon[index] !== key);
  if (!added.length && !removed.length && !updated.length && !orderChanged) return undefined;
  return Object.freeze({
    kind: 'incremental' as const,
    added: Object.freeze(added),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    ...(orderChanged
      ? {
          order: Object.freeze({
            before: Object.freeze([...previous.keys()]),
            after: Object.freeze([...current.keys()]),
          }),
        }
      : {}),
  });
};
