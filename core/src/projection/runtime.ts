import type {
  CollectionInput,
  CollectionRead,
  EngineInputs,
  ProjectionEngine,
  EngineSource,
  EngineSources,
  MaterializedValue,
  EngineValueSpec,
} from './contract';
import type { Synchronous } from '../runtime/contract';
import { assertSynchronous, createScheduler } from './scheduler';
import { createSources } from './source';
import { createValue } from './value';
import { createCollection } from './collection';
import type { ProjectionError } from './contract';
import { profile } from '../profile';

const debug = new WeakMap<
  object,
  () => { nodes: number; sources: number; subscriptions: number; pending: number }
>();
export const projectionEngineDebug = (runtime: ProjectionEngine) => {
  const read = debug.get(runtime);
  if (!read) throw new Error('Unknown projection engine.');
  return Object.freeze(read());
};
export const createProjectionEngine = (options: {
  readonly onError: (error: ProjectionError) => void;
}): ProjectionEngine => {
  const scheduler = createScheduler(options.onError);
  const sources = createSources(scheduler);
  function value<S extends EngineSources, T>(
    sources: S,
    compute: (sources: EngineInputs<S>) => Synchronous<T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): MaterializedValue<T>;
  function value<S extends EngineSources, T>(
    spec: EngineValueSpec<S, T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): MaterializedValue<T>;
  function value<S extends EngineSources, T>(
    input: S | EngineValueSpec<S, T>,
    computeOrOptions?:
      ((sources: EngineInputs<S>) => T) | { readonly isEqual?: (a: T, b: T) => boolean },
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): MaterializedValue<T> {
    if (typeof computeOrOptions !== 'function')
      return createValue(scheduler, input as EngineValueSpec<S, T>, computeOrOptions);
    const compute = (input: EngineInputs<S>) => {
      const result = computeOrOptions(input);
      assertSynchronous(result);
      return result;
    };
    return createValue(
      scheduler,
      {
        sources: input as S,
        build: input => ({
          value: compute(input),
          update: input => ({ kind: 'changed', value: compute(input) }),
        }),
      },
      options
    );
  }
  const map = <K extends string, V, R>(
    source: EngineSource<
      | CollectionInput<K, V>
      | {
          readonly read: CollectionRead<K, V>;
          readonly reset: boolean;
          readonly candidates: { readonly keys: readonly K[]; readonly orderDirty: boolean };
        }
    >,
    mapper: (id: K, entry: V) => R,
    options?: { readonly isEqual?: (a: R, b: R) => boolean }
  ) => {
    sources.assertCollection(source);
    const calculate = (id: K, entry: V): R => {
      const value = mapper(id, entry);
      assertSynchronous(value);
      return value;
    };
    return createCollection(scheduler, {
      sources: { source },
      isEqual: options?.isEqual,
      build: ({ sources, writer }) => {
        const input = sources.source;
        const read = 'read' in input ? input.read : input;
        const ids = read.ids();
        profile.collectionView.idsScanned(ids.length);
        for (const id of ids) {
          profile.collectionView.mapped();
          writer.set(id, calculate(id, read.get(id)!));
        }
        writer.order(ids);
        return {
          update: ({ sources, writer }) => {
            const input = sources.source;
            if (input.reset) return { kind: 'rebuild' };
            const read = 'read' in input ? input.read : input;
            let keys: Iterable<K>;
            let structural: boolean;
            if ('candidates' in input) {
              keys = input.candidates.keys;
              structural = input.candidates.orderDirty;
            } else {
              const change = input.change;
              if (!change) return;
              if (change.kind === 'reset') return { kind: 'rebuild' };
              keys = new Set([...change.added, ...change.removed, ...change.updated]);
              structural = Boolean(change.added.size || change.removed.size || change.orderChanged);
            }
            for (const key of keys) {
              if (!read.has(key)) writer.remove(key);
              else {
                profile.collectionView.mapped();
                writer.set(key, calculate(key, read.get(key)!));
              }
            }
            if (structural) {
              const ids = read.ids();
              profile.collectionView.idsScanned(ids.length);
              writer.order(ids);
            }
          },
        };
      },
    });
  };
  const runtime: ProjectionEngine = {
    document: sources.document,
    input: sources.input,
    fromReadable: sources.fromReadable,
    value,
    collection: () => spec => createCollection(scheduler, spec),
    map,
    batch: scheduler.batch,
    dispose: () => {
      try {
        scheduler.dispose();
      } finally {
        if (!scheduler.active) sources.dispose();
      }
    },
  };
  debug.set(runtime, scheduler.debug);
  return Object.freeze(runtime);
};
