import type {
  CollectionContext,
  GraphSource,
  GraphSources,
  ValueNode,
  ValueNodeSpec,
  ExternalCollectionSource,
  ExternalValueSource,
} from './contract';
import { assertSynchronous, createScheduler } from './scheduler';
import { createSources } from './source';
import { createValue } from './value';
import { createCollection } from './collection';
import type { ProjectionError } from './contract';
import { profile } from '../profile';
export const createProjectionGraph = (options: {
  readonly onError: (error: ProjectionError) => void;
}) => {
  const scheduler = createScheduler(options.onError);
  const sources = createSources(scheduler);
  const value = <S extends GraphSources, T>(
    spec: ValueNodeSpec<S, T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): ValueNode<T> => createValue(scheduler, spec, options);
  const map = <K extends string, V, R>(
    source: GraphSource<CollectionContext<K, V>>,
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
      build: ({ sources, output }) => {
        const input = sources.source;
        const read = input.read;
        const ids = read.ids();
        profile.collectionView.idsScanned(ids.length);
        for (const id of ids) {
          profile.collectionView.mapped();
          output.set(id, calculate(id, read.get(id)!));
        }
        output.order(ids);
        return {
          update: ({ sources, output }) => {
            const input = sources.source;
            const read = input.read;
            if (input.change?.kind === 'reset') return { kind: 'rebuild' };
            const change = input.change;
            if (!change) return;
            for (const entry of change.added) {
              profile.collectionView.mapped();
              output.set(entry.key, calculate(entry.key, entry.after));
            }
            for (const entry of change.updated) {
              profile.collectionView.mapped();
              output.set(entry.key, calculate(entry.key, entry.after));
            }
            for (const entry of change.removed) output.remove(entry.key);
            if (change.added.length || change.removed.length || change.order) {
              const ids = read.ids();
              profile.collectionView.idsScanned(ids.length);
              output.order(ids);
            }
          },
        };
      },
    });
  };
  const graph = {
    document: sources.document,
    fromSource: <T>(
      source: ExternalValueSource<T>,
      options?: { readonly isEqual?: (a: T, b: T) => boolean }
    ) => sources.fromSource(source, options),
    fromCollectionSource: <K extends string, V>(source: ExternalCollectionSource<K, V>) =>
      sources.fromCollectionSource(source),
    input: sources.input,
    fromReadable: sources.fromReadable,
    value,
    collection: <S extends GraphSources, K extends string, V>(
      spec: import('./contract').CollectionNodeSpec<S, K, V>
    ) => createCollection(scheduler, spec),
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
  return Object.freeze(graph);
};
