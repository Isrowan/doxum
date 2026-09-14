import type { Projection, ProjectionValues, PublicCollection } from './definition';
import { defineIncrementalCollection, defineIncrementalValue } from './definition';
import type { CollectionDraft, CollectionRead, GraphSources } from './contract';
import { snapshot } from '../access/scope';

export type IncrementalState = Record<string, unknown>;

export type IncrementalValueContext<S, T> = {
  readonly sources: S;
  readonly previous: T | undefined;
  readonly reset: boolean;
  readonly change: unknown;
  readonly cause: unknown;
  readonly state: IncrementalState;
};

export type IncrementalValueProcessor<S, T> = (
  context: IncrementalValueContext<S, T>
) =>
  | T
  | { readonly kind: 'value'; readonly value: T; readonly state?: IncrementalState }
  | { readonly kind: 'rebuild' };

export type IncrementalCollectionContext<S, K extends string, V> = {
  readonly sources: S;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly change: unknown;
  readonly reset: boolean;
  readonly cause: unknown;
  readonly state: IncrementalState;
  readonly output: CollectionDraft<K, V>;
};

export type IncrementalCollectionProcessor<S, K extends string, V> = (
  context: IncrementalCollectionContext<S, K, V>
) => void | { readonly kind: 'rebuild' };

type DependencyMap<D extends readonly Projection<unknown>[]> = {
  readonly [K in keyof D as `d${Extract<K, number>}`]: D[K];
};

const dependenciesOf = <D extends readonly Projection<unknown>[]>(dependencies: D): GraphSources =>
  Object.fromEntries(
    dependencies.map((dependency, index) => [`d${index}`, dependency])
  ) as unknown as GraphSources;

const sourceChange = (sources: Record<string, unknown>): unknown => {
  for (const source of Object.values(sources)) {
    if (
      source &&
      typeof source === 'object' &&
      'change' in source &&
      (source as { readonly change?: unknown }).change !== undefined
    )
      return (source as { readonly change?: unknown }).change;
  }
  return undefined;
};

const sourceCause = (sources: Record<string, unknown>): unknown => {
  for (const source of Object.values(sources)) {
    if (
      source &&
      typeof source === 'object' &&
      'cause' in source &&
      (source as { readonly cause?: unknown }).cause !== undefined
    )
      return (source as { readonly cause?: unknown }).cause;
  }
  return undefined;
};

const publicSource = (source: unknown): unknown => {
  if (!source || typeof source !== 'object') return source;
  if ('value' in source) return (source as { readonly value: unknown }).value;
  if ('read' in source) {
    const read = (source as { readonly read: unknown }).read;
    if (
      read &&
      typeof read === 'object' &&
      'ids' in read &&
      typeof (read as { ids?: unknown }).ids === 'function'
    ) {
      const result = new Map<string, unknown>();
      for (const id of (read as CollectionRead<string, unknown>).ids())
        result.set(id, (read as CollectionRead<string, unknown>).get(id));
      return result;
    }
    return snapshot(read);
  }
  if ('ids' in source && typeof (source as { ids?: unknown }).ids === 'function') {
    const result = new Map<string, unknown>();
    const read = source as CollectionRead<string, unknown>;
    for (const id of read.ids()) result.set(id, read.get(id));
    return result;
  }
  return source;
};

const publicTuple = (sources: Record<string, unknown>): readonly unknown[] =>
  Object.keys(sources)
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
    .map(key => publicSource(sources[key]));

const normalizeValue = <T>(
  result: T | { readonly kind: 'value'; readonly value: T; readonly state?: IncrementalState }
): { value: T; state?: IncrementalState } =>
  result && typeof result === 'object' && (result as { readonly kind?: unknown }).kind === 'value'
    ? {
        value: (result as { readonly value: T }).value,
        state: (result as { readonly state?: IncrementalState }).state,
      }
    : { value: result as T };

function createIncrementalValue<const D extends readonly Projection<unknown>[], T>(
  dependencies: D,
  processor: IncrementalValueProcessor<ProjectionValues<D>, T>
): Projection<T> {
  const dependencyMap = dependenciesOf(dependencies);
  let state: IncrementalState = Object.create(null) as IncrementalState;
  let current!: T;
  const build = (sources: Record<string, unknown>) => {
    state = Object.create(null) as IncrementalState;
    const result = processor({
      sources: publicTuple(sources) as ProjectionValues<D>,
      previous: undefined,
      reset: true,
      change: undefined,
      cause: sourceCause(sources),
      state,
    });
    if (result && typeof result === 'object' && 'kind' in result)
      throw new TypeError('Initial incremental processor cannot rebuild.');
    const normalized = normalizeValue(result as T);
    current = normalized.value;
    if (normalized.state) state = normalized.state;
    return {
      value: current,
      update: (nextSources: Record<string, unknown>) => {
        const next = processor({
          sources: publicTuple(nextSources) as ProjectionValues<D>,
          previous: current,
          reset: false,
          change: sourceChange(nextSources),
          cause: sourceCause(nextSources),
          state,
        });
        if (next && typeof next === 'object' && 'kind' in next) return next;
        const nextValue = normalizeValue(next as T);
        current = nextValue.value;
        if (nextValue.state) state = nextValue.state;
        return { kind: 'changed', value: current } as const;
      },
    };
  };
  return defineIncrementalValue({ dependencies: dependencyMap, build: build as never });
}

function createIncrementalCollection<
  const D extends readonly Projection<unknown>[],
  K extends string,
  V,
>(
  dependencies: D,
  processor: IncrementalCollectionProcessor<ProjectionValues<D>, K, V>
): Projection<PublicCollection<K, V>> {
  const dependencyMap = dependenciesOf(dependencies);
  let state: IncrementalState = Object.create(null) as IncrementalState;
  const build = (input: {
    readonly sources: Record<string, unknown>;
    readonly previous: CollectionRead<K, V>;
    readonly next: CollectionRead<K, V>;
    readonly writer: CollectionDraft<K, V>;
  }) => {
    state = Object.create(null) as IncrementalState;
    const result = processor({
      sources: publicTuple(input.sources) as ProjectionValues<D>,
      previous: input.previous,
      next: input.next,
      reset: true,
      change: undefined,
      cause: sourceCause(input.sources),
      state,
      output: input.writer,
    });
    if (result?.kind === 'rebuild')
      throw new TypeError('Initial incremental collection processor cannot rebuild.');
    return {
      update: (nextInput: typeof input) =>
        processor({
          sources: publicTuple(nextInput.sources) as ProjectionValues<D>,
          previous: nextInput.previous,
          next: nextInput.next,
          reset: false,
          change: sourceChange(nextInput.sources),
          cause: sourceCause(nextInput.sources),
          state,
          output: nextInput.writer,
        }),
    };
  };
  return defineIncrementalCollection({ dependencies: dependencyMap, build: build as never });
}

export const incremental = Object.assign(createIncrementalValue, {
  collection: createIncrementalCollection,
});

export type IncrementalDependencies<D extends readonly Projection<unknown>[]> = DependencyMap<D>;
