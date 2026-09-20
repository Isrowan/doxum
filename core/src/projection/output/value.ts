import { profile } from '../../profile';
import type { ValueContext } from '../contract';
import {
  assertScope,
  type OutputRecord,
  type ProcessorRecord,
  type ProducerRecord,
} from '../graph/scheduler';

const unset = Symbol('projection-value-unset');

export type ValueOutputEvaluation<T> = {
  readonly previous: T | undefined;
  readonly next: () => T | undefined;
  readonly output: { set(value: T): void };
};

export type ValueOutputState<T> = OutputRecord & {
  begin(active: () => boolean, initialize: boolean): ValueOutputEvaluation<T>;
  seal(reset: boolean, isEqual: (previous: T, next: T) => boolean): boolean;
  publish(): void;
};

type ValueOutputBinding = {
  owner(): ProducerRecord;
  check(): void;
  cause(): unknown;
};

/** Owns staged and published state for one scalar Projection output. */
export const createValueOutput = <T>(binding: ValueOutputBinding): ValueOutputState<T> => {
  let value!: T;
  let staged: T | typeof unset = unset;
  let next!: T;
  let initialized = false;
  let revision = 0;
  let changed = false;
  let reset = false;
  const listeners = new Set<() => void>();
  const consumers = new Set<ProcessorRecord>();

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
    const candidate = staged;
    changed = !initialized || !isEqual(value, candidate);
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
    context: active => {
      assertScope(active);
      return Object.freeze({
        kind: 'value' as const,
        value: next,
        revision,
        reset,
        cause: binding.cause(),
      });
    },
    current: () => {
      binding.check();
      return value;
    },
    revision: () => revision,
    reset: () => reset,
    publish: () => {
      if (changed && initialized) revision++;
      if (changed) value = next;
      initialized = true;
    },
    emit: call => {
      profile.materialized.notification();
      Array.from(listeners).forEach(listener => call(listener));
    },
    hasConsumers: () => consumers.size > 0,
    forEachConsumer: run => consumers.forEach(run),
    attachConsumer: consumer => consumers.add(consumer),
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
