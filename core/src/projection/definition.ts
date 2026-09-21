import type { ReadonlyDocument } from '@/runtime/contract';
import type { ObjectSchema } from '@/schema/model';
import type { CollectionSelector, ValueSelector } from '@/schema/path';
import type {
  CollectionChange,
  CollectionDraft,
  CollectionRead,
  ExternalCollectionSource,
  ExternalValueSource,
  SourceContext,
} from './contract';
import type { Readable } from '@/readable';

declare const projectionDefinition: unique symbol;
declare const keyedProjection: unique symbol;
declare const writableInput: unique symbol;
declare const writableCollectionInput: unique symbol;

/** A lazy output reference with no materialized Runtime state. */
export type Projection<T> = {
  readonly [projectionDefinition]: T;
};

/** A projection whose output is a keyed collection with per-key change semantics. */
export type KeyedProjection<K extends string, V> = Projection<ReadonlyMap<K, V>> & {
  readonly [keyedProjection]: { readonly key: K; readonly value: V };
};

/** A writable source projection. */
export type Input<T> = Projection<T> & { readonly [writableInput]: true };

/** A writable keyed collection source projection. */
export type CollectionInput<K extends string, V> = KeyedProjection<K, V> & {
  readonly [writableCollectionInput]: { readonly key: K; readonly value: V };
};

export type CollectionInputDraft<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  remove(key: K): void;
};

export type ProjectionChange<P> =
  P extends KeyedProjection<infer K, infer V> ? CollectionChange<K, V> : undefined;

export type Equality = (a: unknown, b: unknown) => boolean;

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

export type SourceAdapter =
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

const defineRef = <T>(producer: ProducerDefinition, output: number): Projection<T> => {
  const handle = Object.freeze({}) as Projection<T>;
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

/** Resolves the immutable output description owned by a projection definition. */
export const outputDefinitionOf = (projection: Projection<unknown>): OutputDefinition => {
  const ref = projectionRef(projection);
  const producer = ref.producer;
  const output = producer.kind === 'source' ? producer.output : producer.outputs[ref.output];
  if (!output) throw new TypeError('Projection output does not exist.');
  return output;
};

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
  return Object.freeze(producer.outputs.map((_, output) => defineRef<unknown>(producer, output)));
};

export const defineSource = <T>(source: SourceAdapter, output: OutputDefinition): Projection<T> => {
  const producer: SourceDefinition = {
    kind: 'source',
    source,
    output: freezeOutput(output),
  };
  return defineRef<T>(producer, 0);
};
