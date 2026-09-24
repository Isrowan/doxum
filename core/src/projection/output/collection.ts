import { createCollectionChanges } from '@/projection/collection/changes';
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
  context(active: () => boolean, consumer?: ProcessorRecord): CollectionContext<K, V>;
  baseline(): CollectionRead<K, V>;
  current(): CollectionRead<K, V>;
  publish(): void;
};

type CollectionOutputBinding = {
  owner(): ProducerRecord;
  check(): void;
  cause(): unknown;
};

/** Owns staged keyed intent, exact transitions and current collection state. */
export const createCollectionOutput = <K extends string, V>(
  binding: CollectionOutputBinding
): CollectionOutputState<K, V> => {
  const currentState = createCollectionState<K, V>();
  const staged = new Map<K, CollectionEntry<V>>();
  let nextIds = currentState.ids();
  let change: CollectionChange<K, V> | undefined;
  let initialized = false;
  let reset = false;
  let revision = 0;
  let explicitOrder: readonly K[] | undefined;
  let cleared = false;
  const listeners = new Set<OutputListener>();
  const consumers = new Map<ProcessorRecord, ReturnType<typeof createCollectionChanges<K, V>>>();
  const notifications = createCollectionChanges<K, V>();
  const observers = new Set<OutputListener>();
  let baseline: CollectionRead<K, V> | undefined;

  const hasNext = (key: K): boolean =>
    staged.has(key) ? staged.get(key)!.present : !cleared && currentState.has(key);

  const getNext = (key: K): V | undefined => {
    const entry = staged.get(key);
    return entry
      ? entry.present
        ? entry.value
        : undefined
      : cleared
        ? undefined
        : currentState.get(key);
  };

  const deriveIds = (): K[] => {
    const result: K[] = [];
    if (!cleared) for (const key of currentState.ids()) if (hasNext(key)) result.push(key);
    for (const [key, entry] of staged)
      if (entry.present && (cleared || !currentState.has(key))) result.push(key);
    return result;
  };

  const begin = (active: () => boolean, initialize: boolean): CollectionOutputEvaluation<K, V> => {
    staged.clear();
    nextIds = currentState.ids();
    change = undefined;
    explicitOrder = undefined;
    cleared = initialize;
    reset = initialize;
    const read = (next: boolean): CollectionRead<K, V> => ({
      get: key => {
        assertScope(active);
        return next ? getNext(key) : currentState.get(key);
      },
      has: key => {
        assertScope(active);
        return next ? hasNext(key) : currentState.has(key);
      },
      ids: () => {
        assertScope(active);
        if (!next) return currentState.ids();
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
      for (const key of currentState.keys())
        if (!staged.has(key)) staged.set(key, { present: false });

    profile.projection('touchedKeys', staged.size);
    const addedEntries: { readonly key: K; readonly after: V }[] = [];
    const updatedEntries: { readonly key: K; readonly before: V; readonly after: V }[] = [];
    const removedEntries: { readonly key: K; readonly before: V }[] = [];
    for (const [key, original] of staged) {
      let entry = original;
      const existed = currentState.has(key);
      if (entry.present) {
        if (
          baseline?.has(key) &&
          (!existed || !Object.is(currentState.get(key), baseline.get(key)))
        ) {
          const before = baseline.get(key) as V;
          const equivalent = isEqual(before, entry.value);
          assertSynchronous(equivalent);
          if (equivalent) {
            entry = { present: true, value: before };
            staged.set(key, entry);
          }
        }
        if (!existed) {
          addedEntries.push({ key, after: entry.value });
          continue;
        }
        const before = currentState.get(key) as V;
        const equal = isEqual(before, entry.value);
        assertSynchronous(equal);
        if (!equal) updatedEntries.push({ key, before, after: entry.value });
        else if (nextReset) staged.set(key, { present: true, value: before });
        else staged.delete(key);
        continue;
      }
      if (existed) {
        removedEntries.push({ key, before: currentState.get(key) as V });
      } else staged.delete(key);
    }

    const ids = currentState.ids();
    if (explicitOrder) {
      const expectedLength = currentState.size() + addedEntries.length - removedEntries.length;
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
      const order = new Array<K>(currentState.size() + addedEntries.length - removedEntries.length);
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

  const context = (
    active: () => boolean,
    cause: unknown,
    consumer?: ProcessorRecord
  ): CollectionContext<K, V> =>
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
      change: consumer ? consumers.get(consumer)?.current() : change,
      revision,
      reset: consumer ? (consumers.get(consumer)?.reset() ?? false) : reset,
      cause,
    });

  return {
    kind: 'collection',
    get owner() {
      return binding.owner();
    },
    begin,
    seal,
    context: (active, consumer) => context(active, binding.cause(), consumer),
    acknowledge: consumer => consumers.get(consumer)?.clear(),
    pending: consumer => consumers.get(consumer)?.current() !== undefined,
    baseline: () => baseline ?? currentState.read(binding.check),
    current: () => currentState.read(binding.check),
    revision: () => revision,
    reset: consumer => (consumer ? (consumers.get(consumer)?.reset() ?? false) : reset),
    publish: () => {
      if (change) {
        if (initialized) {
          baseline ??= currentState.read(() => undefined);
          notifications.add(change, currentState.ids(), nextIds);
          for (const pending of consumers.values())
            pending.add(change, currentState.ids(), nextIds);
          revision++;
        }
        currentState.install(staged, nextIds, change.kind === 'reset');
      }
      initialized = true;
    },
    emit: (call, force) => {
      const net = notifications.current() as CollectionChange<string, unknown> | undefined;
      for (const listener of [...observers]) call(listener, net);
      if (net || force) for (const listener of [...listeners]) call(listener, net);
    },
    finish: () => {
      baseline = undefined;
      notifications.clear();
    },
    observe: listener => {
      binding.check();
      observers.add(listener);
      return () => observers.delete(listener);
    },
    hasConsumers: () => consumers.size > 0,
    forEachConsumer: run => consumers.forEach((_pending, consumer) => run(consumer)),
    attachConsumer: consumer => consumers.set(consumer, createCollectionChanges<K, V>()),
    detachConsumer: consumer => consumers.delete(consumer),
    clear: () => {
      staged.clear();
      nextIds = currentState.ids();
      change = undefined;
      reset = false;
      explicitOrder = undefined;
      cleared = false;
    },
    release: () => {
      currentState.release();
      staged.clear();
      listeners.clear();
      consumers.clear();
      observers.clear();
      baseline = undefined;
      notifications.clear();
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
