import type { GraphSources, ValueNode, ValueNodeSpec } from './contract';
import { createNode } from './node';
import { assertSynchronous, type Scheduler } from './scheduler';
import { profile } from '../profile';
import { createValueState } from './value-state';

export const createValue = <S extends GraphSources, T>(
  scheduler: Scheduler,
  spec: ValueNodeSpec<S, T>,
  options?: { readonly isEqual?: (a: T, b: T) => boolean }
): ValueNode<T> => {
  let instance: ReturnType<typeof spec.build> | undefined;
  let cause: unknown;
  const state = createValueState<T>();
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
      let evaluation = state.begin(active, build);
      if (build || !instance) {
        profile.materialized.rebuilt();
        instance = undefined;
        const built = spec.build(sources);
        assertSynchronous(built);
        instance = built;
        evaluation.output.set(built.value);
      } else {
        profile.materialized.updated();
        const result = instance.update(sources);
        assertSynchronous(result);
        if (result.kind === 'rebuild') {
          evaluation = state.begin(active, true);
          instance = undefined;
          const built = spec.build(sources);
          assertSynchronous(built);
          instance = built;
          evaluation.output.set(built.value);
          build = true;
        } else if (result.kind === 'changed') evaluation.output.set(result.value);
      }
      return state.seal(build, options?.isEqual ?? Object.is);
    },
    context: active => state.context(active, cause),
    revision: state.revision,
    reset: state.reset,
    publish: state.publish,
    emit: state.emit,
    clear: () => {
      state.clear();
      cause = undefined;
    },
    release: () => {
      state.release();
      instance = undefined;
    },
  });
  const handle = Object.freeze({
    kind: 'value' as const,
    current: () => state.current(owner.check),
    revision: () => {
      owner.check();
      return state.revision();
    },
    subscribe: (listener: () => void) => {
      owner.check();
      state.subscribe(listener);
      return () => state.unsubscribe(listener);
    },
  }) as ValueNode<T>;
  owner.install(handle);
  return handle;
};
