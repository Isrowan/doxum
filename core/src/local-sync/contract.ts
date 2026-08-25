import type { DocumentSchema, ReadonlyDocument } from '../schema';
import type {
  DocumentCommit,
  DocumentReadable,
  DocumentTransaction,
  OperationResult,
  TransactionResult,
} from '../runtime/contract';
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

export class LocalSyncDisposedError extends Error {
  constructor() {
    super('Local sync document has been disposed.');
    this.name = 'LocalSyncDisposedError';
  }
}

export type LocalSyncCommit<TSchema extends DocumentSchema> = DocumentCommit<TSchema> & {
  readonly seq: number;
  readonly commandId: string;
  readonly actorId: string;
};

export type LocalSyncState =
  | { readonly status: 'ready'; readonly headSeq: number; readonly checkpointSeq: number }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'disposed' };

export type LocalSyncDocument<TSchema extends DocumentSchema> = {
  readonly document: DocumentReadable<TSchema>;
  state(): LocalSyncState;
  sync(): Promise<void>;
  update<TResult>(
    run: (transaction: DocumentTransaction<TSchema>) => TResult
  ): Promise<TransactionResult<TResult, LocalSyncCommit<TSchema>>>;
  undo(): Promise<OperationResult<LocalSyncCommit<TSchema>>>;
  redo(): Promise<OperationResult<LocalSyncCommit<TSchema>>>;
  dispose(): Promise<void>;
};

export type OpenLocalDocumentOptions<TSchema extends DocumentSchema> = {
  readonly database: string;
  readonly documentId: string;
  readonly schema: TSchema;
  readonly initial: ReadonlyDocument<TSchema>;
  readonly schemaVersion?: number;
  readonly actorId?: string;
  readonly historyCapacity?: number;
  readonly checkpointEvery?: number;
  readonly commandLimits?: JsonCommandLimits;
  readonly onError?: (error: unknown) => void;
};
