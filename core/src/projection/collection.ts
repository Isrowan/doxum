import { profile } from '../profile';
import type {
  CollectionChange,
  CollectionContext,
  CollectionRead,
  CollectionNodeSpec,
  CollectionDraft,
  CollectionNode,
  GraphSources,
} from './contract';
import { createNode } from './node';
import { assertScope, assertSynchronous, type Scheduler } from './scheduler';

type Entry<V> = { present: true; value: V } | { present: false };

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

export const createCollection = <S extends GraphSources, K extends string, V>(
  scheduler: Scheduler,
  spec: CollectionNodeSpec<S, K, V>
): CollectionNode<K, V> => {
  const values = new Map<K, V>();
  let ids: readonly K[] = Object.freeze([]);
  let staged = new Map<K, Entry<V>>();
  let nextIds = ids;
  let change: CollectionChange<K, V> | undefined;
  let instance: ReturnType<typeof spec.build> | undefined;
  let initialized = false;
  let reset = false;
  let revision = 0;
  let publishedRoot: TreeNode<K, V> | undefined;
  let cause: unknown;
  const listeners = new Set<(change: CollectionChange<K, V>) => void>();
  const changedKeys = new Set<K>();
  let orderChanged = false;
  const readPublished = (
    root: TreeNode<K, V> | undefined,
    publishedIds: readonly K[]
  ): CollectionRead<K, V> =>
    Object.freeze({
      get: (key: K) => {
        owner.check();
        return treeGet(root, key);
      },
      has: (key: K) => {
        owner.check();
        return treeHas(root, key);
      },
      ids: () => {
        owner.check();
        return publishedIds;
      },
    });
  const hasNext = (key: K) => (staged.has(key) ? staged.get(key)!.present : values.has(key));
  const getNext = (key: K) => {
    const entry = staged.get(key);
    return entry ? (entry.present ? entry.value : undefined) : values.get(key);
  };
  const owner = createNode(scheduler, spec, {
    evaluate: (sources, build, active) => {
      const metadata = Object.values(sources as Record<string, unknown>).find(
        value =>
          value &&
          typeof value === 'object' &&
          'cause' in value &&
          (value as { readonly cause?: unknown }).cause !== undefined
      ) as { readonly cause?: unknown } | undefined;
      cause = metadata?.cause ?? scheduler.batchContext()?.cause;
      staged = new Map();
      nextIds = ids;
      change = undefined;
      changedKeys.clear();
      let explicitOrder: readonly K[] | undefined;
      let cleared = false;
      const nextHas = (key: K) =>
        staged.has(key) ? staged.get(key)!.present : !cleared && values.has(key);
      const nextGet = (key: K) => {
        const entry = staged.get(key);
        return entry
          ? entry.present
            ? entry.value
            : undefined
          : cleared
            ? undefined
            : values.get(key);
      };
      const deriveIds = () => {
        const result = cleared ? [] : ids.filter(nextHas);
        for (const [key, entry] of staged)
          if (entry.present && (cleared || !values.has(key))) result.push(key);
        return result;
      };
      const read = (next: boolean): CollectionRead<K, V> => ({
        get: key => {
          assertScope(active);
          return next ? nextGet(key) : values.get(key);
        },
        has: key => {
          assertScope(active);
          return next ? nextHas(key) : values.has(key);
        },
        ids: () => {
          assertScope(active);
          return next ? Object.freeze(explicitOrder ? explicitOrder.slice() : deriveIds()) : ids;
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
          explicitOrder = order.slice();
        },
      };
      const input = { sources, previous: read(false), next: read(true), output };
      if (build || !instance) {
        profile.materialized.rebuilt();
        instance = undefined;
        cleared = true;
        const built = spec.build(input);
        assertSynchronous(built);
        instance = built;
      } else {
        profile.materialized.updated();
        const result = instance.update(input);
        assertSynchronous(result);
        if (result?.kind === 'rebuild') {
          staged.clear();
          cleared = true;
          explicitOrder = undefined;
          instance = undefined;
          const built = spec.build(input);
          assertSynchronous(built);
          instance = built;
          build = true;
        }
      }
      if (cleared)
        for (const key of values.keys()) if (!staged.has(key)) staged.set(key, { present: false });
      const added = new Set<K>();
      const removed = new Set<K>();
      const updated = new Set<K>();
      profile.projection('touchedKeys', staged.size);
      for (const [key, entry] of staged) {
        const existed = values.has(key);
        if (entry.present) {
          if (!existed) added.add(key);
          else if (!(spec.isEqual ?? Object.is)(values.get(key) as V, entry.value))
            updated.add(key);
          else staged.delete(key);
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
          ids.length === order.length && ids.every((key, i) => key === order[i])
            ? ids
            : Object.freeze(order.slice());
      }
      orderChanged = nextIds !== ids;
      [...added, ...removed, ...updated].forEach(key => changedKeys.add(key));
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
          if (!beforePresent) continue;
          if ((spec.isEqual ?? Object.is)(values.get(key) as V, getNext(key) as V)) continue;
        }
        if (!beforePresent) {
          addedEntries.push({ key, after: getNext(key) as V });
        } else if (!afterPresent) {
          removedEntries.push({ key, before: values.get(key) as V });
        } else {
          updatedEntries.push({
            key,
            before: values.get(key) as V,
            after: getNext(key) as V,
          });
        }
      }
      if (build) change = Object.freeze({ kind: 'reset' as const });
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
          commonOrderChanged = before.some((key, i) => after[i] !== key);
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
      reset = build;
      return change !== undefined;
    },
    context: active => {
      const input: CollectionContext<K, V> = {
        kind: 'collection',
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
        revision: revision + (change ? 1 : 0),
        cause,
      };
      return Object.freeze(input);
    },
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
          for (const [key, entry] of staged) {
            publishedRoot = entry.present
              ? treeSet(publishedRoot, key, entry.value)
              : treeRemove(publishedRoot, key);
          }
        }
      }
      for (const [key, entry] of staged) {
        if (entry.present) values.set(key, entry.value);
        else values.delete(key);
      }
      if (change) {
        if (initialized) revision++;
      }
      ids = nextIds;
      initialized = true;
    },
    emit: call => {
      profile.materialized.notification();
      const resetEvent = Object.freeze({ kind: 'reset' as const });
      Array.from(listeners).forEach(listener => call(() => listener(change ?? resetEvent)));
    },
    clear: () => {
      staged.clear();
      nextIds = ids;
      change = undefined;
      reset = false;
      changedKeys.clear();
      cause = undefined;
      orderChanged = false;
    },
    release: () => {
      values.clear();
      staged.clear();
      publishedRoot = undefined;
      listeners.clear();
      ids = nextIds = Object.freeze([]);
      instance = undefined;
    },
  });
  const handle = {
    kind: 'collection' as const,
    current: () => {
      owner.check();
      return readPublished(publishedRoot, ids);
    },
    revision: () => {
      owner.check();
      return revision;
    },
    subscribe: (listener: (change: CollectionChange<K, V>) => void) => {
      owner.check();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as CollectionNode<K, V>;
  owner.install(handle);
  return Object.freeze(handle);
};
