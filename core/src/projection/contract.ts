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
export type EngineSource<T> = { readonly [sourceContext]: T };
export type EngineSources = Readonly<Record<string, EngineSource<unknown>>>;
export type EngineInputs<S extends EngineSources> = {
  readonly [K in keyof S]: S[K] extends EngineSource<infer T> ? T : never;
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
export type DocumentSource<S extends ObjectNode> = EngineSource<DocumentInput<S>> & {
  collection<P extends CollectionPath>(
    pick: (path: SchemaPath<S['shape']>) => P
  ): DocumentCollectionSource<S, CollectionNode<P>, CollectionId<P>>;
  targets(...targets: readonly [PathPick<S>, ...PathPick<S>[]]): EngineSource<DocumentInput<S>>;
};
export type DocumentCollectionSource<
  S extends ObjectNode,
  N extends ValueSchemaNode,
  K extends string = string,
> = EngineSource<DocumentCollectionInput<S, N, K>>;
export type ValueInput<T> = {
  readonly value: T;
  readonly previous: T;
  readonly changed: boolean;
  readonly revision: number;
  readonly reset: boolean;
};
export type EngineInput<T> = {
  readonly source: EngineSource<ValueInput<T>>;
  set(value: T): void;
};
export type ValueUpdate<T> =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly value: T }
  | { readonly kind: 'rebuild' };
export type EngineValueSpec<S extends EngineSources, T> = {
  readonly name?: string;
  readonly sources: S;
  readonly build: (sources: EngineInputs<S>) => {
    readonly value: T;
    readonly update: (sources: EngineInputs<S>) => ValueUpdate<NoInfer<T>>;
  };
};
export type MaterializedValue<T> = Readable<T> &
  EngineSource<ValueInput<T>> & { rebuild(): void; dispose(): void };
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
export type MaterializedCollection<K extends string, V> = EngineSource<CollectionInput<K, V>> & {
  current(): CollectionRead<K, V>;
  readonly ids: Readable<readonly K[]>;
  readonly all: Readable<readonly V[]>;
  item(key: K): Readable<V | undefined>;
  revision(): number;
  subscribe(listener: (change: CollectionImpact<K>) => void): Unsubscribe;
  rebuild(): void;
  dispose(): void;
};
export type MaterializedCollectionWriter<K extends string, V> = {
  set(key: K, value: V): void;
  remove(key: K): void;
  order(ids: readonly K[]): void;
  replace(entries: readonly (readonly [K, V])[]): void;
};
export type EngineCollectionProcess<S extends EngineSources, K extends string, V> = {
  readonly sources: EngineInputs<S>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly writer: MaterializedCollectionWriter<K, V>;
};
export type EngineCollectionSpec<S extends EngineSources, K extends string, V> = {
  readonly name?: string;
  readonly sources: S;
  readonly isEqual?: (previous: V, next: V) => boolean;
  readonly build: (input: EngineCollectionProcess<S, K, V>) => {
    readonly update: (
      input: EngineCollectionProcess<S, K, V>
    ) => void | { readonly kind: 'rebuild' };
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
export type ProjectionEngine = {
  document<S extends ObjectNode>(runtime: DocumentReadable<S>): DocumentSource<S>;
  fromReadable<T>(
    readable: Readable<T>,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): EngineSource<ValueInput<T>>;
  input<T>(initial: T, options?: { readonly isEqual?: (a: T, b: T) => boolean }): EngineInput<T>;
  value<S extends EngineSources, T>(
    sources: S,
    compute: (sources: EngineInputs<S>) => Synchronous<T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): MaterializedValue<T>;
  value<S extends EngineSources, T>(
    spec: EngineValueSpec<S, T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): MaterializedValue<T>;
  collection<V, K extends string = string>(): <S extends EngineSources>(
    spec: EngineCollectionSpec<S, K, V>
  ) => MaterializedCollection<K, V>;
  map<S extends ObjectNode, N extends ValueSchemaNode, K extends string, V>(
    source: DocumentCollectionSource<S, N, K>,
    mapper: (id: K, entry: Read<N>) => Synchronous<V>,
    options?: { readonly isEqual?: (a: V, b: V) => boolean }
  ): MaterializedCollection<K, V>;
  map<K extends string, V, R>(
    source: MaterializedCollection<K, V>,
    mapper: (id: K, entry: V) => Synchronous<R>,
    options?: { readonly isEqual?: (a: NoInfer<R>, b: NoInfer<R>) => boolean }
  ): MaterializedCollection<K, R>;
  batch<T>(run: () => Synchronous<T>): T;
  dispose(): void;
};
