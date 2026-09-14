import type { Unsubscribe } from '../runtime/contract';
import type { CollectionImpact } from '../impact';
import type {
  CollectionRead,
  CollectionReadable,
  MaterializedCollection,
  ProjectionEngine,
  ProjectionBatchOptions,
  MaterializedValue,
} from './contract';
import type { Readable } from './readable';
import {
  definitionOf,
  type CollectionProjection,
  type InputProjection,
  type Projection,
  type ValueProjection,
} from './definition';
import { createProjectionEngine, projectionEngineDebug } from './runtime';

type Materialized = MaterializedValue<unknown> | MaterializedCollection<string, unknown> | object;

export type ProjectionRuntime = {
  get<K extends string, V>(projection: CollectionProjection<K, V>): CollectionRead<K, V>;
  get<T>(projection: ValueProjection<T>): T;
  collection<K extends string, V>(projection: CollectionProjection<K, V>): CollectionReadable<K, V>;
  item<K extends string, V>(
    projection: CollectionProjection<K, V>,
    key: K
  ): Readable<V | undefined>;
  set<T>(projection: InputProjection<T>, value: T): void;
  subscribe<K extends string, V>(
    projection: CollectionProjection<K, V>,
    listener: (change: CollectionImpact<K>) => void
  ): Unsubscribe;
  subscribe<T>(projection: ValueProjection<T>, listener: () => void): Unsubscribe;
  revision(projection: ValueProjection<unknown> | CollectionProjection<string, unknown>): number;
  rebuild(projection: ValueProjection<unknown> | CollectionProjection<string, unknown>): void;
  release(projection: ValueProjection<unknown> | CollectionProjection<string, unknown>): void;
  batch<T>(run: () => T): T;
  batch<T>(options: ProjectionBatchOptions, run: () => T): T;
  dispose(): void;
};

const stores = new WeakMap<object, ProjectionEngine>();
export const projectionRuntimeDebug = (owner: ProjectionRuntime) => {
  const runtime = stores.get(owner);
  if (!runtime) throw new Error('Unknown projection store.');
  return projectionEngineDebug(runtime);
};

export const createProjectionRuntime = (options: {
  readonly onError: Parameters<typeof createProjectionEngine>[0]['onError'];
}): ProjectionRuntime => {
  const runtime = createProjectionEngine(options);
  const instances = new WeakMap<object, Materialized>();
  const inputs = new WeakMap<object, { readonly source: object; set(value: unknown): void }>();
  const materialize = (
    projection: Projection<unknown, unknown, 'source' | 'value' | 'collection'>
  ): Materialized => {
    const old = instances.get(projection);
    if (old) return old;
    const definition = definitionOf(projection);
    let instance: Materialized;
    if (definition.kind === 'input') {
      const input = runtime.input(definition.initial, { isEqual: definition.isEqual as never });
      inputs.set(projection, input);
      instance = runtime.value({ input: input.source }, ({ input }) => input.value);
    } else if (definition.kind === 'readable') {
      const source = runtime.fromReadable(definition.readable, {
        isEqual: definition.isEqual as never,
      });
      instance = runtime.value({ source }, ({ source }) => source.value);
    } else if (definition.kind === 'source-value') {
      instance = runtime.fromSource(definition.source as never);
    } else if (definition.kind === 'source-collection') {
      instance = runtime.fromCollectionSource(definition.source as never);
    } else if (definition.kind === 'document') {
      const document = runtime.document(definition.document);
      instance = definition.targets?.length
        ? document.targets(...(definition.targets as [never, ...never[]]))
        : document;
    } else if (definition.kind === 'document-collection')
      instance = runtime.document(definition.document).collection(definition.pick as never);
    else if (definition.kind === 'map')
      instance = runtime.map(materialize(definition.source) as never, definition.mapper as never, {
        isEqual: definition.isEqual as never,
      });
    else {
      const sources = Object.fromEntries(
        Object.entries(definition.sources).map(([key, source]) => [key, materialize(source)])
      );
      if (definition.kind === 'value') {
        instance = runtime.value(
          sources as never,
          (events: Record<string, unknown>) => {
            const values = Object.fromEntries(
              Object.entries(events).map(([key, event]) => [key, current(event)])
            );
            return definition.compute(values as never);
          },
          { isEqual: definition.isEqual as never }
        );
      } else if (definition.kind === 'advanced-value')
        instance = runtime.value(
          { sources: sources as never, build: definition.build as never, name: definition.name },
          { isEqual: definition.isEqual as never }
        );
      else
        instance = runtime.collection<unknown>()({
          sources: sources as never,
          build: definition.build as never,
          isEqual: definition.isEqual as never,
          name: definition.name,
        });
    }
    instances.set(projection, instance);
    return instance;
  };
  const current = (event: unknown): unknown => {
    if (event && typeof event === 'object') {
      if ('value' in event) return (event as { value: unknown }).value;
      if ('read' in event) return (event as { read: unknown }).read;
    }
    return event;
  };
  const store: ProjectionRuntime = {
    get: ((projection: Projection<unknown, unknown, 'source' | 'value' | 'collection'>) => {
      const instance = materialize(projection);
      if ('current' in instance && typeof instance.current === 'function')
        return instance.current();
      throw new TypeError('Projection is a source and has no published value.');
    }) as ProjectionRuntime['get'],
    collection: ((projection: CollectionProjection<string, unknown>) => {
      const instance = materialize(projection);
      if (
        !('current' in instance) ||
        typeof instance.current !== 'function' ||
        !('item' in instance) ||
        typeof instance.item !== 'function' ||
        !('ids' in instance) ||
        !('all' in instance)
      )
        throw new TypeError('Projection is not a materialized collection.');
      return instance as CollectionReadable<string, unknown>;
    }) as ProjectionRuntime['collection'],
    item: ((projection, key) => {
      const instance = materialize(projection);
      if (!('item' in instance) || typeof instance.item !== 'function')
        throw new TypeError('Projection is not a materialized collection.');
      return instance.item(key);
    }) as ProjectionRuntime['item'],
    set: (projection, value) => {
      materialize(projection);
      const target = inputs.get(projection);
      if (!target) throw new TypeError('Projection is not an input.');
      target.set(value);
    },
    subscribe: ((
      projection: Projection<unknown, unknown, 'source' | 'value' | 'collection'>,
      listener: Function
    ) => {
      const instance = materialize(projection);
      if (!('subscribe' in instance))
        throw new TypeError('Projection is a source and cannot be subscribed.');
      return instance.subscribe(listener as never);
    }) as ProjectionRuntime['subscribe'],
    revision: projection => {
      const instance = materialize(projection);
      if (!('revision' in instance) || typeof instance.revision !== 'function')
        throw new TypeError('Projection has no published revision.');
      return instance.revision();
    },
    rebuild: projection => {
      const instance = materialize(projection);
      if (!('rebuild' in instance) || typeof instance.rebuild !== 'function')
        throw new TypeError('Projection cannot be rebuilt.');
      instance.rebuild();
    },
    release: projection => {
      const instance = instances.get(projection);
      if (!instance) return;
      if ('dispose' in instance && typeof instance.dispose === 'function') instance.dispose();
      instances.delete(projection);
      inputs.delete(projection);
    },
    batch: runtime.batch,
    dispose: runtime.dispose,
  };
  stores.set(store, runtime);
  return Object.freeze(store);
};
