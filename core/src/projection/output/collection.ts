import { profile } from '../../profile';
import { createCollectionChange } from '../collection/change';
import { PersistentKeyedIndex } from '../collection/index';
import type {
  CollectionChange,
  CollectionContext,
  CollectionDraft,
  CollectionRead,
} from '../contract';
import {
  assertScope,
  type OutputRecord,
  type ProcessorRecord,
  type ProducerRecord,
} from '../graph/scheduler';

type Entry<V> = { readonly present: true; readonly value: V } | { readonly present: false };

type PublishedCollection<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  keys(): IterableIterator<K>;
  size(): number;
  ids(): readonly K[];
  read(check: () => void): CollectionRead<K, V>;
  publish(staged: ReadonlyMap<K, Entry<V>>, ids: readonly K[], reset: boolean): void;
  release(): void;
};

const createPublishedCollection = <K extends string, V>(): PublishedCollection<K, V> => {
  // Hot current-generation lookups stay O(1); the persistent index keeps borrowed
  // reads durable across later publications without copying the whole collection.
  const values = new Map<K, V>();
  let ids: readonly K[] = Object.freeze([]);
  let index = PersistentKeyedIndex.empty<K, V>();

  return {
    get: key => values.get(key),
    has: key => values.has(key),
    keys: () => values.keys(),
    size: () => values.size,
    ids: () => ids,
    read: check => {
      const snapshotIndex = index;
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
    publish: (staged, nextIds, reset) => {
      if (reset) {
        const entries: [K, V][] = [];
        for (const [key, entry] of staged) if (entry.present) entries.push([key, entry.value]);
        index = PersistentKeyedIndex.from(entries);
        values.clear();
      } else {
        for (const [key, entry] of staged)
          index = entry.present ? index.set(key, entry.value) : index.remove(key);
      }
      for (const [key, entry] of staged) {
        if (entry.present) values.set(key, entry.value);
        else values.delete(key);
      }
      ids = nextIds;
    },
    release: () => {
      values.clear();
      ids = Object.freeze([]);
      index = PersistentKeyedIndex.empty<K, V>();
    },
  };
};

type CollectionOutputEvaluation<K extends string, V> = {
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly output: CollectionDraft<K, V>;
};

export type CollectionOutputState<K extends string, V> = Omit<
  OutputRecord,
  'context' | 'current'
> & {
  begin(active: () => boolean, initialize: boolean): CollectionOutputEvaluation<K, V>;
  seal(reset: boolean, isEqual: (previous: V, next: V) => boolean): boolean;
  context(active: () => boolean): CollectionContext<K, V>;
  current(): CollectionRead<K, V>;
  publish(): void;
};

type CollectionOutputBinding = {
  owner(): ProducerRecord;
  check(): void;
  cause(): unknown;
};

/** Owns staged keyed intent, exact transitions and published collection state. */
export const createCollectionOutput = <K extends string, V>(
  binding: CollectionOutputBinding
): CollectionOutputState<K, V> => {
  const published = createPublishedCollection<K, V>();
  let staged = new Map<K, Entry<V>>();
  let nextIds = published.ids();
  let change: CollectionChange<K, V> | undefined;
  let initialized = false;
  let reset = false;
  let revision = 0;
  let explicitOrder: readonly K[] | undefined;
  let cleared = false;
  const listeners = new Set<() => void>();
  const consumers = new Set<ProcessorRecord>();

  const hasNext = (key: K): boolean =>
    staged.has(key) ? staged.get(key)!.present : !cleared && published.has(key);

  const getNext = (key: K): V | undefined => {
    const entry = staged.get(key);
    return entry
      ? entry.present
        ? entry.value
        : undefined
      : cleared
        ? undefined
        : published.get(key);
  };

  const deriveIds = (): readonly K[] => {
    const result = cleared ? [] : published.ids().filter(hasNext);
    for (const [key, entry] of staged)
      if (entry.present && (cleared || !published.has(key))) result.push(key);
    return result;
  };

  const begin = (active: () => boolean, initialize: boolean): CollectionOutputEvaluation<K, V> => {
    staged = new Map();
    nextIds = published.ids();
    change = undefined;
    explicitOrder = undefined;
    cleared = initialize;
    reset = initialize;
    const read = (next: boolean): CollectionRead<K, V> => ({
      get: key => {
        assertScope(active);
        return next ? getNext(key) : published.get(key);
      },
      has: key => {
        assertScope(active);
        return next ? hasNext(key) : published.has(key);
      },
      ids: () => {
        assertScope(active);
        return next
          ? Object.freeze(explicitOrder ? [...explicitOrder] : [...deriveIds()])
          : published.ids();
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
      for (const key of published.keys()) if (!staged.has(key)) staged.set(key, { present: false });

    profile.projection('touchedKeys', staged.size);
    const added = new Set<K>();
    const removed = new Set<K>();
    const addedEntries: { readonly key: K; readonly after: V }[] = [];
    const updatedEntries: { readonly key: K; readonly before: V; readonly after: V }[] = [];
    const removedEntries: { readonly key: K; readonly before: V }[] = [];
    for (const [key, entry] of staged) {
      const existed = published.has(key);
      if (entry.present) {
        if (!existed) {
          added.add(key);
          addedEntries.push({ key, after: entry.value });
          continue;
        }
        const before = published.get(key) as V;
        if (!isEqual(before, entry.value)) updatedEntries.push({ key, before, after: entry.value });
        else if (!nextReset) staged.delete(key);
        continue;
      }
      if (existed) {
        removed.add(key);
        removedEntries.push({ key, before: published.get(key) as V });
      } else staged.delete(key);
    }

    const ids = published.ids();
    if (explicitOrder || added.size || removed.size) {
      const order = explicitOrder ?? [...ids.filter(key => !removed.has(key)), ...added];
      const seen = new Set(order);
      if (
        seen.size !== order.length ||
        order.length !== published.size() + added.size - removed.size ||
        order.some(key => !hasNext(key))
      )
        throw new TypeError('Projection order must contain every key exactly once.');
      nextIds =
        ids.length === order.length && ids.every((key, index) => key === order[index])
          ? ids
          : Object.freeze([...order]);
    } else nextIds = ids;

    profile.projection(
      'changedKeys',
      addedEntries.length + updatedEntries.length + removedEntries.length
    );

    change = nextReset
      ? Object.freeze({ kind: 'reset' as const })
      : createCollectionChange({
          added: addedEntries,
          updated: updatedEntries,
          removed: removedEntries,
          beforeOrder: ids,
          afterOrder: nextIds,
        });
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

  return {
    kind: 'collection',
    get owner() {
      return binding.owner();
    },
    begin,
    seal,
    context: active => context(active, binding.cause()),
    current: () => published.read(binding.check),
    revision: () => revision,
    reset: () => reset,
    publish: () => {
      if (change) published.publish(staged, nextIds, change.kind === 'reset');
      if (change && initialized) revision++;
      initialized = true;
    },
    emit: call => {
      Array.from(listeners).forEach(listener => call(listener));
    },
    hasConsumers: () => consumers.size > 0,
    forEachConsumer: run => consumers.forEach(run),
    attachConsumer: consumer => consumers.add(consumer),
    detachConsumer: consumer => consumers.delete(consumer),
    clear: () => {
      staged.clear();
      nextIds = published.ids();
      change = undefined;
      reset = false;
      explicitOrder = undefined;
      cleared = false;
    },
    release: () => {
      published.release();
      staged.clear();
      listeners.clear();
      consumers.clear();
      nextIds = Object.freeze([]);
      change = undefined;
      initialized = false;
      revision = 0;
      reset = false;
      explicitOrder = undefined;
      cleared = false;
    },
    subscribe: listener => {
      binding.check();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
