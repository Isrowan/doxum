import { profile } from '../profile';
import type { ValueContext } from './contract';
import { assertScope } from './scheduler';

const unset = Symbol('projection-value-unset');

export type ValueOutputEvaluation<T> = {
  readonly previous: T | undefined;
  readonly next: () => T | undefined;
  readonly output: { set(value: T): void };
};

export type ValueOutputState<T> = {
  begin(active: () => boolean, initialize: boolean): ValueOutputEvaluation<T>;
  seal(reset: boolean, isEqual: (previous: T, next: T) => boolean): boolean;
  context(active: () => boolean, cause: unknown): ValueContext<T>;
  current(check: () => void): T;
  revision(): number;
  reset(): boolean;
  publish(): void;
  emit(call: (listener: () => void) => void): void;
  clear(): void;
  release(): void;
  subscribe(listener: () => void): void;
  unsubscribe(listener: () => void): void;
};

/** Owns staged and published state for one scalar Projection output. */
export const createValueOutput = <T>(): ValueOutputState<T> => {
  let value!: T;
  let staged: T | typeof unset = unset;
  let next!: T;
  let initialized = false;
  let revision = 0;
  let changed = false;
  let reset = false;
  const listeners = new Set<() => void>();

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
    begin,
    seal,
    context: (active, cause) => {
      assertScope(active);
      return Object.freeze({
        kind: 'value' as const,
        value: next,
        revision,
        reset,
        cause,
      });
    },
    current: check => {
      check();
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
    clear: () => {
      staged = unset;
      next = value;
      changed = false;
      reset = false;
    },
    release: () => {
      listeners.clear();
      staged = unset;
      value = next = undefined as T;
      initialized = false;
      revision = 0;
      changed = false;
      reset = false;
    },
    subscribe: listener => listeners.add(listener),
    unsubscribe: listener => listeners.delete(listener),
  };
};
