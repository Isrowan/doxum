import type { Read } from '../access/scope';
import type { CollectionImpact } from '../impact';
import type { DocumentReadable, Unsubscribe } from '../runtime/contract';
import type {
  CollectionNode as SchemaCollectionNode,
  CollectionId,
  CollectionPath,
  ObjectNode,
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

/** Scheduler-owned metadata for one Runtime batch. */
export type BatchContext = {
  readonly id: number;
  readonly cause?: unknown;
};

/** The one processor-facing collection transition protocol. */
export type CollectionChange<K extends string, V> =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'incremental';
      readonly added: readonly { readonly key: K; readonly after: V }[];
      readonly updated: readonly {
        readonly key: K;
        readonly before: V;
        readonly after: V;
      }[];
      readonly removed: readonly { readonly key: K; readonly before: V }[];
      readonly order?: {
        readonly before: readonly K[];
        readonly after: readonly K[];
      };
    };

export type DocumentContext<S extends ObjectNode> = {
  readonly kind: 'document';
  readonly read: Read<S>;
  readonly revision: number;
  readonly reset: boolean;
  readonly cause?: unknown;
};

export type DocumentHandle<S extends ObjectNode> = GraphSource<DocumentContext<S>> & {
  collection<P extends CollectionPath>(
    pick: (path: SchemaPath<S['shape']>) => P
  ): GraphSource<CollectionContext<CollectionId<P>, Read<SchemaCollectionNode<P>>>>;
  targets(...targets: readonly [PathPick<S>, ...PathPick<S>[]]): GraphSource<DocumentContext<S>>;
};

export type ValueContext<T> = {
  readonly kind: 'value';
  readonly value: T;
  readonly revision: number;
  readonly reset: boolean;
  readonly cause?: unknown;
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

export type ValueNode<T> = Readable<T> & GraphSource<ValueContext<T>> & { readonly kind: 'value' };

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

export type CollectionContext<K extends string, V> = {
  readonly kind: 'collection';
  readonly read: CollectionRead<K, V>;
  readonly change: CollectionChange<K, V> | undefined;
  readonly revision: number;
  readonly cause?: unknown;
};

export type CollectionNode<K extends string, V> = GraphSource<CollectionContext<K, V>> & {
  readonly kind: 'collection';
  current(): CollectionRead<K, V>;
  revision(): number;
  subscribe(listener: (change: CollectionChange<K, V>) => void): Unsubscribe;
};

export type ExternalValueSource<T> = {
  readonly kind: 'value';
  current(): T;
  revision(): number;
  subscribe(listener: (event: ExternalValueEvent<T>) => void): Unsubscribe;
};

export type ExternalCollectionSource<K extends string, V> = {
  readonly kind: 'collection';
  current(): ExternalCollectionRead<K, V>;
  revision(): number;
  subscribe(listener: (event: ExternalCollectionEvent<K, V>) => void): Unsubscribe;
};

export type ExternalValueEvent<T> = {
  readonly value: T;
  readonly revision: number;
  readonly reset?: boolean;
  readonly cause?: unknown;
};

export type ExternalCollectionEvent<K extends string, V> = {
  /** Stable read from the source before this event or external batch. */
  readonly previous: ExternalCollectionRead<K, V>;
  readonly revision: number;
  /** Optional document-style hint; the adapter resolves the canonical change. */
  readonly impact?: CollectionImpact<K>;
  readonly cause?: unknown;
};

export type CollectionDraft<K extends string, V> = {
  set(key: K, value: V): void;
  remove(key: K): void;
  order(ids: readonly K[]): void;
};

export type CollectionProcess<S extends GraphSources, K extends string, V> = {
  readonly sources: InputHandles<S>;
  readonly previous: CollectionRead<K, V>;
  readonly next: CollectionRead<K, V>;
  readonly output: CollectionDraft<K, V>;
};

export type CollectionNodeSpec<S extends GraphSources, K extends string, V> = {
  readonly name?: string;
  readonly sources: S;
  readonly isEqual?: (previous: V, next: V) => boolean;
  readonly build: (input: CollectionProcess<S, K, V>) => {
    readonly update: (input: CollectionProcess<S, K, V>) => void | { readonly kind: 'rebuild' };
  };
};

export type GroupOutputSpec =
  | {
      readonly kind: 'value';
      readonly path: readonly string[];
      readonly isEqual?: (previous: unknown, next: unknown) => boolean;
    }
  | {
      readonly kind: 'collection';
      readonly path: readonly string[];
      readonly isEqual?: (previous: unknown, next: unknown) => boolean;
    };

export type GroupProcess = {
  readonly sources: Record<string, unknown>;
  readonly previous: readonly unknown[];
  readonly next: readonly (() => unknown)[];
  readonly outputs: readonly unknown[];
};

/** Internal graph boundary for one atomic multi-output processor. */
export type GroupSpec = {
  readonly sources: GraphSources;
  readonly outputs: readonly GroupOutputSpec[];
  readonly build: (input: GroupProcess) => {
    readonly update: (input: GroupProcess) => void | { readonly kind: 'rebuild' };
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
