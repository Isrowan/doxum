import type { Projection } from './definition';
import { defineIncrementalCollection, defineIncrementalValue } from './definition';
import type { CollectionChange, CollectionDraft, CollectionRead, GraphSources } from './contract';
import { snapshot } from '../access/scope';

type ProjectionValues<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Projection<infer T, unknown> ? T : never;
};

type ProjectionChanges<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Projection<unknown, infer C>
    ? [C] extends [undefined]
      ? undefined
      : C | undefined
    : undefined;
};

export type IncrementalValueContext<D extends readonly Projection<unknown, unknown>[], T> = {
  readonly sources: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: T | undefined;
  readonly reset: boolean;
  readonly cause: unknown;
  readonly state: Record<string, unknown>;
};

export type IncrementalValueProcessor<D extends readonly Projection<unknown, unknown>[], T> = (
  context: IncrementalValueContext<D, T>
) => T | { readonly kind: 'rebuild' };

export type IncrementalCollectionContext<
  D extends readonly Projection<unknown, unknown>[],
  K extends string,
  V,
> = {
  readonly sources: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly reset: boolean;
  readonly cause: unknown;
  readonly state: Record<string, unknown>;
  readonly output: CollectionDraft<K, V>;
};

export type IncrementalCollectionProcessor<
  D extends readonly Projection<unknown, unknown>[],
  K extends string,
  V,
> = (context: IncrementalCollectionContext<D, K, V>) => void | { readonly kind: 'rebuild' };

type DependencyMap<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D as `d${Extract<K, number>}`]: D[K];
};

const resetCollectionChange = Object.freeze({ kind: 'reset' as const });

const isRebuild = (value: unknown): value is { readonly kind: 'rebuild' } =>
  value !== null &&
  typeof value === 'object' &&
  (value as { readonly kind?: unknown }).kind === 'rebuild';

const collectionChange = (source: unknown): CollectionChange<string, unknown> | undefined => {
  if (!source || typeof source !== 'object' || !('kind' in source)) return undefined;
  if (source.kind !== 'collection') return undefined;
  return (source as { readonly change?: CollectionChange<string, unknown> }).change;
};

const sourceCause = (sources: Record<string, unknown>): unknown => {
  for (const source of Object.values(sources)) {
    if (source && typeof source === 'object' && 'kind' in source) {
      const cause = (source as { readonly cause?: unknown }).cause;
      if (cause !== undefined) return cause;
    }
  }
  return undefined;
};

const collectionView = <K extends string, V>(read: CollectionRead<K, V>): ReadonlyMap<K, V> => {
  const entries = function* (): IterableIterator<[K, V]> {
    for (const key of read.ids()) yield [key, read.get(key) as V];
  };
  const values = function* (): IterableIterator<V> {
    for (const key of read.ids()) yield read.get(key) as V;
  };
  const view: ReadonlyMap<K, V> = {
    get: key => read.get(key),
    has: key => read.has(key),
    get size() {
      return read.ids().length;
    },
    keys: () => read.ids()[Symbol.iterator](),
    values,
    entries,
    forEach: (callback, thisArg) => {
      for (const key of read.ids()) callback.call(thisArg, read.get(key) as V, key, view);
    },
    [Symbol.iterator]: entries,
  };
  return Object.freeze(view);
};

const publicSource = (source: unknown): unknown => {
  if (!source || typeof source !== 'object') return source;
  if (!('kind' in source)) return source;
  if (source.kind === 'value') return (source as unknown as { readonly value: unknown }).value;
  if (source.kind === 'document')
    return snapshot((source as unknown as { readonly read: unknown }).read as never);
  if (source.kind === 'collection') {
    const read = (source as unknown as { readonly read: CollectionRead<string, unknown> }).read;
    return collectionView(read);
  }
  return source;
};

const publicInputs = (
  sources: Record<string, unknown>,
  initial = false
): { readonly values: readonly unknown[]; readonly changes: readonly unknown[] } => {
  const values: unknown[] = [];
  const changes: unknown[] = [];
  for (const key of Object.keys(sources).sort(
    (left, right) => Number(left.slice(1)) - Number(right.slice(1))
  )) {
    const source = sources[key];
    values.push(publicSource(source));
    changes.push(
      initial &&
        source &&
        typeof source === 'object' &&
        'kind' in source &&
        source.kind === 'collection'
        ? resetCollectionChange
        : collectionChange(source)
    );
  }
  return { values, changes };
};

function createIncrementalValue<const D extends readonly Projection<unknown, unknown>[], T>(
  dependencies: D,
  processor: IncrementalValueProcessor<D, T>
): Projection<T> {
  const dependencyMap = dependenciesOf(dependencies);
  let state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let current!: T;
  const build = (sources: Record<string, unknown>) => {
    state = Object.create(null) as Record<string, unknown>;
    const publicInputsForBuild = publicInputs(sources, true);
    const result = processor({
      sources: publicInputsForBuild.values as ProjectionValues<D>,
      changes: publicInputsForBuild.changes as ProjectionChanges<D>,
      previous: undefined,
      reset: true,
      cause: sourceCause(sources),
      state,
    });
    if (isRebuild(result)) throw new TypeError('Initial incremental processor cannot rebuild.');
    current = result as T;
    return {
      value: current,
      update: (nextSources: Record<string, unknown>) => {
        const publicInputsForUpdate = publicInputs(nextSources);
        const next = processor({
          sources: publicInputsForUpdate.values as ProjectionValues<D>,
          changes: publicInputsForUpdate.changes as ProjectionChanges<D>,
          previous: current,
          reset: false,
          cause: sourceCause(nextSources),
          state,
        });
        if (isRebuild(next)) return next;
        current = next as T;
        return { kind: 'changed', value: current } as const;
      },
    };
  };
  return defineIncrementalValue({ dependencies: dependencyMap, build: build as never });
}

function dependenciesOf<D extends readonly Projection<unknown, unknown>[]>(
  dependencies: D
): GraphSources {
  return Object.fromEntries(
    dependencies.map((dependency, index) => [`d${index}`, dependency])
  ) as unknown as GraphSources;
}

function createIncrementalCollection<
  const D extends readonly Projection<unknown, unknown>[],
  K extends string,
  V,
>(
  dependencies: D,
  processor: IncrementalCollectionProcessor<D, K, V>
): Projection<ReadonlyMap<K, V>, CollectionChange<K, V>> {
  const dependencyMap = dependenciesOf(dependencies);
  let state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const build = (input: {
    readonly sources: Record<string, unknown>;
    readonly previous: CollectionRead<K, V>;
    readonly next: CollectionRead<K, V>;
    readonly output: CollectionDraft<K, V>;
  }) => {
    state = Object.create(null) as Record<string, unknown>;
    const publicInputsForBuild = publicInputs(input.sources, true);
    const result = processor({
      sources: publicInputsForBuild.values as ProjectionValues<D>,
      changes: publicInputsForBuild.changes as ProjectionChanges<D>,
      previous: input.previous,
      next: input.next,
      reset: true,
      cause: sourceCause(input.sources),
      state,
      output: input.output,
    });
    if (result?.kind === 'rebuild')
      throw new TypeError('Initial incremental collection processor cannot rebuild.');
    return {
      update: (nextInput: typeof input) => {
        const publicInputsForUpdate = publicInputs(nextInput.sources);
        return processor({
          sources: publicInputsForUpdate.values as ProjectionValues<D>,
          changes: publicInputsForUpdate.changes as ProjectionChanges<D>,
          previous: nextInput.previous,
          next: nextInput.next,
          reset: false,
          cause: sourceCause(nextInput.sources),
          state,
          output: nextInput.output,
        });
      },
    };
  };
  return defineIncrementalCollection({ dependencies: dependencyMap, build: build as never });
}

export const incremental = Object.assign(createIncrementalValue, {
  collection: createIncrementalCollection,
});

export type IncrementalDependencies<D extends readonly Projection<unknown, unknown>[]> =
  DependencyMap<D>;

export type { CollectionChange } from './contract';
