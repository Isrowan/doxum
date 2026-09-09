import type { CollectionAccess, Read } from '../access/scope';
import type { CollectionImpact } from '../impact';
import type { DocumentCommit, DocumentReadable, Synchronous } from '../runtime/contract';
import type {
  CollectionId,
  CollectionNode,
  CollectionPath,
  ObjectNode,
  PathPick,
  SchemaPath,
  ValueSchemaNode,
} from '../schema';
import type { Readable } from './readable';
import type { CollectionRead, MaterializedCollectionWriter, ValueUpdate } from './contract';

declare const projectionDefinition: unique symbol;
declare const writableInput: unique symbol;

export type Projection<
  T,
  E = T,
  K extends 'source' | 'value' | 'collection' = 'source' | 'value' | 'collection',
> = {
  readonly [projectionDefinition]: { readonly value: T; readonly event: E; readonly kind: K };
};
export type ProjectionSources = Readonly<
  Record<string, Projection<unknown, unknown, 'source' | 'value' | 'collection'>>
>;
export type ProjectionValues<S extends ProjectionSources> = {
  readonly [K in keyof S]: S[K] extends Projection<
    infer T,
    unknown,
    'source' | 'value' | 'collection'
  >
    ? T
    : never;
};
export type ProjectionEvents<S extends ProjectionSources> = {
  readonly [K in keyof S]: S[K] extends Projection<
    unknown,
    infer E,
    'source' | 'value' | 'collection'
  >
    ? E
    : never;
};

export type ValueProjection<T, E = ValueEvent<T>> = Projection<T, E, 'value'>;
export type InputProjection<T> = ValueProjection<T> & { readonly [writableInput]: true };
export type CollectionProjection<K extends string, V, E = CollectionEvent<K, V>> = Projection<
  CollectionRead<K, V>,
  E,
  'collection'
>;
export type CollectionSource<K extends string, V, E> = Projection<
  CollectionRead<K, V>,
  E,
  'source'
>;
export type DocumentProjection<S extends ObjectNode> = Projection<
  Read<S>,
  DocumentEvent<S>,
  'source'
>;
export type DocumentCollectionProjection<
  S extends ObjectNode,
  N extends ValueSchemaNode,
  K extends string = string,
> = CollectionSource<K, Read<N>, DocumentCollectionEvent<S, N, K>>;

export type ValueEvent<T> = {
  readonly value: T;
  readonly previous: T;
  readonly changed: boolean;
  readonly revision: number;
  readonly reset: boolean;
};
export type DocumentEvent<S extends ObjectNode> = {
  readonly read: Read<S>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
};
export type DocumentCollectionEvent<
  S extends ObjectNode,
  N extends ValueSchemaNode,
  K extends string = string,
> = {
  readonly read: CollectionAccess<K, N>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
  readonly candidates: { readonly keys: readonly K[]; readonly orderDirty: boolean };
};
export type CollectionEvent<K extends string, V> = CollectionRead<K, V> & {
  readonly change: CollectionImpact<K> | undefined;
  readonly revision: number;
  readonly reset: boolean;
};

type Definition =
  | { readonly kind: 'input'; readonly initial: unknown; readonly isEqual?: Equality }
  | { readonly kind: 'readable'; readonly readable: Readable<unknown>; readonly isEqual?: Equality }
  | {
      readonly kind: 'document';
      readonly document: DocumentReadable<ObjectNode>;
      readonly targets?: readonly PathPick<ObjectNode>[];
    }
  | {
      readonly kind: 'document-collection';
      readonly document: DocumentReadable<ObjectNode>;
      readonly pick: Callback;
    }
  | {
      readonly kind: 'map';
      readonly source: Projection<unknown, unknown>;
      readonly mapper: Callback;
      readonly isEqual?: Equality;
    }
  | {
      readonly kind: 'value';
      readonly sources: ProjectionSources;
      readonly compute: Callback;
      readonly isEqual?: Equality;
    }
  | {
      readonly kind: 'advanced-value';
      readonly sources: ProjectionSources;
      readonly build: Callback;
      readonly isEqual?: Equality;
      readonly name?: string;
    }
  | {
      readonly kind: 'advanced-collection';
      readonly sources: ProjectionSources;
      readonly build: Callback;
      readonly isEqual?: Equality;
      readonly name?: string;
    };

type Equality = (a: unknown, b: unknown) => boolean;
type Callback = (...args: never[]) => unknown;

const definitions = new WeakMap<object, Definition>();
const freezeSources = <S extends ProjectionSources>(sources: S): S =>
  Object.freeze({ ...sources }) as S;
const define = <
  T,
  E = T,
  K extends 'source' | 'value' | 'collection' = 'source' | 'value' | 'collection',
>(
  definition: Definition
): Projection<T, E, K> => {
  const handle = Object.freeze({}) as Projection<T, E, K>;
  definitions.set(handle, definition);
  return handle;
};

export const definitionOf = (
  projection: Projection<unknown, unknown, 'source' | 'value' | 'collection'>
): Definition => {
  const definition = definitions.get(projection);
  if (!definition) throw new TypeError('Unknown projection definition.');
  return definition;
};

export const input = <T>(
  initial: T,
  options?: { readonly isEqual?: (a: T, b: T) => boolean }
): InputProjection<T> =>
  define<T, ValueEvent<T>, 'value'>({
    kind: 'input',
    initial,
    isEqual: options?.isEqual as Equality | undefined,
  }) as InputProjection<T>;

export type AdvancedValueSpec<S extends ProjectionSources, T> = {
  readonly kind: 'value';
  readonly name?: string;
  readonly sources: S;
  readonly build: (sources: ProjectionEvents<S>) => {
    readonly value: T;
    readonly update: (sources: ProjectionEvents<S>) => ValueUpdate<NoInfer<T>>;
  };
  readonly isEqual?: (previous: T, next: T) => boolean;
};

export type AdvancedCollectionSpec<S extends ProjectionSources, K extends string, V> = {
  readonly kind: 'collection';
  readonly name?: string;
  readonly sources: S;
  readonly build: (input: AdvancedCollectionProcess<S, K, V>) => {
    readonly update: (
      input: AdvancedCollectionProcess<S, K, V>
    ) => void | { readonly kind: 'rebuild' };
  };
  readonly isEqual?: (previous: V, next: V) => boolean;
};

export type AdvancedCollectionProcess<S extends ProjectionSources, K extends string, V> = {
  readonly sources: ProjectionEvents<S>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly writer: MaterializedCollectionWriter<K, V>;
};

export function project<T>(readable: Readable<T>): ValueProjection<T>;
export function project<S extends ObjectNode>(document: DocumentReadable<S>): DocumentProjection<S>;
export function project<S extends ObjectNode>(
  document: DocumentReadable<S>,
  targets: readonly [PathPick<S>, ...PathPick<S>[]]
): DocumentProjection<S>;
export function project<S extends ObjectNode, P extends CollectionPath>(
  document: DocumentReadable<S>,
  pick: (path: SchemaPath<S['shape']>) => P
): DocumentCollectionProjection<S, CollectionNode<P>, CollectionId<P>>;
export function project<S extends ObjectNode, P extends CollectionPath, V>(
  document: DocumentReadable<S>,
  pick: (path: SchemaPath<S['shape']>) => P,
  mapper: (id: CollectionId<P>, entry: Read<CollectionNode<P>>) => Synchronous<V>,
  options?: { readonly isEqual?: (a: V, b: V) => boolean }
): CollectionProjection<CollectionId<P>, V>;
export function project<K extends string, V, E, R>(
  source: Projection<CollectionRead<K, V>, E, 'source' | 'collection'>,
  mapper: (id: K, entry: V) => Synchronous<R>,
  options?: { readonly isEqual?: (a: R, b: R) => boolean }
): CollectionProjection<K, R>;
export function project<S extends ProjectionSources, T>(
  sources: S,
  compute: (sources: ProjectionValues<S>) => Synchronous<T>,
  options?: { readonly isEqual?: (a: T, b: T) => boolean }
): ValueProjection<T>;
export function project<S extends ProjectionSources, T>(
  spec: AdvancedValueSpec<S, T>
): ValueProjection<T>;
export function project<
  V,
  K extends string = string,
  S extends ProjectionSources = ProjectionSources,
>(spec: AdvancedCollectionSpec<S, K, V>): CollectionProjection<K, V>;
export function project(
  first: unknown,
  second?: Callback | readonly unknown[],
  third?: Callback | object,
  fourth?: object
): Projection<unknown, unknown, 'source' | 'value' | 'collection'> {
  if (
    first &&
    typeof first === 'object' &&
    'kind' in first &&
    ((first as { kind?: unknown }).kind === 'value' ||
      (first as { kind?: unknown }).kind === 'collection')
  ) {
    const spec = first as {
      kind: 'value' | 'collection';
      sources: ProjectionSources;
      build: Callback;
      isEqual?: Equality;
      name?: string;
    };
    return define({
      kind: spec.kind === 'value' ? 'advanced-value' : 'advanced-collection',
      sources: freezeSources(spec.sources),
      build: spec.build as Callback,
      isEqual: spec.isEqual as Equality | undefined,
      name: spec.name,
    });
  }
  if (first && typeof first === 'object' && 'revision' in first && 'subscribe' in first) {
    if ('address' in first) {
      const document = first as DocumentReadable<ObjectNode>;
      if (!second) return define({ kind: 'document', document });
      if (Array.isArray(second))
        return define({
          kind: 'document',
          document,
          targets: Object.freeze([...second]) as readonly PathPick<ObjectNode>[],
        });
      if (typeof second !== 'function') throw new TypeError('Invalid document projection.');
      const source = define<unknown>({
        kind: 'document-collection',
        document,
        pick: second as Callback,
      });
      if (!third || typeof third !== 'function') return source;
      return define({
        kind: 'map',
        source,
        mapper: third as Callback,
        isEqual: (fourth as { isEqual?: Equality } | undefined)?.isEqual,
      });
    }
    return define({ kind: 'readable', readable: first as Readable<unknown> });
  }
  if (second) {
    if (typeof second !== 'function') throw new TypeError('Invalid project declaration.');
    if (definitions.has(first as object))
      return define({
        kind: 'map',
        source: first as Projection<unknown, unknown, 'source' | 'collection'>,
        mapper: second as Callback,
        isEqual: (third as { isEqual?: Equality } | undefined)?.isEqual,
      });
    return define({
      kind: 'value',
      sources: freezeSources(first as ProjectionSources),
      compute: second as Callback,
      isEqual: (third as { isEqual?: Equality } | undefined)?.isEqual,
    });
  }
  throw new TypeError('Invalid project declaration.');
}
