import type {
  Projection,
  CollectionProjection,
  ProjectionChanges,
  ProjectionValues,
  PublicCollection,
} from './definition';
import { defineIncrementalCollection, defineIncrementalValue } from './definition';
import type {
  CollectionChange,
  CollectionDraft,
  CollectionEntryTransition,
  CollectionRead,
  GraphSources,
} from './contract';
import { snapshot } from '../access/scope';

export type IncrementalState = Record<string, unknown>;

export type IncrementalValueContext<D extends readonly Projection<unknown, unknown>[], T> = {
  readonly sources: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: T | undefined;
  readonly reset: boolean;
  readonly cause: unknown;
  readonly state: IncrementalState;
};

export type IncrementalValueProcessor<D extends readonly Projection<unknown, unknown>[], T> = (
  context: IncrementalValueContext<D, T>
) =>
  | T
  | { readonly kind: 'value'; readonly value: T; readonly state?: IncrementalState }
  | { readonly kind: 'rebuild' };

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
  readonly state: IncrementalState;
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

const dependenciesOf = <D extends readonly Projection<unknown, unknown>[]>(
  dependencies: D
): GraphSources =>
  Object.fromEntries(
    dependencies.map((dependency, index) => [`d${index}`, dependency])
  ) as unknown as GraphSources;

type RuntimeCollectionSource = {
  readonly ids: () => readonly string[];
  readonly previous: CollectionRead<string, unknown>;
  readonly reset: boolean;
  readonly change?: { readonly kind: 'reset' | 'incremental'; readonly orderChanged?: boolean };
  readonly transitions: () => readonly CollectionEntryTransition<string, unknown>[];
};
const resetCollectionChange = Object.freeze({ kind: 'reset' as const });
type IncrementalCollectionChange = Extract<
  CollectionChange<string, unknown>,
  { readonly kind: 'incremental' }
>;

const isCollectionSource = (source: unknown): source is RuntimeCollectionSource =>
  Boolean(
    source &&
    typeof source === 'object' &&
    'ids' in source &&
    typeof (source as { readonly ids?: unknown }).ids === 'function' &&
    'previous' in source &&
    'transitions' in source &&
    typeof (source as { readonly transitions?: unknown }).transitions === 'function'
  );

const collectionChange = (source: unknown): CollectionChange<string, unknown> | undefined => {
  if (!isCollectionSource(source)) return undefined;
  if (source.reset || source.change?.kind === 'reset') return resetCollectionChange;
  const impact = source.change;
  if (!impact) return undefined;
  const added: IncrementalCollectionChange['added'][number][] = [];
  const updated: IncrementalCollectionChange['updated'][number][] = [];
  const removed: IncrementalCollectionChange['removed'][number][] = [];
  for (const transition of source.transitions()) {
    if (transition.kind === 'added')
      added.push({ key: transition.key, kind: transition.kind, after: transition.after });
    else if (transition.kind === 'updated') updated.push(transition);
    else removed.push({ key: transition.key, kind: transition.kind, before: transition.before });
  }
  const order = impact.orderChanged
    ? {
        before: Object.freeze([...source.previous.ids()]),
        after: Object.freeze([...source.ids()]),
      }
    : undefined;
  if (!added.length && !updated.length && !removed.length && !order) return undefined;
  return Object.freeze({
    kind: 'incremental' as const,
    added: Object.freeze(added),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    ...(order ? { order: Object.freeze(order) } : {}),
  });
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
      initial && isCollectionSource(source) ? resetCollectionChange : collectionChange(source)
    );
  }
  return { values, changes };
};

const normalizeValue = <T>(
  result: T | { readonly kind: 'value'; readonly value: T; readonly state?: IncrementalState }
): { value: T; state?: IncrementalState } =>
  result && typeof result === 'object' && (result as { readonly kind?: unknown }).kind === 'value'
    ? {
        value: (result as { readonly value: T }).value,
        state: (result as { readonly state?: IncrementalState }).state,
      }
    : { value: result as T };

function createIncrementalValue<const D extends readonly Projection<unknown, unknown>[], T>(
  dependencies: D,
  processor: IncrementalValueProcessor<D, T>
): Projection<T> {
  const dependencyMap = dependenciesOf(dependencies);
  let state: IncrementalState = Object.create(null) as IncrementalState;
  let current!: T;
  const build = (sources: Record<string, unknown>) => {
    state = Object.create(null) as IncrementalState;
    const publicInputsForBuild = publicInputs(sources, true);
    const result = processor({
      sources: publicInputsForBuild.values as ProjectionValues<D>,
      changes: publicInputsForBuild.changes as ProjectionChanges<D>,
      previous: undefined,
      reset: true,
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
        const publicInputsForUpdate = publicInputs(nextSources);
        const next = processor({
          sources: publicInputsForUpdate.values as ProjectionValues<D>,
          changes: publicInputsForUpdate.changes as ProjectionChanges<D>,
          previous: current,
          reset: false,
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
  const D extends readonly Projection<unknown, unknown>[],
  K extends string,
  V,
>(dependencies: D, processor: IncrementalCollectionProcessor<D, K, V>): CollectionProjection<K, V> {
  const dependencyMap = dependenciesOf(dependencies);
  let state: IncrementalState = Object.create(null) as IncrementalState;
  const build = (input: {
    readonly sources: Record<string, unknown>;
    readonly previous: CollectionRead<K, V>;
    readonly next: CollectionRead<K, V>;
    readonly writer: CollectionDraft<K, V>;
  }) => {
    state = Object.create(null) as IncrementalState;
    const publicInputsForBuild = publicInputs(input.sources, true);
    const result = processor({
      sources: publicInputsForBuild.values as ProjectionValues<D>,
      changes: publicInputsForBuild.changes as ProjectionChanges<D>,
      previous: input.previous,
      next: input.next,
      reset: true,
      cause: sourceCause(input.sources),
      state,
      output: input.writer,
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
          output: nextInput.writer,
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
