import type { CollectionAccess, Read } from '../access/scope';
import type { CollectionImpact } from '../impact';
import type {
  DocumentCommit,
  DocumentReadable,
  Synchronous,
  Unsubscribe,
} from '../runtime/contract';
import type {
  CollectionNode,
  CollectionId,
  CollectionPath,
  ObjectNode,
  ValueSchemaNode,
  PathPick,
  SchemaPath,
} from '../schema';
import type { Readable } from './readable';

declare const sourceContext: unique symbol;
export type ProjectionSource<T> = { readonly [sourceContext]: T };
export type ProjectionSources = Readonly<Record<string, ProjectionSource<unknown>>>;
export type ProjectionInputs<S extends ProjectionSources> = {
  readonly [K in keyof S]: S[K] extends ProjectionSource<infer T> ? T : never;
};
export type DocumentInput<S extends ObjectNode> = {
  readonly read: Read<S>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
};
export type DocumentCollectionInput<
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
export type DocumentSource<S extends ObjectNode> = ProjectionSource<DocumentInput<S>> & {
  collection<P extends CollectionPath>(
    pick: (path: SchemaPath<S['shape']>) => P
  ): DocumentCollectionSource<S, CollectionNode<P>, CollectionId<P>>;
  targets(...targets: readonly [PathPick<S>, ...PathPick<S>[]]): ProjectionSource<DocumentInput<S>>;
};
export type DocumentCollectionSource<
  S extends ObjectNode,
  N extends ValueSchemaNode,
  K extends string = string,
> = ProjectionSource<DocumentCollectionInput<S, N, K>>;
export type ValueInput<T> = {
  readonly value: T;
  readonly previous: T;
  readonly changed: boolean;
  readonly revision: number;
  readonly reset: boolean;
};
export type ProjectionInput<T> = {
  readonly source: ProjectionSource<ValueInput<T>>;
  set(value: T): void;
};
export type ValueUpdate<T> =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly value: T }
  | { readonly kind: 'rebuild' };
export type ValueSpec<S extends ProjectionSources, T> = {
  readonly name?: string;
  readonly sources: S;
  readonly build: (sources: ProjectionInputs<S>) => {
    readonly value: T;
    readonly update: (sources: ProjectionInputs<S>) => ValueUpdate<NoInfer<T>>;
  };
};
export type ProjectionValue<T> = Readable<T> &
  ProjectionSource<ValueInput<T>> & { rebuild(): void; dispose(): void };
export type CollectionRead<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
};
export type CollectionInput<K extends string, V> = CollectionRead<K, V> & {
  readonly change: CollectionImpact<K> | undefined;
  readonly revision: number;
  readonly reset: boolean;
};
export type ProjectionCollection<K extends string, V> = ProjectionSource<CollectionInput<K, V>> & {
  readonly ids: Readable<readonly K[]>;
  readonly all: Readable<readonly V[]>;
  item(key: K): Readable<V | undefined>;
  revision(): number;
  subscribe(listener: (change: CollectionImpact<K>) => void): Unsubscribe;
  rebuild(): void;
  dispose(): void;
};
export type ProjectionCollectionWriter<K extends string, V> = {
  set(key: K, value: V): void;
  remove(key: K): void;
  order(ids: readonly K[]): void;
  replace(entries: readonly (readonly [K, V])[]): void;
};
export type CollectionProcess<S extends ProjectionSources, K extends string, V> = {
  readonly sources: ProjectionInputs<S>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly writer: ProjectionCollectionWriter<K, V>;
};
export type CollectionSpec<S extends ProjectionSources, K extends string, V> = {
  readonly name?: string;
  readonly sources: S;
  readonly isEqual?: (previous: V, next: V) => boolean;
  readonly build: (input: CollectionProcess<S, K, V>) => {
    readonly update: (input: CollectionProcess<S, K, V>) => void | { readonly kind: 'rebuild' };
  };
};
export class ProjectionError extends Error {
  constructor(
    readonly phase: 'processor' | 'listener' | 'source' | 'blocked',
    readonly identity: string,
    readonly revisions: readonly number[],
    cause: unknown
  ) {
    super(`Projection ${phase} failed: ${identity}`, { cause });
    this.name = 'ProjectionError';
  }
}
export class ProjectionDisposedError extends Error {
  constructor() {
    super('Projection has been disposed.');
    this.name = 'ProjectionDisposedError';
  }
}
export type ProjectionRuntime = {
  document<S extends ObjectNode>(runtime: DocumentReadable<S>): DocumentSource<S>;
  fromReadable<T>(
    readable: Readable<T>,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): ProjectionSource<ValueInput<T>>;
  input<T>(
    initial: T,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): ProjectionInput<T>;
  value<S extends ProjectionSources, T>(
    sources: S,
    compute: (sources: ProjectionInputs<S>) => Synchronous<T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): ProjectionValue<T>;
  value<S extends ProjectionSources, T>(
    spec: ValueSpec<S, T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): ProjectionValue<T>;
  collection<V, K extends string = string>(): <S extends ProjectionSources>(
    spec: CollectionSpec<S, K, V>
  ) => ProjectionCollection<K, V>;
  map<S extends ObjectNode, N extends ValueSchemaNode, K extends string, V>(
    source: DocumentCollectionSource<S, N, K>,
    mapper: (id: K, entry: Read<N>) => Synchronous<V>,
    options?: { readonly isEqual?: (a: V, b: V) => boolean }
  ): ProjectionCollection<K, V>;
  map<K extends string, V, R>(
    source: ProjectionCollection<K, V>,
    mapper: (id: K, entry: V) => Synchronous<R>,
    options?: { readonly isEqual?: (a: NoInfer<R>, b: NoInfer<R>) => boolean }
  ): ProjectionCollection<K, R>;
  batch<T>(run: () => Synchronous<T>): T;
  dispose(): void;
};
