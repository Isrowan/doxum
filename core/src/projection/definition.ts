import type { DocumentReadable, Synchronous } from '../runtime/contract';
import type {
  CollectionId,
  CollectionPath,
  CollectionNode as SchemaCollectionNode,
  Infer,
  ObjectNode,
  ReadonlyValue,
  SchemaPath,
  PathValueOf,
} from '../schema';
import type { Readable } from './readable';
import type {
  BatchContext,
  Cause,
  CollectionContext,
  CollectionChange,
  CollectionDraft,
  CollectionRead,
  CollectionEntryTransition,
  DocumentContext,
  ExternalCollectionSource,
  ExternalValueSource,
  GraphSources,
  InputHandles,
  NodeUpdate,
  ValueContext,
} from './contract';

declare const projectionDefinition: unique symbol;
declare const projectionChanges: unique symbol;
declare const writableInput: unique symbol;

/** A lazy, reusable projection definition. Its value is materialized per runtime. */
export type Projection<T, C = undefined> = {
  readonly [projectionDefinition]: T;
  readonly [projectionChanges]: C;
};

/** A runtime-local writable projection definition. */
export type Input<T> = Projection<T> & { readonly [writableInput]: true };

export type ProjectionValues<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Projection<infer T, unknown> ? T : never;
};

export type ProjectionChanges<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Projection<unknown, infer C>
    ? [C] extends [undefined]
      ? undefined
      : C | undefined
    : undefined;
};

export type PublicCollection<K extends string, V> = ReadonlyMap<K, V>;
export type CollectionProjection<K extends string, V> = Projection<
  PublicCollection<K, V>,
  CollectionChange<K, V>
>;

type Equality = (a: unknown, b: unknown) => boolean;
type PathSelector<S extends ObjectNode> = (path: SchemaPath<S['shape']>) => unknown;

type Definition =
  | { readonly kind: 'input'; readonly initial: unknown; readonly isEqual?: Equality }
  | { readonly kind: 'readable'; readonly readable: Readable<unknown>; readonly isEqual?: Equality }
  | { readonly kind: 'source-value'; readonly source: ExternalValueSource<unknown, unknown> }
  | {
      readonly kind: 'source-collection';
      readonly source: ExternalCollectionSource<string, unknown, unknown>;
    }
  | {
      readonly kind: 'document';
      readonly document: DocumentReadable<ObjectNode>;
      readonly selector?: PathSelector<ObjectNode>;
    }
  | {
      readonly kind: 'derive';
      readonly dependencies: readonly Projection<unknown, unknown>[];
      readonly compute: (...values: readonly unknown[]) => unknown;
      readonly isEqual?: Equality;
    }
  | {
      readonly kind: 'incremental-value';
      readonly dependencies: GraphSources;
      readonly build: (...args: never[]) => unknown;
      readonly isEqual?: Equality;
      readonly name?: string;
    }
  | {
      readonly kind: 'incremental-collection';
      readonly dependencies: GraphSources;
      readonly build: (...args: never[]) => unknown;
      readonly isEqual?: Equality;
      readonly name?: string;
    };

type DefinitionProjection = Projection<unknown, unknown>;
const definitions = new WeakMap<object, Definition>();

const define = <T, C = undefined>(definition: Definition): Projection<T, C> => {
  const handle = Object.freeze({}) as Projection<T, C>;
  definitions.set(handle, definition);
  return handle;
};

export const definitionOf = (projection: DefinitionProjection): Definition => {
  const definition = definitions.get(projection);
  if (!definition) throw new TypeError('Unknown projection definition.');
  return definition;
};

export const input = <T>(
  initial: T,
  equality: (previous: T, next: T) => boolean = Object.is
): Input<T> => define<T>({ kind: 'input', initial, isEqual: equality as Equality }) as Input<T>;

/**
 * Establishes a reactive boundary from a document, readable, or external
 * source. The selector is compiled when the definition is materialized, so
 * declarations stay lazy and reusable.
 */
export function observe<S extends ObjectNode>(document: DocumentReadable<S>): Projection<Infer<S>>;
export function observe<T, D>(source: ExternalValueSource<T, D>): Projection<T>;
export function observe<K extends string, V, D>(
  source: ExternalCollectionSource<K, V, D>
): CollectionProjection<K, V>;
export function observe<T>(readable: Readable<T>): Projection<T>;
export function observe<S extends ObjectNode, P extends CollectionPath>(
  document: DocumentReadable<S>,
  selector: (path: SchemaPath<S['shape']>) => P
): CollectionProjection<CollectionId<P>, ReadonlyValue<Infer<SchemaCollectionNode<P>>>>;
export function observe<S extends ObjectNode, P>(
  document: DocumentReadable<S>,
  selector: (path: SchemaPath<S['shape']>) => P
): Projection<PathValueOf<P>>;
export function observe<S extends ObjectNode>(
  document:
    | DocumentReadable<S>
    | Readable<unknown>
    | ExternalValueSource<unknown, unknown>
    | ExternalCollectionSource<string, unknown, unknown>,
  selector?: PathSelector<S>
): Projection<unknown, unknown> {
  if (isExternalSource(document))
    return document.kind === 'collection'
      ? defineExternalCollection(document)
      : defineExternalValue(document);
  if ('current' in document && typeof document.current === 'function')
    return defineReadable(document as Readable<unknown>);
  return define({
    kind: 'document',
    document: document as DocumentReadable<ObjectNode>,
    selector: selector as PathSelector<ObjectNode> | undefined,
  });
}

const isExternalSource = (
  source: unknown
): source is
  ExternalValueSource<unknown, unknown> | ExternalCollectionSource<string, unknown, unknown> => {
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

export function derive<const D extends readonly Projection<unknown, unknown>[], T>(
  dependencies: D,
  compute: (...values: ProjectionValues<D>) => Synchronous<T>,
  equality: (previous: T, next: T) => boolean = Object.is
): Projection<T> {
  if (!Array.isArray(dependencies) || dependencies.some(value => !definitions.has(value)))
    throw new TypeError('derive dependencies must be projections.');
  const frozen = Object.freeze([...dependencies]) as readonly Projection<unknown, unknown>[];
  return define<T>({
    kind: 'derive',
    dependencies: frozen,
    compute: compute as (...values: readonly unknown[]) => unknown,
    isEqual: equality as Equality,
  });
}

/** Internal source adapters used by observe, not exported publicly. */
export const defineReadable = <T>(
  readable: Readable<T>,
  equality: (a: T, b: T) => boolean = Object.is
): Projection<T> => define<T>({ kind: 'readable', readable, isEqual: equality as Equality });

export const defineExternalValue = <T, D>(source: ExternalValueSource<T, D>): Projection<T> =>
  define<T>({ kind: 'source-value', source: source as never });

export const defineExternalCollection = <K extends string, V, D>(
  source: ExternalCollectionSource<K, V, D>
): CollectionProjection<K, V> =>
  define<PublicCollection<K, V>, CollectionChange<K, V>>({
    kind: 'source-collection',
    source: source as never,
  });

export type IncrementalValueDefinition = Extract<Definition, { kind: 'incremental-value' }>;
export type IncrementalCollectionDefinition = Extract<
  Definition,
  { kind: 'incremental-collection' }
>;

export const defineIncrementalValue = <T>(definition: {
  readonly dependencies: GraphSources;
  readonly build: (...args: never[]) => unknown;
  readonly isEqual?: (a: T, b: T) => boolean;
  readonly name?: string;
}): Projection<T> =>
  define<T>({
    kind: 'incremental-value',
    dependencies: definition.dependencies,
    build: definition.build,
    isEqual: definition.isEqual as Equality | undefined,
    name: definition.name,
  });

export const defineIncrementalCollection = <K extends string, V>(definition: {
  readonly dependencies: GraphSources;
  readonly build: (...args: never[]) => unknown;
  readonly isEqual?: (a: V, b: V) => boolean;
  readonly name?: string;
}): CollectionProjection<K, V> =>
  define<PublicCollection<K, V>, CollectionChange<K, V>>({
    kind: 'incremental-collection',
    dependencies: definition.dependencies,
    build: definition.build,
    isEqual: definition.isEqual as Equality | undefined,
    name: definition.name,
  });

// Internal event names remain private implementation detail and are not root exports.
export type InternalDocumentEvent<S extends ObjectNode> = DocumentContext<S>;
export type InternalValueEvent<T, D = unknown> = ValueContext<T, D>;
export type InternalCollectionEvent<K extends string, V, D = unknown> = CollectionContext<K, V, D>;
export type InternalCollectionTransition<K extends string, V> = CollectionEntryTransition<K, V>;
export type InternalCollectionDraft<K extends string, V> = CollectionDraft<K, V>;
export type InternalBatchContext = BatchContext;
export type InternalCause = Cause;
export type InternalInputHandles<S extends GraphSources> = InputHandles<S>;
export type InternalNodeUpdate<T> = NodeUpdate<T>;
export type InternalCollectionRead<K extends string, V> = CollectionRead<K, V>;
