import type { ProjectionSources, ProjectionValue, ValueSpec } from './contract';
import { createNode } from './node';
import { assertScope, assertSynchronous, type Scheduler } from './scheduler';
import { profile } from '../profile';

export const createValue = <S extends ProjectionSources, T>(
  scheduler: Scheduler,
  spec: ValueSpec<S, T>,
  options?: { readonly isEqual?: (a: T, b: T) => boolean }
): ProjectionValue<T> => {
  let instance: ReturnType<typeof spec.build> | undefined;
  let value!: T;
  let next!: T;
  let previous!: T;
  let initialized = false;
  let revision = 0;
  let changed = false;
  let reset = false;
  const listeners = new Set<() => void>();
  const owner = createNode(scheduler, spec, {
    evaluate: (sources, build) => {
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
      previous = value;
      changed = !initialized || !(options?.isEqual ?? Object.is)(value, candidate);
      next = changed ? candidate : value;
      reset = build;
      return changed;
    },
    context: active => {
      assertScope(active);
      return Object.freeze({
        value: next,
        previous,
        changed,
        revision: revision + (changed ? 1 : 0),
        reset,
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
      previous = value;
      changed = false;
      reset = false;
    },
    release: () => {
      listeners.clear();
      instance = undefined;
      value = next = previous = undefined as T;
    },
  });
  const handle = Object.freeze({
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
    rebuild: owner.rebuild,
    dispose: owner.dispose,
  }) as ProjectionValue<T>;
  owner.install(handle);
  return handle;
};
