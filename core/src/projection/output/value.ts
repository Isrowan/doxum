import { profile } from '@/profile';
import type { ValueContext } from '@/projection/contract';
import {
  assertScope,
  assertSynchronous,
  type OutputListener,
  type OutputRecord,
  type ProcessorRecord,
  type ProducerRecord,
} from '@/projection/graph/scheduler';

const unset = Symbol('projection-value-unset');

type ValueOutputEvaluation<T> = {
  readonly previous: T | undefined;
  readonly next: () => T | undefined;
  readonly output: { set(value: T): void };
};

export type ValueOutputState<T> = OutputRecord & {
  begin(active: () => boolean, initialize: boolean): ValueOutputEvaluation<T>;
  seal(reset: boolean, isEqual: (previous: T, next: T) => boolean): boolean;
  publish(forceReset?: boolean): void;
  baseline(): T;
};

type ValueOutputBinding = {
  owner(): ProducerRecord;
  check(): void;
  cause(): unknown;
};

/** Owns staged and current state for one scalar Projection output. */
export const createValueOutput = <T>(binding: ValueOutputBinding): ValueOutputState<T> => {
  let value!: T;
  let staged: T | typeof unset = unset;
  let next!: T;
  let initialized = false;
  let revision = 0;
  let changed = false;
  let reset = false;
  const listeners = new Set<OutputListener>();
  const consumers = new Map<ProcessorRecord, { revision: number; value: T }>();
  const observers = new Set<OutputListener>();
  let baseline: T | typeof unset = unset;
  let resetRevision = -1;

  const begin = (active: () => boolean, initialize: boolean): ValueOutputEvaluation<T> => {
    staged = unset;
    next = value;
    changed = false;
    reset = initialize;
    return {
      previous: initialized ? value : undefined,
      next: () => {
        assertScope(active);
        if (staged !== unset) return staged;
        return initialize ? undefined : initialized ? value : undefined;
      },
      output: Object.freeze({
        set: (candidate: T) => {
          assertScope(active);
          staged = candidate;
        },
      }),
    };
  };

  const seal = (nextReset: boolean, isEqual: (previous: T, next: T) => boolean): boolean => {
    if (reset && staged === unset)
      throw new TypeError('Value output must be initialized on reset.');
    if (staged === unset) {
      reset = nextReset;
      changed = false;
      next = value;
      return false;
    }
    let candidate = staged;
    if (baseline !== unset && !Object.is(value, baseline)) {
      const equivalent = isEqual(baseline, candidate);
      assertSynchronous(equivalent);
      if (equivalent) candidate = baseline;
    }
    const equal = initialized ? isEqual(value, candidate) : false;
    assertSynchronous(equal);
    changed = !equal;
    next = changed ? candidate : value;
    reset = nextReset;
    return changed;
  };

  return {
    kind: 'value',
    get owner() {
      return binding.owner();
    },
    begin,
    seal,
    context: (active, consumer) => {
      assertScope(active);
      return Object.freeze({
        kind: 'value' as const,
        value: next,
        revision,
        reset: consumer ? (consumers.get(consumer)?.revision ?? -1) < resetRevision : reset,
        cause: binding.cause(),
      });
    },
    current: () => {
      binding.check();
      return value;
    },
    revision: () => revision,
    reset: consumer =>
      consumer ? (consumers.get(consumer)?.revision ?? -1) < resetRevision : reset,
    acknowledge: consumer => {
      if (consumers.has(consumer)) consumers.set(consumer, { revision, value });
    },
    pending: consumer => {
      const previous = consumers.get(consumer);
      return !previous || previous.revision < resetRevision || !Object.is(previous.value, value);
    },
    baseline: () => (baseline === unset ? value : baseline),
    publish: forceReset => {
      if (initialized && (changed || forceReset)) {
        if (baseline === unset) baseline = value;
        revision++;
        if (reset) resetRevision = revision;
      }
      if (changed) value = next;
      initialized = true;
    },
    emit: (call, force) => {
      for (const listener of [...observers]) call(listener, undefined);
      if (force || (baseline !== unset && !Object.is(baseline, value))) {
        profile.materialized.notification();
        for (const listener of [...listeners]) call(listener, undefined);
      }
    },
    finish: () => {
      baseline = unset;
    },
    observe: listener => {
      binding.check();
      observers.add(listener);
      return () => observers.delete(listener);
    },
    hasConsumers: () => consumers.size > 0,
    forEachConsumer: run => consumers.forEach((_revision, consumer) => run(consumer)),
    attachConsumer: consumer => consumers.set(consumer, { revision, value }),
    detachConsumer: consumer => consumers.delete(consumer),
    clear: () => {
      staged = unset;
      next = value;
      changed = false;
      reset = false;
    },
    release: () => {
      listeners.clear();
      consumers.clear();
      observers.clear();
      baseline = unset;
      staged = unset;
      value = next = undefined as T;
      initialized = false;
      revision = 0;
      changed = false;
      reset = false;
    },
    subscribe: listener => {
      binding.check();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
