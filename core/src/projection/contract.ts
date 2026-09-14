import type { CollectionAccess, Read } from '../access/scope';
import type { CollectionImpact } from '../impact';
import type {
  DocumentCommit,
  DocumentReadable,
  Synchronous,
  Unsubscribe,
} from '../runtime/contract';
import type {
  CollectionNode as SchemaCollectionNode,
  CollectionId,
  CollectionPath,
  ObjectNode,
  ValueSchemaNode,
  PathPick,
  SchemaPath,
} from '../schema';
import type { Readable } from './readable';

declare const sourceContext: unique symbol;
export type GraphSource<T> = { readonly [sourceContext]: T };
export type GraphSources = Readonly<Record<string, GraphSource<unknown>>>;
export type InputHandles<S extends GraphSources> = {
  readonly [K in keyof S]: S[K] extends GraphSource<infer T> ? T : never;
};
/** Opaque application metadata identifying the action that produced a source event. */
export type Cause = unknown;
export type BatchContext = {
  readonly id: number;
  readonly cause?: Cause;
};
export type BatchOptions = {
  readonly cause?: Cause;
};
export type CollectionEntryTransition<K extends string, V> = {
  readonly key: K;
  readonly kind: 'added' | 'updated' | 'removed';
  readonly before: V | undefined;
  readonly after: V | undefined;
};
export type DocumentContext<S extends ObjectNode> = {
  readonly read: Read<S>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
  readonly cause?: Cause;
  readonly batch?: BatchContext;
};
export type DocumentCollectionContext<
  S extends ObjectNode,
  N extends ValueSchemaNode,
  K extends string = string,
> = {
  readonly read: CollectionAccess<K, N>;
  readonly revision: number;
  readonly commits: readonly DocumentCommit<S>[];
  readonly reset: boolean;
  readonly candidates: { readonly keys: readonly K[]; readonly orderDirty: boolean };
  readonly cause?: Cause;
  readonly batch?: BatchContext;
};
export type DocumentHandle<S extends ObjectNode> = GraphSource<DocumentContext<S>> & {
  collection<P extends CollectionPath>(
    pick: (path: SchemaPath<S['shape']>) => P
  ): DocumentCollectionSource<S, SchemaCollectionNode<P>, CollectionId<P>>;
  targets(...targets: readonly [PathPick<S>, ...PathPick<S>[]]): GraphSource<DocumentContext<S>>;
};
export type DocumentCollectionSource<
  S extends ObjectNode,
  N extends ValueSchemaNode,
  K extends string = string,
> = GraphSource<DocumentCollectionContext<S, N, K>>;
export type ValueContext<T, D = unknown> = {
  readonly value: T;
  readonly previous: T;
  readonly changed: boolean;
  readonly revision: number;
  readonly reset: boolean;
  readonly detail?: D;
  readonly cause?: Cause;
  readonly batch?: BatchContext;
};
export type InputHandle<T> = {
  readonly source: GraphSource<ValueContext<T>>;
  set(value: T): void;
};
export type NodeUpdate<T> =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly value: T }
  | { readonly kind: 'rebuild' };
export type ValueNodeSpec<S extends GraphSources, T> = {
  readonly name?: string;
  readonly sources: S;
  readonly build: (sources: InputHandles<S>) => {
    readonly value: T;
    readonly update: (sources: InputHandles<S>) => NodeUpdate<NoInfer<T>>;
  };
};
export type ValueNode<T> = Readable<T> &
  GraphSource<ValueContext<T>> & { rebuild(): void; dispose(): void };
export type CollectionRead<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
};
export type ExternalCollectionRead<K extends string, V> = {
  readonly get: (key: K) => V | undefined;
  readonly has: (key: K) => boolean;
  readonly ids: () => readonly K[];
};
export type CollectionContext<K extends string, V, D = unknown> = CollectionRead<K, V> & {
  readonly previous: CollectionRead<K, V>;
  readonly change: CollectionImpact<K> | undefined;
  readonly revision: number;
  readonly reset: boolean;
  readonly transitions: (keys?: Iterable<K>) => readonly CollectionEntryTransition<K, V>[];
  readonly detail?: D;
  readonly cause?: Cause;
  readonly batch?: BatchContext;
};
export type CollectionHandle<K extends string, V> = {
  current(): CollectionRead<K, V>;
  readonly ids: Readable<readonly K[]>;
  readonly all: Readable<readonly V[]>;
  item(key: K): Readable<V | undefined>;
  revision(): number;
  subscribe(listener: (change: CollectionImpact<K>) => void): Unsubscribe;
};
export type CollectionNode<K extends string, V> = GraphSource<CollectionContext<K, V>> &
  CollectionHandle<K, V> & {
    rebuild(): void;
    dispose(): void;
  };
export type ExternalValueSource<T, D = unknown> = {
  readonly kind: 'value';
  current(): T;
  revision(): number;
  subscribe(listener: (event: ExternalValueEvent<T, D>) => void): Unsubscribe;
};
export type ExternalCollectionSource<K extends string, V, D = unknown> = {
  readonly kind: 'collection';
  current(): ExternalCollectionRead<K, V>;
  revision(): number;
  subscribe(listener: (event: ExternalCollectionEvent<K, V, D>) => void): Unsubscribe;
};
export type ExternalValueEvent<T, D = unknown> = {
  readonly value: T;
  readonly revision: number;
  readonly reset?: boolean;
  readonly detail?: D;
  readonly cause?: Cause;
  readonly batch?: { readonly id: number; readonly cause?: Cause };
};
export type ExternalCollectionEvent<K extends string, V, D = unknown> = {
  readonly previous: ExternalCollectionRead<K, V>;
  readonly revision: number;
  readonly reset?: boolean;
  readonly change?: CollectionImpact<K>;
  readonly detail?: D;
  readonly cause?: Cause;
  readonly batch?: { readonly id: number; readonly cause?: Cause };
};
export type CollectionDraft<K extends string, V> = {
  set(key: K, value: V): void;
  remove(key: K): void;
  order(ids: readonly K[]): void;
  replace(entries: readonly (readonly [K, V])[]): void;
};
export type CollectionProcess<S extends GraphSources, K extends string, V> = {
  readonly sources: InputHandles<S>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly writer: CollectionDraft<K, V>;
};
export type CollectionNodeSpec<S extends GraphSources, K extends string, V> = {
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
export type RuntimeExecutor = {
  document<S extends ObjectNode>(runtime: DocumentReadable<S>): DocumentHandle<S>;
  fromSource<T, D = unknown>(
    source: ExternalValueSource<T, D>,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): GraphSource<ValueContext<T, D>>;
  fromCollectionSource<K extends string, V, D = unknown>(
    source: ExternalCollectionSource<K, V, D>
  ): GraphSource<CollectionContext<K, V, D>>;
  fromReadable<T>(
    readable: Readable<T>,
    options?: { readonly isEqual?: (a: T, b: T) => boolean }
  ): GraphSource<ValueContext<T>>;
  input<T>(initial: T, options?: { readonly isEqual?: (a: T, b: T) => boolean }): InputHandle<T>;
  value<S extends GraphSources, T>(
    sources: S,
    compute: (sources: InputHandles<S>) => Synchronous<T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): ValueNode<T>;
  value<S extends GraphSources, T>(
    spec: ValueNodeSpec<S, T>,
    options?: { readonly isEqual?: (a: NoInfer<T>, b: NoInfer<T>) => boolean }
  ): ValueNode<T>;
  collection<V, K extends string = string>(): <S extends GraphSources>(
    spec: CollectionNodeSpec<S, K, V>
  ) => CollectionNode<K, V>;
  map<S extends ObjectNode, N extends ValueSchemaNode, K extends string, V>(
    source: DocumentCollectionSource<S, N, K>,
    mapper: (id: K, entry: Read<N>) => Synchronous<V>,
    options?: { readonly isEqual?: (a: V, b: V) => boolean }
  ): CollectionNode<K, V>;
  map<K extends string, V, R>(
    source: CollectionNode<K, V>,
    mapper: (id: K, entry: V) => Synchronous<R>,
    options?: { readonly isEqual?: (a: NoInfer<R>, b: NoInfer<R>) => boolean }
  ): CollectionNode<K, R>;
  batch<T>(run: () => Synchronous<T>): T;
  batch<T>(options: BatchOptions, run: () => Synchronous<T>): T;
  dispose(): void;
};
