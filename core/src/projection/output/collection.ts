import { profile } from '@/profile';
import { createCollectionChange } from '@/projection/collection/change';
import { createCollectionState, type CollectionEntry } from '@/projection/collection/state';
import { sameArray, snapshotArray } from '@/value/array';
import type {
  CollectionChange,
  CollectionContext,
  CollectionDraft,
  CollectionRead,
} from '@/projection/contract';
import {
  assertScope,
  assertSynchronous,
  type OutputListener,
  type OutputRecord,
  type ProcessorRecord,
  type ProducerRecord,
} from '@/projection/graph/scheduler';

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
  const published = createCollectionState<K, V>();
  const staged = new Map<K, CollectionEntry<V>>();
  let nextIds = published.ids();
  let change: CollectionChange<K, V> | undefined;
  let initialized = false;
  let reset = false;
  let revision = 0;
  let explicitOrder: readonly K[] | undefined;
  let cleared = false;
  const listeners = new Set<OutputListener>();
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

  const deriveIds = (): K[] => {
    const result: K[] = [];
    if (!cleared) for (const key of published.ids()) if (hasNext(key)) result.push(key);
    for (const [key, entry] of staged)
      if (entry.present && (cleared || !published.has(key))) result.push(key);
    return result;
  };

  const begin = (active: () => boolean, initialize: boolean): CollectionOutputEvaluation<K, V> => {
    staged.clear();
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
        if (!next) return published.ids();
        if (explicitOrder) return explicitOrder;
        return Object.freeze(deriveIds());
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
        explicitOrder = snapshotArray(order);
      },
    };
    return { previous: read(false), next: read(true), output };
  };

  const seal = (nextReset: boolean, isEqual: (previous: V, next: V) => boolean): boolean => {
    if (cleared)
      for (const key of published.keys()) if (!staged.has(key)) staged.set(key, { present: false });

    profile.projection('touchedKeys', staged.size);
    const addedEntries: { readonly key: K; readonly after: V }[] = [];
    const updatedEntries: { readonly key: K; readonly before: V; readonly after: V }[] = [];
    const removedEntries: { readonly key: K; readonly before: V }[] = [];
    for (const [key, entry] of staged) {
      const existed = published.has(key);
      if (entry.present) {
        if (!existed) {
          addedEntries.push({ key, after: entry.value });
          continue;
        }
        const before = published.get(key) as V;
        const equal = isEqual(before, entry.value);
        assertSynchronous(equal);
        if (!equal) updatedEntries.push({ key, before, after: entry.value });
        else if (nextReset) staged.set(key, { present: true, value: before });
        else staged.delete(key);
        continue;
      }
      if (existed) {
        removedEntries.push({ key, before: published.get(key) as V });
      } else staged.delete(key);
    }

    const ids = published.ids();
    if (explicitOrder) {
      const expectedLength = published.size() + addedEntries.length - removedEntries.length;
      const seen = new Set<K>();
      for (const key of explicitOrder) {
        if (seen.has(key) || !hasNext(key))
          throw new TypeError('Projection order must contain every key exactly once.');
        seen.add(key);
      }
      if (seen.size !== expectedLength)
        throw new TypeError('Projection order must contain every key exactly once.');
      nextIds = sameArray(ids, explicitOrder) ? ids : explicitOrder;
    } else if (addedEntries.length || removedEntries.length) {
      const order = new Array<K>(published.size() + addedEntries.length - removedEntries.length);
      let index = 0;
      for (const key of ids) if (hasNext(key)) order[index++] = key;
      for (const entry of addedEntries) order[index++] = entry.key;
      nextIds = sameArray(ids, order) ? ids : Object.freeze(order);
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
      if (change) published.install(staged, nextIds, change.kind === 'reset');
      if (change && initialized) revision++;
      initialized = true;
    },
    emit: call => {
      Array.from(listeners).forEach(listener =>
        call(listener, change as CollectionChange<string, unknown> | undefined)
      );
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
