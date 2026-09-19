import { collectionView } from './collection/view';
import type { CollectionChange, CollectionDraft, CollectionRead, SourceContext } from './contract';
import type {
  CollectionOutputEvaluation,
  OutputDefinition,
  OutputEvaluation,
  Projection,
  Rebuild,
} from './definition';
import { defineProcessor, projectionRef } from './definition';
import { assertSynchronous } from './graph/scheduler';
import { isPlainObject } from '../value/record';

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
) => T | Rebuild;

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
> = (context: IncrementalCollectionContext<D, K, V>) => void | Rebuild;

declare const groupOutput: unique symbol;

type GroupCollectionOutput<K extends string, V> = {
  readonly [groupOutput]: { readonly kind: 'collection'; readonly key: K; readonly value: V };
};

type GroupValueOutput<T> = {
  readonly [groupOutput]: { readonly kind: 'value'; readonly value: T };
};

type GroupOutputShape = {
  readonly [name: string]:
    GroupCollectionOutput<string, unknown> | GroupValueOutput<unknown> | GroupOutputShape;
};

export type IncrementalGroupOutputTree = GroupOutputShape;

type GroupOutputBuilder = {
  collection<K extends string, V>(
    equality?: (previous: V, next: V) => boolean
  ): GroupCollectionOutput<K, V>;
  value<T>(equality?: (previous: T, next: T) => boolean): GroupValueOutput<T>;
};

export type IncrementalGroupDefine = GroupOutputBuilder;

export type GroupProjections<O> =
  O extends GroupCollectionOutput<infer K, infer V>
    ? Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>
    : O extends GroupValueOutput<infer T>
      ? Projection<T>
      : { readonly [P in keyof O]: GroupProjections<O[P]> };

type GroupReads<O> =
  O extends GroupCollectionOutput<infer K, infer V>
    ? CollectionRead<K, V>
    : O extends GroupValueOutput<infer T>
      ? T | undefined
      : { readonly [P in keyof O]: GroupReads<O[P]> };

type GroupDrafts<O> =
  O extends GroupCollectionOutput<infer K, infer V>
    ? CollectionDraft<K, V>
    : O extends GroupValueOutput<infer T>
      ? { set(value: T): void }
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
> = (context: IncrementalGroupContext<D, O>) => void | Rebuild;

const resetCollectionChange = Object.freeze({ kind: 'reset' as const });

const isRebuild = (value: unknown): value is Rebuild =>
  value !== null &&
  typeof value === 'object' &&
  (value as { readonly kind?: unknown }).kind === 'rebuild';

const publicValue = (source: SourceContext): unknown =>
  source.kind === 'value' ? source.value : collectionView(source.read);

const publicInputs = (
  sources: readonly SourceContext[],
  reset: boolean
): { readonly values: readonly unknown[]; readonly changes: readonly unknown[] } => ({
  values: Object.freeze(sources.map(publicValue)),
  changes: Object.freeze(
    sources.map(source =>
      source.kind === 'collection' ? (reset ? resetCollectionChange : source.change) : undefined
    )
  ),
});

const validateDependencies = (dependencies: readonly Projection<unknown, unknown>[]) => {
  if (!Array.isArray(dependencies))
    throw new TypeError('Incremental dependencies must be projections.');
  dependencies.forEach(projectionRef);
};

function createIncrementalValue<const D extends readonly Projection<unknown, unknown>[], T>(
  dependencies: D,
  processor: IncrementalValueProcessor<D, T>
): Projection<T> {
  validateDependencies(dependencies);
  const [projection] = defineProcessor({
    dependencies,
    outputs: [{ kind: 'value', equality: Object.is }],
    create: () => {
      const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      return {
        evaluate: evaluation => {
          const output = evaluation.outputs[0];
          if (output.kind !== 'value') throw new Error('Incremental value output is invalid.');
          const publicInput = publicInputs(evaluation.sources, evaluation.reset);
          const result = processor({
            sources: publicInput.values as ProjectionValues<D>,
            changes: publicInput.changes as ProjectionChanges<D>,
            previous: output.previous as T | undefined,
            reset: evaluation.reset,
            cause: evaluation.cause,
            state,
          });
          assertSynchronous(result);
          if (isRebuild(result)) return result;
          output.output.set(result as T);
        },
      };
    },
  });
  return projection as Projection<T>;
}

function createIncrementalCollection<
  const D extends readonly Projection<unknown, unknown>[],
  K extends string,
  V,
>(
  dependencies: D,
  processor: IncrementalCollectionProcessor<D, K, V>
): Projection<ReadonlyMap<K, V>, CollectionChange<K, V>> {
  validateDependencies(dependencies);
  const [projection] = defineProcessor({
    dependencies,
    outputs: [{ kind: 'collection', equality: Object.is }],
    create: () => {
      const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      return {
        evaluate: evaluation => {
          const output = evaluation.outputs[0];
          if (output.kind !== 'collection')
            throw new Error('Incremental collection output is invalid.');
          const publicInput = publicInputs(evaluation.sources, evaluation.reset);
          const result = processor({
            sources: publicInput.values as ProjectionValues<D>,
            changes: publicInput.changes as ProjectionChanges<D>,
            previous: output.previous as CollectionRead<K, V>,
            next: output.next as CollectionRead<K, V>,
            reset: evaluation.reset,
            cause: evaluation.cause,
            state,
            output: output.output as CollectionDraft<K, V>,
          });
          assertSynchronous(result);
          return isRebuild(result) ? result : undefined;
        },
      };
    },
  });
  return projection as Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>;
}

type GroupShape = number | { readonly [key: string]: GroupShape };
type GroupOutputMetadata = {
  readonly kind: OutputDefinition['kind'];
  readonly equality: (a: unknown, b: unknown) => boolean;
};

const isPlainGroupNamespace = (
  value: unknown,
  metadata: ReadonlyMap<object, GroupOutputMetadata>
): value is Record<string, unknown> => isPlainObject(value) && !metadata.has(value);

const compileGroupShape = (
  value: unknown,
  path: readonly string[],
  metadata: ReadonlyMap<object, GroupOutputMetadata>,
  used: Set<object>,
  outputs: OutputDefinition[]
): GroupShape => {
  if (value !== null && typeof value === 'object') {
    const output = metadata.get(value);
    if (output) {
      if (used.has(value)) throw new TypeError('An incremental group output cannot be reused.');
      used.add(value);
      const index = outputs.length;
      outputs.push({
        kind: output.kind,
        equality: output.equality,
        path: Object.freeze([...path]),
      });
      return index;
    }
  }
  if (!isPlainGroupNamespace(value, metadata))
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
    result[key] = compileGroupShape(descriptor.value, [...path, key], metadata, used, outputs);
  }
  return Object.freeze(result);
};

const hydrateGroupShape = <T>(shape: GroupShape, values: readonly T[]): unknown => {
  if (typeof shape === 'number') return values[shape];
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) result[key] = hydrateGroupShape(child, values);
  return Object.freeze(result);
};

const hydrateGroupReads = (
  shape: GroupShape,
  outputs: readonly OutputEvaluation[],
  next: boolean
): unknown => {
  if (typeof shape === 'number') {
    const output = outputs[shape];
    return next && output.kind === 'value' ? output.next() : next ? output.next : output.previous;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    if (typeof child === 'number' && next && outputs[child].kind === 'value') {
      Object.defineProperty(result, key, {
        enumerable: true,
        configurable: false,
        get: () => (outputs[child] as Extract<OutputEvaluation, { kind: 'value' }>).next(),
      });
    } else result[key] = hydrateGroupReads(child, outputs, next);
  }
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
  validateDependencies(dependencies);
  if (typeof defineOutputs !== 'function')
    throw new TypeError('Incremental group outputs must be declared by a callback.');
  if (typeof processor !== 'function')
    throw new TypeError('Incremental group processor must be a function.');

  let active = true;
  const metadata = new Map<object, GroupOutputMetadata>();
  const defineOutput: GroupOutputBuilder = {
    collection: <K extends string, V>(equality: (previous: V, next: V) => boolean = Object.is) => {
      if (!active) throw new TypeError('Incremental group output declarations are synchronous.');
      const descriptor = Object.freeze({});
      metadata.set(descriptor, {
        kind: 'collection',
        equality: equality as (a: unknown, b: unknown) => boolean,
      });
      return descriptor as GroupCollectionOutput<K, V>;
    },
    value: <T>(equality: (previous: T, next: T) => boolean = Object.is) => {
      if (!active) throw new TypeError('Incremental group output declarations are synchronous.');
      const descriptor = Object.freeze({});
      metadata.set(descriptor, {
        kind: 'value',
        equality: equality as (a: unknown, b: unknown) => boolean,
      });
      return descriptor as GroupValueOutput<T>;
    },
  };
  const declared = defineOutputs(defineOutput);
  assertSynchronous(declared);
  active = false;
  const outputs: OutputDefinition[] = [];
  const used = new Set<object>();
  const shape = compileGroupShape(declared, [], metadata, used, outputs);
  if (typeof shape === 'number')
    throw new TypeError('Incremental group declarations must return an output namespace.');
  if (used.size === 0 || used.size !== metadata.size)
    throw new TypeError('Every incremental group output must be returned by the declaration.');

  const projections = defineProcessor({
    dependencies,
    outputs,
    create: () => {
      const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      return {
        evaluate: evaluation => {
          const publicInput = publicInputs(evaluation.sources, evaluation.reset);
          const result = processor({
            sources: publicInput.values as ProjectionValues<D>,
            changes: publicInput.changes as ProjectionChanges<D>,
            previous: hydrateGroupReads(shape, evaluation.outputs, false) as GroupReads<O>,
            next: hydrateGroupReads(shape, evaluation.outputs, true) as GroupReads<O>,
            outputs: hydrateGroupShape(
              shape,
              evaluation.outputs.map(output => output.output)
            ) as GroupDrafts<O>,
            reset: evaluation.reset,
            cause: evaluation.cause,
            state,
          });
          assertSynchronous(result);
          return isRebuild(result) ? result : undefined;
        },
      };
    },
    name: `processor-group:${outputs.map(output => output.path?.join('.') ?? '').join(',')}`,
  });
  return hydrateGroupShape(shape, projections) as GroupProjections<O>;
}

export const incremental = Object.assign(createIncrementalValue, {
  collection: createIncrementalCollection,
  group: createIncrementalGroup,
});

export type { CollectionChange } from './contract';
