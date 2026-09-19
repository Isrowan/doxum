import { contextOf } from '../runtime/context';
import type { ReadonlyDocument } from '../runtime/contract';
import type {
  CollectionEntry,
  CollectionId,
  CollectionPath,
  CollectionSelector,
  Infer,
  ObjectSchema,
  PathValueOf,
  ReadonlyValue,
  SchemaPath,
  ValueSelector,
} from '../schema';
import { compilePath } from '../schema';
import type {
  CollectionChange,
  CollectionDraft,
  CollectionRead,
  ExternalCollectionSource,
  ExternalValueSource,
  SourceContext,
} from './contract';
import type { Readable } from '../readable';

declare const projectionDefinition: unique symbol;
declare const projectionChanges: unique symbol;
declare const writableInput: unique symbol;
declare const writableCollectionInput: unique symbol;

/** A lazy output reference with no materialized Runtime state. */
export type Projection<T> = {
  readonly [projectionDefinition]: T;
};

/** A writable source projection. */
export type Input<T> = Projection<T> & { readonly [writableInput]: true };

/** A writable keyed collection source projection. */
export type CollectionInput<K extends string, V> = Projection<ReadonlyMap<K, V>> & {
  readonly [writableCollectionInput]: { readonly key: K; readonly value: V };
  readonly [projectionChanges]: CollectionChange<K, V>;
};

export type CollectionInputDraft<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  remove(key: K): void;
};

export type ProjectionWithChange<T, C> = Projection<T> & { readonly [projectionChanges]: C };
export type ProjectionChange<P> = P extends { readonly [projectionChanges]: infer C }
  ? C
  : undefined;

type Equality = (a: unknown, b: unknown) => boolean;
type PathSelector<S extends ObjectSchema<object>> = (path: SchemaPath<S>) => unknown;

export type OutputDefinition =
  | {
      readonly kind: 'value';
      readonly equality: Equality;
      readonly path?: readonly string[];
    }
  | {
      readonly kind: 'collection';
      readonly equality: Equality;
      readonly path?: readonly string[];
    };

export type ValueOutputEvaluation = {
  readonly kind: 'value';
  readonly previous: unknown;
  readonly next: () => unknown;
  readonly output: { set(value: unknown): void };
};

export type CollectionOutputEvaluation = {
  readonly kind: 'collection';
  readonly previous: CollectionRead<string, unknown>;
  readonly next: CollectionRead<string, unknown>;
  readonly output: CollectionDraft<string, unknown>;
};

export type OutputEvaluation = ValueOutputEvaluation | CollectionOutputEvaluation;

export type ProcessorEvaluation = {
  readonly reset: boolean;
  readonly cause: unknown;
  readonly sources: readonly SourceContext[];
  readonly outputs: readonly OutputEvaluation[];
};

export type ProcessorInstance = {
  evaluate(input: ProcessorEvaluation): void;
  release?(): void;
};

type SourceAdapter =
  | {
      readonly kind: 'value-input';
      readonly initial: unknown;
      readonly equality: Equality;
    }
  | {
      readonly kind: 'collection-input';
      readonly initial: ReadonlyMap<string, unknown>;
      readonly equality: Equality;
    }
  | {
      readonly kind: 'readable';
      readonly readable: Readable<unknown>;
      readonly equality: Equality;
    }
  | {
      readonly kind: 'external-value';
      readonly source: ExternalValueSource<unknown>;
      readonly equality: Equality;
    }
  | {
      readonly kind: 'external-collection';
      readonly source: ExternalCollectionSource<string, unknown>;
    }
  | {
      readonly kind: 'document';
      readonly document: ReadonlyDocument<ObjectSchema<object>>;
      readonly selector: ValueSelector | CollectionSelector;
    };

export type SourceDefinition = {
  readonly kind: 'source';
  readonly source: SourceAdapter;
  readonly output: OutputDefinition;
  owner?: object;
  materialized?: true;
};

export type ProcessorDefinition = {
  readonly kind: 'processor';
  readonly dependencies: readonly Projection<unknown>[];
  readonly outputs: readonly OutputDefinition[];
  readonly create: () => ProcessorInstance;
  readonly name?: string;
  owner?: object;
  materialized?: true;
};

export type ProducerDefinition = SourceDefinition | ProcessorDefinition;

export type ProjectionRef = {
  readonly producer: ProducerDefinition;
  readonly output: number;
};

const projections = new WeakMap<object, ProjectionRef>();

const defineRef = <T, C = undefined>(
  producer: ProducerDefinition,
  output: number
): ProjectionWithChange<T, C> => {
  const handle = Object.freeze({}) as ProjectionWithChange<T, C>;
  projections.set(handle, Object.freeze({ producer, output }));
  return handle;
};

export const projectionRef = (projection: Projection<unknown>): ProjectionRef => {
  const ref = projections.get(projection);
  if (!ref) throw new TypeError('Unknown projection definition.');
  return ref;
};

export const producerOf = (projection: Projection<unknown>): ProducerDefinition =>
  projectionRef(projection).producer;

export const isProjection = (value: unknown): value is Projection<unknown> =>
  value !== null && typeof value === 'object' && projections.has(value);

export const ownProjections = (
  projections: readonly Projection<unknown>[],
  owner: object
): void => {
  const producers = new Set(projections.map(producerOf));
  for (const producer of producers) {
    if (producer.owner !== undefined && producer.owner !== owner)
      throw new TypeError('Projection producer already belongs to another scope.');
    if (producer.owner === undefined && producer.materialized)
      throw new TypeError('A materialized root projection cannot become scope-owned.');
    if (producer.kind !== 'processor') continue;
    for (const dependency of producer.dependencies) {
      const dependencyOwner = producerOf(dependency).owner;
      if (dependencyOwner !== undefined && dependencyOwner !== owner)
        throw new TypeError('A scope cannot depend on another scope.');
    }
  }
  for (const producer of producers) producer.owner = owner;
};

const freezeOutput = (output: OutputDefinition): OutputDefinition =>
  Object.freeze({
    kind: output.kind,
    equality: output.equality,
    ...(output.path ? { path: Object.freeze([...output.path]) } : {}),
  });

export const defineProcessor = (definition: {
  readonly dependencies: readonly Projection<unknown>[];
  readonly outputs: readonly OutputDefinition[];
  readonly create: () => ProcessorInstance;
  readonly name?: string;
}): readonly Projection<unknown>[] => {
  if (!Array.isArray(definition.dependencies))
    throw new TypeError('Projection dependencies must be an array.');
  definition.dependencies.forEach(projectionRef);
  if (!definition.outputs.length) throw new TypeError('Projection processor requires an output.');
  const producer: ProcessorDefinition = {
    kind: 'processor',
    dependencies: Object.freeze([...definition.dependencies]),
    outputs: Object.freeze(definition.outputs.map(freezeOutput)),
    create: definition.create,
    ...(definition.name ? { name: definition.name } : {}),
  };
  return Object.freeze(
    producer.outputs.map((_, output) => defineRef<unknown, unknown>(producer, output))
  );
};

const defineSource = <T, C = undefined>(
  source: SourceAdapter,
  output: OutputDefinition
): ProjectionWithChange<T, C> => {
  const producer: SourceDefinition = {
    kind: 'source',
    source,
    output: freezeOutput(output),
  };
  return defineRef<T, C>(producer, 0);
};

const valueInput = <T>(
  initial: T,
  equality: (previous: T, next: T) => boolean = Object.is
): Input<T> =>
  defineSource<T>(
    { kind: 'value-input', initial, equality: equality as Equality },
    { kind: 'value', equality: equality as Equality }
  ) as unknown as Input<T>;

const collectionInput = <K extends string, V>(
  initial: ReadonlyMap<K, V> = new Map<K, V>(),
  equality: (previous: V, next: V) => boolean = Object.is
): CollectionInput<K, V> => {
  const entries = new Map<string, unknown>();
  for (const [key, value] of initial) {
    if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
    entries.set(key, value);
  }
  return defineSource<ReadonlyMap<K, V>, CollectionChange<K, V>>(
    { kind: 'collection-input', initial: entries, equality: equality as Equality },
    { kind: 'collection', equality: equality as Equality }
  ) as CollectionInput<K, V>;
};

export const input = Object.assign(valueInput, { collection: collectionInput });

/** Establish a lazy reactive boundary from a document, readable, or external source. */
export function observe<S extends ObjectSchema<object>>(
  document: ReadonlyDocument<S>
): Projection<Infer<S>>;
export function observe<T>(source: ExternalValueSource<T>): Projection<T>;
export function observe<K extends string, V>(
  source: ExternalCollectionSource<K, V>
): ProjectionWithChange<ReadonlyMap<K, V>, CollectionChange<K, V>>;
export function observe<T>(readable: Readable<T>): Projection<T>;
export function observe<S extends ObjectSchema<object>, P extends CollectionPath>(
  document: ReadonlyDocument<S>,
  selector: (path: SchemaPath<S>) => P
): ProjectionWithChange<
  ReadonlyMap<CollectionId<P>, ReadonlyValue<CollectionEntry<P>>>,
  CollectionChange<CollectionId<P>, ReadonlyValue<CollectionEntry<P>>>
>;
export function observe<S extends ObjectSchema<object>, P>(
  document: ReadonlyDocument<S>,
  selector: (path: SchemaPath<S>) => P
): Projection<PathValueOf<P>>;
export function observe<S extends ObjectSchema<object>>(
  source:
    | ReadonlyDocument<S>
    | Readable<unknown>
    | ExternalValueSource<unknown>
    | ExternalCollectionSource<string, unknown>,
  selector?: PathSelector<S>
): Projection<unknown> {
  if (isExternalSource(source))
    return source.kind === 'collection'
      ? defineSource(
          { kind: 'external-collection', source },
          { kind: 'collection', equality: Object.is }
        )
      : defineSource(
          { kind: 'external-value', source, equality: Object.is },
          { kind: 'value', equality: Object.is }
        );
  if ('current' in source && typeof source.current === 'function')
    return defineSource(
      { kind: 'readable', readable: source as Readable<unknown>, equality: Object.is },
      { kind: 'value', equality: Object.is }
    );

  const document = source as ReadonlyDocument<S>;
  const state = contextOf<S>(document).state;
  const selected = selector
    ? compilePath<S>(state.schema, 'auto', selector)
    : (Object.freeze({
        kind: 'value' as const,
        schema: state.schema,
        address: Object.freeze([]),
      }) as ValueSelector);
  return defineSource(
    {
      kind: 'document',
      document: document as unknown as ReadonlyDocument<ObjectSchema<object>>,
      selector: selected,
    },
    { kind: selected.kind, equality: Object.is }
  );
}

const isExternalSource = (
  source: unknown
): source is ExternalValueSource<unknown> | ExternalCollectionSource<string, unknown> => {
  if (!source || typeof source !== 'object') return false;
  const candidate = source as {
    readonly kind?: unknown;
    readonly current?: unknown;
    readonly revision?: unknown;
    readonly subscribe?: unknown;
  };
  return (
    (candidate.kind === 'value' || candidate.kind === 'collection') &&
    typeof candidate.current === 'function' &&
    typeof candidate.revision === 'function' &&
    typeof candidate.subscribe === 'function'
  );
};
