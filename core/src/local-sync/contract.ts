import type { DocumentSchema } from '../schema';
import type { DocumentRuntime } from '../runtime/contract';
import type { JsonCommandLimits } from './json';

export class LocalSyncUnavailableError extends Error {
  constructor(capability: 'IndexedDB' | 'Web Locks' | 'BroadcastChannel') {
    super(`${capability} is required by doxum/local-sync in this environment.`);
    this.name = 'LocalSyncUnavailableError';
  }
}

export class LocalSyncSchemaError extends Error {
  constructor(documentId: string, expected: number, actual: number) {
    super(
      `Local document '${documentId}' uses schema version ${actual}, but version ${expected} was requested.`
    );
    this.name = 'LocalSyncSchemaError';
  }
}

export class LocalSyncConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSyncConsistencyError';
  }
}

export class LocalSyncReadOnlyError extends Error {
  constructor() {
    super('This tab is following the local document and cannot write until it becomes the leader.');
    this.name = 'LocalSyncReadOnlyError';
  }
}

export class LocalSyncUnsupportedOperationError extends Error {
  constructor() {
    super(
      'Local sync persists operation commands. runtime.replace() and externally supplied remote operations are unavailable while it is attached.'
    );
    this.name = 'LocalSyncUnsupportedOperationError';
  }
}

export class LocalSyncDisposedError extends Error {
  constructor() {
    super('Local sync has been disposed.');
    this.name = 'LocalSyncDisposedError';
  }
}

export type LocalSyncState =
  | {
      readonly status: 'leader' | 'follower';
      readonly headSeq: number;
      readonly checkpointSeq: number;
    }
  | {
      readonly status: 'error';
      readonly headSeq: number;
      readonly checkpointSeq: number;
      readonly error: unknown;
    }
  | { readonly status: 'disposed' };

export type LocalSync = {
  state(): LocalSyncState;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export type AttachLocalSyncOptions<TSchema extends DocumentSchema> = {
  readonly runtime: DocumentRuntime<TSchema>;
  readonly database: string;
  readonly documentId: string;
  readonly schemaVersion?: number;
  readonly commandLimits?: JsonCommandLimits;
  readonly onError?: (error: unknown) => void;
};
