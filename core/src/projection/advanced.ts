import { collectionView } from './collection/view';
import type { CollectionChange, CollectionDraft, CollectionRead, SourceContext } from './contract';
import type {
  KeyedProjection,
  OutputDefinition,
  OutputEvaluation,
  Projection,
  ProjectionChange,
} from './definition';
import { defineProcessor } from './definition';
import { compileProjectionDependencies } from './dependency';
import { assertSynchronous } from './graph/scheduler';
import { isPlainObject } from '../value/record';

type ProjectionDependencies = Readonly<Record<string, Projection<unknown>>>;

type ProjectionValues<D extends ProjectionDependencies> = {
  readonly [K in keyof D]: D[K] extends Projection<infer T> ? T : never;
};

type ProjectionChanges<D extends ProjectionDependencies> = {
  readonly [K in keyof D]: ProjectionChange<D[K]> extends undefined
    ? undefined
    : ProjectionChange<D[K]> | undefined;
};

type RetainedStateContext<State> = [State] extends [never] ? {} : { readonly state: State };
type RetainedStateDefinition<State> = [State] extends [never]
  ? { readonly state?: never }
  : { readonly state: () => State };

export type IncrementalValueContext<D extends ProjectionDependencies, T, State = never> = {
  readonly values: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: T | undefined;
  readonly reset: boolean;
  readonly cause: unknown;
} & RetainedStateContext<State>;

export type IncrementalValueDefinition<D extends ProjectionDependencies, T, State = never> = {
  readonly process: (context: IncrementalValueContext<D, T, State>) => T;
} & RetainedStateDefinition<State>;

export type IncrementalCollectionContext<
  D extends ProjectionDependencies,
  K extends string,
  V,
  State = never,
> = {
  readonly values: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly reset: boolean;
  readonly cause: unknown;
  readonly output: CollectionDraft<K, V>;
} & RetainedStateContext<State>;

export type IncrementalCollectionDefinition<
  D extends ProjectionDependencies,
  K extends string,
  V,
  State = never,
> = {
  readonly process: (context: IncrementalCollectionContext<D, K, V, State>) => void;
} & RetainedStateDefinition<State>;

declare const groupOutput: unique symbol;

/** Type-only declaration token used by incremental.group output builders. */
export type IncrementalGroupOutput<P extends Projection<unknown>> = {
  readonly [groupOutput]: P;
};

type GroupOutputShape = {
  readonly [name: string]: IncrementalGroupOutput<Projection<unknown>> | GroupOutputShape;
};

type GroupOutputBuilder = {
  collection<K extends string, V>(
    equality?: (previous: V, next: V) => boolean
  ): IncrementalGroupOutput<KeyedProjection<K, V>>;
  value<T>(equality?: (previous: T, next: T) => boolean): IncrementalGroupOutput<Projection<T>>;
};

/** Portable projection tree returned from an incremental.group declaration. */
export type IncrementalGroupResult<O> =
  O extends IncrementalGroupOutput<infer P>
    ? P
    : O extends Readonly<Record<string, unknown>>
      ? { readonly [K in keyof O]: IncrementalGroupResult<O[K]> }
      : never;

type GroupReads<O> =
  O extends IncrementalGroupOutput<infer P>
    ? P extends KeyedProjection<infer K, infer V>
      ? CollectionRead<K, V>
      : P extends Projection<infer T>
        ? T | undefined
        : never
    : { readonly [K in keyof O]: GroupReads<O[K]> };

type GroupDrafts<O> =
  O extends IncrementalGroupOutput<infer P>
    ? P extends KeyedProjection<infer K, infer V>
      ? CollectionDraft<K, V>
      : P extends Projection<infer T>
        ? { set(value: T): void }
        : never
    : { readonly [K in keyof O]: GroupDrafts<O[K]> };

export type IncrementalGroupContext<
  D extends ProjectionDependencies,
  O extends GroupOutputShape,
  State = never,
> = {
  readonly values: ProjectionValues<D>;
  readonly changes: ProjectionChanges<D>;
  readonly previous: GroupReads<O>;
  readonly next: GroupReads<O>;
  readonly output: GroupDrafts<O>;
  readonly reset: boolean;
  readonly cause: unknown;
} & RetainedStateContext<State>;

type IncrementalGroupDefinition<
  D extends ProjectionDependencies,
  O extends GroupOutputShape,
  State = never,
> = {
  readonly output: (define: GroupOutputBuilder) => O;
  readonly process: (context: IncrementalGroupContext<D, O, State>) => void;
} & RetainedStateDefinition<State>;

const resetCollectionChange = Object.freeze({ kind: 'reset' as const });

const publicValue = (source: SourceContext): unknown =>
  source.kind === 'value' ? source.value : collectionView(source.read);

const publicInputs = (
  sources: readonly SourceContext[],
  names: readonly string[],
  reset: boolean
): {
  readonly values: Readonly<Record<string, unknown>>;
  readonly changes: Readonly<Record<string, unknown>>;
} => {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const changes: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < names.length; index++) {
    const source = sources[index];
    values[names[index]] = publicValue(source);
    changes[names[index]] =
      source.kind === 'collection' ? (reset ? resetCollectionChange : source.change) : undefined;
  }
  return Object.freeze({ values: Object.freeze(values), changes: Object.freeze(changes) });
};

function validateDefinition(
  definition: unknown,
  allowed: readonly string[],
  label: string
): asserts definition is Record<string, unknown> {
  if (!isPlainObject(definition))
    throw new TypeError(`${label} definition must be a plain object.`);
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(definition)) {
    if (typeof key !== 'string' || !allowedKeys.has(key))
      throw new TypeError(`${label} definition contains an unknown property.`);
    const descriptor = Object.getOwnPropertyDescriptor(definition, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError(`${label} definition must contain enumerable data properties.`);
  }
}

const validateRetainedState = (definition: Record<string, unknown>, label: string): void => {
  if (
    Object.prototype.hasOwnProperty.call(definition, 'state') &&
    typeof definition.state !== 'function'
  )
    throw new TypeError(`${label} state must be a function when provided.`);
};

const initializeRetainedState = (definition: {
  readonly state?: () => unknown;
}): Readonly<Record<string, unknown>> => {
  if (definition.state === undefined) return Object.freeze({});
  const state = definition.state();
  assertSynchronous(state);
  return Object.freeze({ state });
};

type RuntimeIncrementalDefinition<Result> = {
  readonly state?: () => unknown;
  readonly process: (context: never) => Result;
};

function createIncrementalValue<const D extends ProjectionDependencies, T>(
  dependencies: D,
  definition: IncrementalValueDefinition<D, T>
): Projection<T>;
function createIncrementalValue<const D extends ProjectionDependencies, T, State>(
  dependencies: D,
  definition: {
    readonly state: () => State;
    readonly process: (context: IncrementalValueContext<D, T, State>) => T;
  }
): Projection<T>;
function createIncrementalValue<const D extends ProjectionDependencies, T>(
  dependencies: D,
  definition: RuntimeIncrementalDefinition<T>
): Projection<T> {
  const compiled = compileProjectionDependencies(dependencies, 'Incremental');
  validateDefinition(definition, ['state', 'process'], 'Incremental value');
  validateRetainedState(definition, 'Incremental value');
  if (typeof definition.process !== 'function')
    throw new TypeError('Incremental value definition requires a process function.');
  const [projection] = defineProcessor({
    dependencies: compiled.projections,
    outputs: [{ kind: 'value', equality: Object.is }],
    create: () => {
      const state = initializeRetainedState(definition);
      return {
        evaluate: evaluation => {
          const output = evaluation.outputs[0];
          if (output.kind !== 'value') throw new Error('Incremental value output is invalid.');
          const publicInput = publicInputs(evaluation.sources, compiled.names, evaluation.reset);
          const result = definition.process({
            values: publicInput.values as ProjectionValues<D>,
            changes: publicInput.changes as ProjectionChanges<D>,
            previous: output.previous as T | undefined,
            reset: evaluation.reset,
            cause: evaluation.cause,
            ...state,
          } as never);
          assertSynchronous(result);
          output.output.set(result);
        },
      };
    },
  });
  return projection as Projection<T>;
}

function createIncrementalCollection<const D extends ProjectionDependencies, K extends string, V>(
  dependencies: D,
  definition: IncrementalCollectionDefinition<D, K, V>
): KeyedProjection<K, V>;
function createIncrementalCollection<
  const D extends ProjectionDependencies,
  K extends string,
  V,
  State,
>(
  dependencies: D,
  definition: {
    readonly state: () => State;
    readonly process: (context: IncrementalCollectionContext<D, K, V, State>) => void;
  }
): KeyedProjection<K, V>;
function createIncrementalCollection<const D extends ProjectionDependencies, K extends string, V>(
  dependencies: D,
  definition: RuntimeIncrementalDefinition<void>
): KeyedProjection<K, V> {
  const compiled = compileProjectionDependencies(dependencies, 'Incremental');
  validateDefinition(definition, ['state', 'process'], 'Incremental collection');
  validateRetainedState(definition, 'Incremental collection');
  if (typeof definition.process !== 'function')
    throw new TypeError('Incremental collection definition requires a process function.');
  const [projection] = defineProcessor({
    dependencies: compiled.projections,
    outputs: [{ kind: 'collection', equality: Object.is }],
    create: () => {
      const state = initializeRetainedState(definition);
      return {
        evaluate: evaluation => {
          const output = evaluation.outputs[0];
          if (output.kind !== 'collection')
            throw new Error('Incremental collection output is invalid.');
          const publicInput = publicInputs(evaluation.sources, compiled.names, evaluation.reset);
          const result = definition.process({
            values: publicInput.values as ProjectionValues<D>,
            changes: publicInput.changes as ProjectionChanges<D>,
            previous: output.previous as CollectionRead<K, V>,
            next: output.next as CollectionRead<K, V>,
            reset: evaluation.reset,
            cause: evaluation.cause,
            output: output.output as CollectionDraft<K, V>,
            ...state,
          } as never);
          assertSynchronous(result);
        },
      };
    },
  });
  return projection as KeyedProjection<K, V>;
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
  const D extends ProjectionDependencies,
  const O extends GroupOutputShape,
>(dependencies: D, definition: IncrementalGroupDefinition<D, O>): IncrementalGroupResult<O>;
function createIncrementalGroup<
  const D extends ProjectionDependencies,
  const O extends GroupOutputShape,
  State,
>(
  dependencies: D,
  definition: {
    readonly output: (define: GroupOutputBuilder) => O;
    readonly state: () => State;
    readonly process: (context: IncrementalGroupContext<D, O, State>) => void;
  }
): IncrementalGroupResult<O>;
function createIncrementalGroup<
  const D extends ProjectionDependencies,
  const O extends GroupOutputShape,
>(
  dependencies: D,
  definition: RuntimeIncrementalDefinition<void> & {
    readonly output: (define: GroupOutputBuilder) => O;
  }
): IncrementalGroupResult<O> {
  const compiled = compileProjectionDependencies(dependencies, 'Incremental');
  validateDefinition(definition, ['output', 'state', 'process'], 'Incremental group');
  validateRetainedState(definition, 'Incremental group');
  if (typeof definition.output !== 'function' || typeof definition.process !== 'function')
    throw new TypeError('Incremental group definition requires output and process functions.');

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
      return descriptor as IncrementalGroupOutput<KeyedProjection<K, V>>;
    },
    value: <T>(equality: (previous: T, next: T) => boolean = Object.is) => {
      if (!active) throw new TypeError('Incremental group output declarations are synchronous.');
      const descriptor = Object.freeze({});
      metadata.set(descriptor, {
        kind: 'value',
        equality: equality as (a: unknown, b: unknown) => boolean,
      });
      return descriptor as IncrementalGroupOutput<Projection<T>>;
    },
  };
  const declared = definition.output(defineOutput);
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
    dependencies: compiled.projections,
    outputs,
    create: () => {
      const state = initializeRetainedState(definition);
      return {
        evaluate: evaluation => {
          const publicInput = publicInputs(evaluation.sources, compiled.names, evaluation.reset);
          const result = definition.process({
            values: publicInput.values as ProjectionValues<D>,
            changes: publicInput.changes as ProjectionChanges<D>,
            previous: hydrateGroupReads(shape, evaluation.outputs, false) as GroupReads<O>,
            next: hydrateGroupReads(shape, evaluation.outputs, true) as GroupReads<O>,
            output: hydrateGroupShape(
              shape,
              evaluation.outputs.map(output => output.output)
            ) as GroupDrafts<O>,
            reset: evaluation.reset,
            cause: evaluation.cause,
            ...state,
          } as never);
          assertSynchronous(result);
        },
      };
    },
    name: `processor-group:${outputs.map(output => output.path?.join('.') ?? '').join(',')}`,
  });
  return hydrateGroupShape(shape, projections) as IncrementalGroupResult<O>;
}

export const incremental = Object.assign(createIncrementalValue, {
  collection: createIncrementalCollection,
  group: createIncrementalGroup,
});

export { collectionChange } from './collection/change';
export type { CollectionChange } from './contract';
