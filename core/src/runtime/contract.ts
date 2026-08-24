import type { DocumentAddress, DocumentSchema, ImpactTarget, ReadonlyDocument } from '../schema';
import type { AddressRef } from '../address';
import type { DocumentOperationUnion } from '../operations';
import type { DocumentImpact } from '../impact';
import type { DocumentReader } from '../access/reader';
import type { DocumentWriter } from '../access/writer';
import type { MutationIssue } from '../mutation/issue';

export type Unsubscribe = () => void;
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
  readonly operations: readonly DocumentOperationUnion<TSchema>[];
  readonly inverse: readonly DocumentOperationUnion<TSchema>[];
  readonly impact: DocumentImpact<TSchema>;
};
export type DocumentDiagnostic = {
  readonly source: 'application';
  readonly code: string;
  readonly message: string;
  readonly address?: DocumentAddress;
};
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
export type LocalHistory<TCommit> = {
  current(): HistoryState;
  subscribe(listener: () => void): Unsubscribe;
  undo(): OperationResult<TCommit>;
  redo(): OperationResult<TCommit>;
  clear(): void;
};

export type DocumentTransaction<TSchema extends DocumentSchema> = {
  readonly read: DocumentReader<TSchema>;
  readonly write: DocumentWriter<TSchema>;
  readonly reject: (issue: DocumentDiagnostic | readonly DocumentDiagnostic[]) => never;
  readonly report: (issue: DocumentDiagnostic) => void;
};
export type CommitListener<TSchema extends DocumentSchema> = (
  commit: DocumentCommit<TSchema>
) => void;
export type RuntimeProcessor<TSchema extends DocumentSchema> = {
  readonly process: (commit: DocumentCommit<TSchema>) => void;
  readonly flush: () => void;
};

export type DocumentRuntime<TSchema extends DocumentSchema> = {
  readonly address: {
    readonly resolve: (address: DocumentAddress) => AddressRef | undefined;
    readonly read: (address: DocumentAddress) => unknown;
    readonly contains: (parent: DocumentAddress, child: DocumentAddress) => boolean;
    readonly overlaps: (left: DocumentAddress, right: DocumentAddress) => boolean;
    readonly debugKey: (address: DocumentAddress) => string;
  };
  revision(): number;
  update<TResult>(
    run: (transaction: DocumentTransaction<TSchema>) => TResult,
    options?: {
      readonly source?: Extract<CommitSource, 'local' | 'system'>;
      readonly history?: boolean;
    }
  ): TransactionResult<TResult, DocumentCommit<TSchema>>;
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
  subscribe(listener: CommitListener<TSchema>): Unsubscribe;
  subscribe(
    target: ImpactTarget<unknown> | readonly [ImpactTarget<unknown>, ...ImpactTarget<unknown>[]],
    listener: CommitListener<TSchema>
  ): Unsubscribe;
  readonly history: LocalHistory<DocumentCommit<TSchema>>;
  dispose(): void;
};
