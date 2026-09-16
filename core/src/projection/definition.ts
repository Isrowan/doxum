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
  CollectionChange,
  ExternalCollectionSource,
  ExternalValueSource,
  GraphSources,
} from './contract';

declare const projectionDefinition: unique symbol;
declare const projectionChanges: unique symbol;
declare const writableInput: unique symbol;

/** A lazy definition with no materialized state; root definitions are reusable. */
export type Projection<T, C = undefined> = {
  readonly [projectionDefinition]: T;
  readonly [projectionChanges]: C;
};

/** A runtime-local writable projection definition. */
export type Input<T, C = undefined> = Projection<T, C> & { readonly [writableInput]: true };

type ProjectionValues<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Projection<infer T, unknown> ? T : never;
};

type Equality = (a: unknown, b: unknown) => boolean;
type PathSelector<S extends ObjectNode> = (path: SchemaPath<S['shape']>) => unknown;

type Definition =
  | { readonly kind: 'input'; readonly initial: unknown; readonly isEqual?: Equality }
  | { readonly kind: 'collection-input'; readonly initial: ReadonlyMap<string, unknown> }
  | { readonly kind: 'readable'; readonly readable: Readable<unknown>; readonly isEqual?: Equality }
  | { readonly kind: 'source-value'; readonly source: ExternalValueSource<unknown> }
  | {
      readonly kind: 'source-collection';
      readonly source: ExternalCollectionSource<string, unknown>;
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
const owners = new WeakMap<object, object>();

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

export const ownerOf = (projection: DefinitionProjection): object | undefined =>
  owners.get(projection);

export const ownDefinition = <T, C>(
  projection: Projection<T, C>,
  owner: object
): Projection<T, C> => {
  if (!definitions.has(projection) || owners.has(projection))
    throw new TypeError('Projection definition already has an owner.');
  owners.set(projection, owner);
  return projection;
};

const valueInput = <T>(
  initial: T,
  equality: (previous: T, next: T) => boolean = Object.is
): Input<T> => define<T>({ kind: 'input', initial, isEqual: equality as Equality }) as Input<T>;

const collectionInput = <K extends string, V>(
  initial: ReadonlyMap<K, V> = new Map<K, V>()
): Input<ReadonlyMap<K, V>, CollectionChange<K, V>> => {
  const entries = new Map<K, V>();
  for (const [key, value] of initial) {
    if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
    entries.set(key, value);
  }
  return define<ReadonlyMap<K, V>, CollectionChange<K, V>>({
    kind: 'collection-input',
    initial: entries,
  }) as Input<ReadonlyMap<K, V>, CollectionChange<K, V>>;
};

export const input = Object.assign(valueInput, { collection: collectionInput });

/** Establish a lazy reactive boundary from a document, readable, or external source. */
export function observe<S extends ObjectNode>(document: DocumentReadable<S>): Projection<Infer<S>>;
export function observe<T>(source: ExternalValueSource<T>): Projection<T>;
export function observe<K extends string, V>(
  source: ExternalCollectionSource<K, V>
): Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>;
export function observe<T>(readable: Readable<T>): Projection<T>;
export function observe<S extends ObjectNode, P extends CollectionPath>(
  document: DocumentReadable<S>,
  selector: (path: SchemaPath<S['shape']>) => P
): Projection<
  ReadonlyMap<CollectionId<P>, ReadonlyValue<Infer<SchemaCollectionNode<P>>>>,
  CollectionChange<CollectionId<P>, ReadonlyValue<Infer<SchemaCollectionNode<P>>>>
>;
export function observe<S extends ObjectNode, P>(
  document: DocumentReadable<S>,
  selector: (path: SchemaPath<S['shape']>) => P
): Projection<PathValueOf<P>>;
export function observe<S extends ObjectNode>(
  document:
    | DocumentReadable<S>
    | Readable<unknown>
    | ExternalValueSource<unknown>
    | ExternalCollectionSource<string, unknown>,
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

export const defineReadable = <T>(
  readable: Readable<T>,
  equality: (a: T, b: T) => boolean = Object.is
): Projection<T> => define<T>({ kind: 'readable', readable, isEqual: equality as Equality });

export const defineExternalValue = <T>(source: ExternalValueSource<T>): Projection<T> =>
  define<T>({ kind: 'source-value', source: source as ExternalValueSource<unknown> });

export const defineExternalCollection = <K extends string, V>(
  source: ExternalCollectionSource<K, V>
): Projection<ReadonlyMap<K, V>, CollectionChange<K, V>> =>
  define<ReadonlyMap<K, V>, CollectionChange<K, V>>({
    kind: 'source-collection',
    source: source as unknown as ExternalCollectionSource<string, unknown>,
  });

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
}): Projection<ReadonlyMap<K, V>, CollectionChange<K, V>> =>
  define<ReadonlyMap<K, V>, CollectionChange<K, V>>({
    kind: 'incremental-collection',
    dependencies: definition.dependencies,
    build: definition.build,
    isEqual: definition.isEqual as Equality | undefined,
    name: definition.name,
  });
