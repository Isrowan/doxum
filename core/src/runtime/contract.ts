import type { DocumentAddress, ObjectNode, PathPick, Infer } from '../schema';
import type { AddressRef } from '../address';
import type { ChangeSet } from '../changes';
import type { DocumentImpact } from '../impact';
import type { Draft } from '../access/scope';
import type { MutationIssue } from '../mutation/issue';
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
export type DiagnosticInput = {
  readonly code: string;
  readonly message: string;
  readonly address?: DocumentAddress;
};
export type DocumentDiagnostic = DiagnosticInput & { readonly source: 'application' };
export type DocumentProblem = DocumentDiagnostic | MutationIssue;
export class TransactionRejected extends Error {
  readonly issues: readonly DocumentDiagnostic[];
  constructor(input: DiagnosticInput | readonly DiagnosticInput[]) {
    super('Document update rejected.');
    this.name = 'TransactionRejected';
    const issues: readonly DiagnosticInput[] = Array.isArray(input)
      ? input
      : [input as DiagnosticInput];
    this.issues = Object.freeze(
      issues.map(issue =>
        Object.freeze({
          code: issue.code,
          message: issue.message,
          source: 'application' as const,
          ...(issue.address === undefined ? {} : { address: Object.freeze([...issue.address]) }),
        })
      )
    );
  }
}
export type DocumentCommit<S extends ObjectNode> = {
  readonly revision: number;
  readonly source: CommitSource;
  readonly changes: ChangeSet;
  readonly impact: DocumentImpact<S>;
};
export type ObserverError = {
  readonly phase: 'processor' | 'flush' | 'listener';
  readonly error: unknown;
};
export type TransactionResult<V, C> =
  | {
      readonly status: 'committed';
      readonly value: V;
      readonly commit: C;
      readonly observerErrors: readonly ObserverError[];
    }
  | { readonly status: 'unchanged'; readonly value: V; readonly revision: number }
  | {
      readonly status: 'rejected';
      readonly issues: readonly DocumentProblem[];
      readonly revision: number;
    };
export type OperationResult<C> =
  | {
      readonly status: 'committed';
      readonly commit: C;
      readonly observerErrors: readonly ObserverError[];
    }
  | { readonly status: 'unchanged'; readonly revision: number }
  | {
      readonly status: 'rejected';
      readonly issues: readonly MutationIssue[];
      readonly revision: number;
    };
export type HistoryState = { readonly undoDepth: number; readonly redoDepth: number };
export type LocalHistory<C> = Readable<HistoryState> & {
  undo(): OperationResult<C>;
  redo(): OperationResult<C>;
  clear(): void;
  group(): { end(): void; cancel(): OperationResult<C> };
};
export type CommitListener<S extends ObjectNode> = (commit: DocumentCommit<S>) => void;
export type DocumentReadable<S extends ObjectNode> = {
  readonly address: {
    resolve(address: DocumentAddress): AddressRef | undefined;
    read(address: DocumentAddress): unknown;
    contains(parent: DocumentAddress, child: DocumentAddress): boolean;
    overlaps(left: DocumentAddress, right: DocumentAddress): boolean;
    debugKey(address: DocumentAddress): string;
  };
  revision(): number;
  subscribe(listener: CommitListener<S>): Unsubscribe;
  subscribe(
    pick: PathPick<S> | readonly [PathPick<S>, ...PathPick<S>[]],
    listener: CommitListener<S>
  ): Unsubscribe;
};
export type DocumentRuntime<S extends ObjectNode> = DocumentReadable<S> & {
  readonly schema: S;
  update<V>(
    run: (draft: Draft<S>) => Synchronous<V>,
    options?: {
      readonly source?: Extract<CommitSource, 'local' | 'system'>;
      readonly history?: boolean;
    }
  ): TransactionResult<V, DocumentCommit<S>>;
  apply(
    changes: unknown,
    options: {
      readonly expectedRevision: number;
      readonly source?: Exclude<CommitSource, 'history'>;
      readonly history?: boolean;
    }
  ): OperationResult<DocumentCommit<S>>;
  replace(
    value: Infer<S>,
    options?: { readonly source?: Extract<CommitSource, 'system' | 'remote'> }
  ): OperationResult<DocumentCommit<S>>;
  snapshot(): Infer<S>;
  readonly history: LocalHistory<DocumentCommit<S>>;
  dispose(): void;
};
