import { profile } from '../profile';
import type {
  CollectionChange,
  CollectionNode,
  CollectionNodeSpec,
  GraphSources,
} from './contract';
import { createCollectionState } from './collection-state';
import { createNode } from './node';
import { assertSynchronous, type Scheduler } from './scheduler';

export const createCollection = <S extends GraphSources, K extends string, V>(
  scheduler: Scheduler,
  spec: CollectionNodeSpec<S, K, V>
): CollectionNode<K, V> => {
  const state = createCollectionState<K, V>();
  let instance: ReturnType<typeof spec.build> | undefined;
  let cause: unknown;
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
      const input = state.begin(active, build);
      if (build || !instance) {
        profile.materialized.rebuilt();
        instance = undefined;
        const built = spec.build({ sources, ...input });
        assertSynchronous(built);
        instance = built;
      } else {
        profile.materialized.updated();
        const result = instance.update({ sources, ...input });
        assertSynchronous(result);
        if (result?.kind === 'rebuild') {
          const rebuildInput = state.begin(active, true);
          instance = undefined;
          const built = spec.build({ sources, ...rebuildInput });
          assertSynchronous(built);
          instance = built;
          build = true;
        }
      }
      return state.seal(build, spec.isEqual ?? Object.is);
    },
    context: active => state.context(active, cause),
    revision: state.revision,
    reset: state.reset,
    publish: state.publish,
    emit: state.emit,
    clear: state.clear,
    release: () => {
      state.release();
      instance = undefined;
    },
  });
  const handle = {
    kind: 'collection' as const,
    current: () => {
      owner.check();
      return state.current(owner.check);
    },
    revision: () => {
      owner.check();
      return state.revision();
    },
    subscribe: (listener: (change: CollectionChange<K, V>) => void) => {
      owner.check();
      state.subscribe(listener);
      return () => state.unsubscribe(listener);
    },
  } as CollectionNode<K, V>;
  owner.install(handle);
  return Object.freeze(handle);
};
