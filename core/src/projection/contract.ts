import type { CollectionReader, DocumentReader, ReaderOfNode } from '../access/reader';
import type { CollectionImpact } from '../impact';
import type { DocumentCommit, DocumentReadable, Unsubscribe } from '../runtime/contract';
import type {
  CollectionNode,
  CollectionSelector,
  DocumentSchema,
  EntitySchemaNode,
  ImpactTarget,
  SchemaPath,
} from '../schema';
import type { Readable } from './readable';

declare const sourceContext: unique symbol;
export type ProjectionSource<T> = { readonly [sourceContext]: T };
export type ProjectionSources = Readonly<Record<string, ProjectionSource<unknown>>>;
export type ProjectionInputs<S extends ProjectionSources> = {
  readonly [K in keyof S]: S[K] extends ProjectionSource<infer T> ? T : never;
};
export type DocumentInput<S extends DocumentSchema> = {
  readonly read: DocumentReader<S>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
};
export type DocumentCollectionInput<S extends DocumentSchema, N extends EntitySchemaNode> = {
  readonly read: CollectionReader<string, N>;
  readonly target: CollectionSelector<string, N>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
};
type CollectionPath = {
  readonly __collection?: { readonly id: string; readonly node: EntitySchemaNode };
};
export type DocumentSource<S extends DocumentSchema> = ProjectionSource<DocumentInput<S>> & {
  collection<P extends CollectionPath>(
    pick: (path: SchemaPath<S['shape']>) => P
  ): DocumentCollectionSource<S, CollectionNode<P>>;
  targets(
    ...targets: readonly [ImpactTarget, ...ImpactTarget[]]
  ): ProjectionSource<DocumentInput<S>>;
};
export type DocumentCollectionSource<
  S extends DocumentSchema,
  N extends EntitySchemaNode,
> = ProjectionSource<DocumentCollectionInput<S, N>>;
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
  readonly isEqual?: (previous: NoInfer<T>, next: NoInfer<T>) => boolean;
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
  document<S extends DocumentSchema>(runtime: DocumentReadable<S>): DocumentSource<S>;
  fromReadable<T>(
    readable: Readable<T>,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): ProjectionSource<ValueInput<T>>;
  input<T>(
    initial: T,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): ProjectionInput<T>;
  value<S extends ProjectionSources, T>(spec: ValueSpec<S, T>): ProjectionValue<T>;
  collection<S extends ProjectionSources, K extends string, V>(
    spec: CollectionSpec<S, K, V>
  ): ProjectionCollection<K, V>;
  map<S extends DocumentSchema, N extends EntitySchemaNode, V>(
    source: DocumentCollectionSource<S, N>,
    mapper: (id: string, entry: ReaderOfNode<N>) => V,
    options?: { readonly isEqual?: (a: V, b: V) => boolean }
  ): ProjectionCollection<string, V>;
  batch<T>(run: () => T): T;
  dispose(): void;
};
