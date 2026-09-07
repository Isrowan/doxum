import type { ProjectionRuntime } from './contract';
import { createScheduler } from './scheduler';
import { createSources } from './source';
import { createValue } from './value';
import { createCollection } from './collection';
import type { ProjectionError } from './contract';
import { profile } from '../profile';

const debug = new WeakMap<
  object,
  () => { nodes: number; sources: number; subscriptions: number; pending: number }
>();
export const projectionDebug = (runtime: ProjectionRuntime) => {
  const read = debug.get(runtime);
  if (!read) throw new Error('Unknown projection runtime.');
  return Object.freeze(read());
};
export const createProjectionRuntime = (options: {
  readonly onError: (error: ProjectionError) => void;
}): ProjectionRuntime => {
  const scheduler = createScheduler(options.onError);
  const sources = createSources(scheduler);
  const runtime: ProjectionRuntime = {
    document: sources.document,
    input: sources.input,
    fromReadable: sources.fromReadable,
    value: spec => createValue(scheduler, spec),
    collection: spec => createCollection(scheduler, spec),
    map: (source, mapper, options) => {
      sources.collectionTarget(source);
      return createCollection(scheduler, {
        sources: { source },
        isEqual: options?.isEqual,
        build: ({ sources, writer }) => {
          const ids = sources.source.read.ids();
          profile.collectionView.idsScanned(ids.length);
          for (const id of ids) {
            profile.collectionView.mapped();
            writer.set(id, mapper(id, sources.source.read.get(id)!));
          }
          writer.order(ids);
          return {
            update: ({ sources, writer }) => {
              const input = sources.source;
              const keys = new Set<string>();
              let structural = false;
              for (const commit of input.commits) {
                const impact = commit.impact.collection(input.target);
                if (impact.kind === 'reset') return { kind: 'rebuild' };
                impact.added.forEach(key => keys.add(key));
                impact.removed.forEach(key => keys.add(key));
                impact.updated.forEach(key => keys.add(key));
                structural ||= Boolean(
                  impact.added.size || impact.removed.size || impact.orderChanged
                );
              }
              for (const key of keys) {
                const entry = input.read.get(key);
                if (!entry) writer.remove(key);
                else {
                  profile.collectionView.mapped();
                  writer.set(key, mapper(key, entry));
                }
              }
              if (structural) {
                const ids = input.read.ids();
                profile.collectionView.idsScanned(ids.length);
                writer.order(ids);
              }
            },
          };
        },
      });
    },
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
