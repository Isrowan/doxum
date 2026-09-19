import type { CollectionImpact } from '../impact';
import type { Unsubscribe } from '../runtime/contract';

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

export type ValueContext<T> = {
  readonly kind: 'value';
  readonly value: T;
  readonly revision: number;
  readonly reset: boolean;
  readonly cause?: unknown;
};

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
  readonly reset: boolean;
  readonly cause?: unknown;
};

export type SourceContext = ValueContext<unknown> | CollectionContext<string, unknown>;

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

export class ProjectionError extends Error {
  readonly cause: unknown;

  constructor(
    readonly phase: 'processor' | 'listener' | 'source' | 'blocked',
    cause: unknown
  ) {
    super(`Projection ${phase} failed.`, { cause });
    this.name = 'ProjectionError';
    this.cause = cause;
  }
}

export class ProjectionDisposedError extends Error {
  constructor() {
    super('Projection has been disposed.');
    this.name = 'ProjectionDisposedError';
  }
}
