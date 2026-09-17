import type { Projection } from './definition';
import {
  defineIncrementalCollection,
  defineIncrementalGroup,
  defineIncrementalValue,
  definitionOf,
} from './definition';
import type { CollectionChange, CollectionDraft, CollectionRead, GraphSources } from './contract';
import { snapshot } from '../access/scope';
import { assertSynchronous } from './scheduler';

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

declare const groupOutput: unique symbol;

type GroupOutput<K extends string, V> = {
  readonly [groupOutput]: { readonly key: K; readonly value: V };
};

type GroupOutputShape = {
  readonly [name: string]: GroupOutput<string, unknown> | GroupOutputShape;
};

export type IncrementalGroupOutputTree = GroupOutputShape;

type GroupOutputBuilder = {
  collection<K extends string, V>(equality?: (previous: V, next: V) => boolean): GroupOutput<K, V>;
};

export type IncrementalGroupDefine = GroupOutputBuilder;

export type GroupProjections<O> =
  O extends GroupOutput<infer K, infer V>
    ? Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>
    : { readonly [P in keyof O]: GroupProjections<O[P]> };

type GroupReads<O> =
  O extends GroupOutput<infer K, infer V>
    ? CollectionRead<K, V>
    : { readonly [P in keyof O]: GroupReads<O[P]> };

type GroupDrafts<O> =
  O extends GroupOutput<infer K, infer V>
    ? CollectionDraft<K, V>
    : { readonly [P in keyof O]: GroupDrafts<O[P]> };

export type IncrementalGroupContext<
  D extends readonly Projection<unknown, unknown>[],
  O extends GroupOutputShape,
> = {
  readonly sources: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: GroupReads<O>;
  readonly next: GroupReads<O>;
  readonly outputs: GroupDrafts<O>;
  readonly reset: boolean;
  readonly cause: unknown;
  readonly state: Record<string, unknown>;
};

export type IncrementalGroupProcessor<
  D extends readonly Projection<unknown, unknown>[],
  O extends GroupOutputShape,
> = (context: IncrementalGroupContext<D, O>) => void | { readonly kind: 'rebuild' };

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
  const build = (sources: Record<string, unknown>) => {
    const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let current!: T;
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
  if (!Array.isArray(dependencies))
    throw new TypeError('Incremental dependencies must be projections.');
  dependencies.forEach(dependency => definitionOf(dependency));
  return Object.freeze(
    Object.fromEntries(dependencies.map((dependency, index) => [`d${index}`, dependency]))
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
  const build = (input: {
    readonly sources: Record<string, unknown>;
    readonly previous: CollectionRead<K, V>;
    readonly next: CollectionRead<K, V>;
    readonly output: CollectionDraft<K, V>;
  }) => {
    const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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

type GroupShape = number | { readonly [key: string]: GroupShape };
const groupOutputMetadata = new WeakMap<
  object,
  { readonly isEqual?: (a: unknown, b: unknown) => boolean }
>();

const isPlainGroupNamespace = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !groupOutputMetadata.has(value) &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const compileGroupShape = (
  value: unknown,
  path: readonly string[],
  declaredOutputs: ReadonlySet<object>,
  used: Set<object>,
  outputs: {
    readonly path: readonly string[];
    readonly isEqual?: (a: unknown, b: unknown) => boolean;
  }[]
): GroupShape => {
  if (value !== null && typeof value === 'object') {
    const metadata = groupOutputMetadata.get(value);
    if (metadata) {
      if (!declaredOutputs.has(value))
        throw new TypeError('Incremental group outputs must be declared by this group.');
      if (used.has(value)) throw new TypeError('An incremental group output cannot be reused.');
      used.add(value);
      const index = outputs.length;
      outputs.push({ path: Object.freeze([...path]), isEqual: metadata.isEqual });
      return index;
    }
  }
  if (!isPlainGroupNamespace(value))
    throw new TypeError('Incremental group outputs must be a static object tree.');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      throw new TypeError('Incremental group output names must be strings.');
    if (!Object.prototype.propertyIsEnumerable.call(value, key))
      throw new TypeError('Incremental group namespaces must contain enumerable properties.');
  }
  const keys = Object.keys(value);
  if (!keys.length) throw new TypeError('Incremental group namespaces cannot be empty.');
  const result: Record<string, GroupShape> = Object.create(null) as Record<string, GroupShape>;
  for (const key of keys) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor')
      throw new TypeError(`Invalid incremental group output name: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      throw new TypeError('Incremental group namespaces cannot contain accessors.');
    result[key] = compileGroupShape(
      descriptor.value,
      [...path, key],
      declaredOutputs,
      used,
      outputs
    );
  }
  return Object.freeze(result);
};

const hydrateGroupShape = <T>(shape: GroupShape, values: readonly T[]): unknown => {
  if (typeof shape === 'number') return values[shape];
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) result[key] = hydrateGroupShape(child, values);
  return Object.freeze(result);
};

function createIncrementalGroup<
  const D extends readonly Projection<unknown, unknown>[],
  const O extends GroupOutputShape,
>(
  dependencies: D,
  defineOutputs: (define: GroupOutputBuilder) => O,
  processor: IncrementalGroupProcessor<D, O>
): GroupProjections<O> {
  const dependencyMap = dependenciesOf(dependencies);
  if (typeof defineOutputs !== 'function')
    throw new TypeError('Incremental group outputs must be declared by a callback.');
  if (typeof processor !== 'function')
    throw new TypeError('Incremental group processor must be a function.');
  let active = true;
  const declaredOutputs = new Set<object>();
  const defineOutput: GroupOutputBuilder = {
    collection: <K extends string, V>(equality?: (previous: V, next: V) => boolean) => {
      if (!active) throw new TypeError('Incremental group output declarations are synchronous.');
      const descriptor = Object.freeze({});
      groupOutputMetadata.set(descriptor, {
        isEqual: equality as ((a: unknown, b: unknown) => boolean) | undefined,
      });
      declaredOutputs.add(descriptor);
      return descriptor as GroupOutput<K, V>;
    },
  };
  const declared = defineOutputs(defineOutput);
  assertSynchronous(declared);
  active = false;
  const outputs: {
    readonly path: readonly string[];
    readonly isEqual?: (a: unknown, b: unknown) => boolean;
  }[] = [];
  const used = new Set<object>();
  const shape = compileGroupShape(declared, [], declaredOutputs, used, outputs);
  if (typeof shape === 'number')
    throw new TypeError('Incremental group declarations must return an output namespace.');
  if (used.size === 0 || used.size !== declaredOutputs.size)
    throw new TypeError('Every incremental group output must be returned by the declaration.');
  const stateFactory = () => Object.create(null) as Record<string, unknown>;
  const build = (input: {
    readonly sources: Record<string, unknown>;
    readonly previous: readonly CollectionRead<string, unknown>[];
    readonly next: readonly CollectionRead<string, unknown>[];
    readonly outputs: readonly CollectionDraft<string, unknown>[];
  }) => {
    const state = stateFactory();
    const run = (nextInput: typeof input, reset: boolean) => {
      const publicInput = publicInputs(nextInput.sources, reset);
      const result = processor({
        sources: publicInput.values as ProjectionValues<D>,
        changes: publicInput.changes as ProjectionChanges<D>,
        previous: hydrateGroupShape(shape, nextInput.previous) as GroupReads<O>,
        next: hydrateGroupShape(shape, nextInput.next) as GroupReads<O>,
        outputs: hydrateGroupShape(shape, nextInput.outputs) as GroupDrafts<O>,
        reset,
        cause: sourceCause(nextInput.sources),
        state,
      });
      assertSynchronous(result);
      return result;
    };
    const result = run(input, true);
    if (isRebuild(result))
      throw new TypeError('Initial incremental group processor cannot rebuild.');
    return {
      update: (nextInput: typeof input) => {
        const result = run(nextInput, false);
        return isRebuild(result) ? result : undefined;
      },
    };
  };
  const group = defineIncrementalGroup({
    dependencies: dependencyMap,
    outputs,
    build: build as never,
  });
  const materialized = hydrateGroupShape(shape, group.projections) as GroupProjections<O>;
  return materialized;
}

export const incremental = Object.assign(createIncrementalValue, {
  collection: createIncrementalCollection,
  group: createIncrementalGroup,
});

export type IncrementalDependencies<D extends readonly Projection<unknown, unknown>[]> =
  DependencyMap<D>;

export type { CollectionChange } from './contract';
