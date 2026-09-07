import type { DocumentAddress, DocumentSchema, ImpactTarget, ReadonlyDocument } from '../schema';
import type { AddressRef } from '../address';
import type { DocumentOperation } from '../operations';
import type { DocumentImpact } from '../impact';
import type { DocumentReader } from '../access/reader';
import type { DocumentWriter } from '../access/writer';
import type { MutationIssue } from '../mutation/issue';
import type { CommandFootprint } from '../mutation/footprint';
import type { Readable } from '../projection/readable';

export type Unsubscribe = () => void;
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;
export type CommitSource = 'local' | 'system' | 'history' | 'remote';

export class DocumentReentrancyError extends Error {
  constructor() {
    super('Document writes cannot be re-entered during an update or notification.');
    this.name = 'DocumentReentrancyError';
  }
}

export class DocumentDisposedError extends Error {
  constructor() {
    super('Doxum runtime has been disposed.');
    this.name = 'DocumentDisposedError';
  }
}
export type DocumentCommit<TSchema extends DocumentSchema> = {
  readonly revision: number;
  readonly kind: 'operations' | 'replace';
  readonly source: CommitSource;
  readonly operations: readonly DocumentOperation[];
  readonly inverse: readonly DocumentOperation[];
  readonly impact: DocumentImpact<TSchema>;
};
export type DiagnosticInput = {
  readonly code: string;
  readonly message: string;
  readonly address?: DocumentAddress;
};
export type DocumentDiagnostic = DiagnosticInput & { readonly source: 'application' };
export type DocumentProblem = DocumentDiagnostic | MutationIssue;
export type ObserverError = {
  readonly phase: 'processor' | 'flush' | 'listener';
  readonly error: unknown;
};
export type TransactionResult<TValue, TCommit> =
  | {
      readonly status: 'committed';
      readonly value: TValue;
      readonly commit: TCommit;
      readonly reports: readonly DocumentDiagnostic[];
      readonly observerErrors: readonly ObserverError[];
    }
  | {
      readonly status: 'unchanged';
      readonly value: TValue;
      readonly revision: number;
      readonly reports: readonly DocumentDiagnostic[];
    }
  | {
      readonly status: 'rejected';
      readonly issues: readonly DocumentProblem[];
      readonly revision: number;
    };
export type PreparedUpdateResult<TValue, TSchema extends DocumentSchema> =
  | {
      readonly status: 'prepared';
      readonly value: TValue;
      readonly operations: readonly DocumentOperation[];
      readonly inverse: readonly DocumentOperation[];
      readonly impact: DocumentImpact<TSchema>;
      readonly footprint: CommandFootprint;
      readonly reports: readonly DocumentDiagnostic[];
    }
  | {
      readonly status: 'unchanged';
      readonly value: TValue;
      readonly reports: readonly DocumentDiagnostic[];
    }
  | {
      readonly status: 'rejected';
      readonly issues: readonly DocumentProblem[];
    };
export type OperationResult<TCommit> =
  | {
      readonly status: 'committed';
      readonly commit: TCommit;
      readonly observerErrors: readonly ObserverError[];
    }
  | { readonly status: 'unchanged'; readonly revision: number }
  | {
      readonly status: 'rejected';
      readonly issues: readonly MutationIssue[];
      readonly revision: number;
    };

export type HistoryState = {
  readonly undoDepth: number;
  readonly redoDepth: number;
};
export type LocalHistory<TCommit> = Readable<HistoryState> & {
  undo(): OperationResult<TCommit>;
  redo(): OperationResult<TCommit>;
  clear(): void;
  group(): { end(): void; cancel(): OperationResult<TCommit> };
};

export type DocumentTransaction<TSchema extends DocumentSchema> = {
  readonly read: DocumentReader<TSchema>;
  readonly write: DocumentWriter<TSchema>;
  readonly reject: (issue: DiagnosticInput | readonly DiagnosticInput[]) => never;
  readonly report: (issue: DiagnosticInput) => void;
};
export type CommitListener<TSchema extends DocumentSchema> = (
  commit: DocumentCommit<TSchema>
) => void;

export type DocumentReadable<TSchema extends DocumentSchema> = {
  readonly address: {
    readonly resolve: (address: DocumentAddress) => AddressRef | undefined;
    readonly read: (address: DocumentAddress) => unknown;
    readonly contains: (parent: DocumentAddress, child: DocumentAddress) => boolean;
    readonly overlaps: (left: DocumentAddress, right: DocumentAddress) => boolean;
    readonly debugKey: (address: DocumentAddress) => string;
  };
  revision(): number;
  subscribe(listener: CommitListener<TSchema>): Unsubscribe;
  subscribe(
    target: ImpactTarget<unknown> | readonly [ImpactTarget<unknown>, ...ImpactTarget<unknown>[]],
    listener: CommitListener<TSchema>
  ): Unsubscribe;
};

export type DocumentRuntime<TSchema extends DocumentSchema> = DocumentReadable<TSchema> & {
  /** Schema configuration captured when this runtime was created. */
  readonly schema: TSchema;
  update<TResult>(
    run: (transaction: DocumentTransaction<TSchema>) => Synchronous<TResult>,
    options?: {
      readonly source?: Extract<CommitSource, 'local' | 'system'>;
      readonly history?: boolean;
    }
  ): TransactionResult<TResult, DocumentCommit<TSchema>>;
  prepare<TResult>(
    run: (transaction: DocumentTransaction<TSchema>) => Synchronous<TResult>
  ): PreparedUpdateResult<TResult, TSchema>;
  apply(
    operations: unknown,
    options?: {
      readonly source?: Exclude<CommitSource, 'history'>;
      readonly history?: boolean;
    }
  ): OperationResult<DocumentCommit<TSchema>>;
  replace(
    document: ReadonlyDocument<TSchema>,
    options?: { readonly source?: Extract<CommitSource, 'system' | 'remote'> }
  ): OperationResult<DocumentCommit<TSchema>>;
  snapshot(): ReadonlyDocument<TSchema>;
  readonly history: LocalHistory<DocumentCommit<TSchema>>;
  dispose(): void;
};
