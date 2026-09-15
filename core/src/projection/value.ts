import type { GraphSources, ValueNode, ValueNodeSpec } from './contract';
import { createNode } from './node';
import { assertScope, assertSynchronous, type Scheduler } from './scheduler';
import { profile } from '../profile';

export const createValue = <S extends GraphSources, T>(
  scheduler: Scheduler,
  spec: ValueNodeSpec<S, T>,
  options?: { readonly isEqual?: (a: T, b: T) => boolean }
): ValueNode<T> => {
  let instance: ReturnType<typeof spec.build> | undefined;
  let value!: T;
  let next!: T;
  let initialized = false;
  let revision = 0;
  let changed = false;
  let reset = false;
  let cause: unknown;
  const listeners = new Set<() => void>();
  const owner = createNode(scheduler, spec, {
    evaluate: (sources, build) => {
      const metadata = Object.values(sources as Record<string, unknown>).find(
        value =>
          value &&
          typeof value === 'object' &&
          'cause' in value &&
          (value as { readonly cause?: unknown }).cause !== undefined
      ) as { readonly cause?: unknown } | undefined;
      cause = metadata?.cause ?? scheduler.batchContext()?.cause;
      let candidate: T;
      if (build || !instance) {
        profile.materialized.rebuilt();
        instance = undefined;
        const built = spec.build(sources);
        assertSynchronous(built);
        instance = built;
        candidate = built.value;
      } else {
        profile.materialized.updated();
        const result = instance.update(sources);
        assertSynchronous(result);
        if (result.kind === 'rebuild') {
          instance = undefined;
          const built = spec.build(sources);
          assertSynchronous(built);
          instance = built;
          candidate = built.value;
          build = true;
        } else candidate = result.kind === 'changed' ? result.value : value;
      }
      changed = !initialized || !(options?.isEqual ?? Object.is)(value, candidate);
      next = changed ? candidate : value;
      reset = build;
      return changed;
    },
    context: active => {
      assertScope(active);
      return Object.freeze({
        kind: 'value' as const,
        value: next,
        revision: revision + (changed ? 1 : 0),
        reset,
        cause,
      });
    },
    revision: () => revision,
    reset: () => reset,
    publish: () => {
      if (changed && initialized) revision++;
      value = next;
      initialized = true;
    },
    emit: call => {
      profile.materialized.notification();
      Array.from(listeners).forEach(listener => call(listener));
    },
    clear: () => {
      next = value;
      changed = false;
      reset = false;
      cause = undefined;
    },
    release: () => {
      listeners.clear();
      instance = undefined;
      value = next = undefined as T;
    },
  });
  const handle = Object.freeze({
    kind: 'value' as const,
    current: () => {
      owner.check();
      return value;
    },
    revision: () => {
      owner.check();
      return revision;
    },
    subscribe: (listener: () => void) => {
      owner.check();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  }) as ValueNode<T>;
  owner.install(handle);
  return handle;
};
