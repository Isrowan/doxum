import type { DocumentSchema, ImpactTarget, ReadonlyDocument } from './schema';
import { contains, debugKey, overlaps, read as readAddress, resolveAddress } from './address';
import { createImpact } from './impact';
import { createHistory } from './history';
import { documentReader } from './access/reader';
import { documentWriter } from './access/writer';
import { createMutationSession, mutateOperations } from './mutation/session';
import type { MutationBatch } from './mutation/contract';
import * as issue from './mutation/issue';
import * as tree from './mutation/tree';
import { cloneValue, deepEqual } from './value/ownership';
import { profile } from './profile';
import { DocumentDisposedError, DocumentReentrancyError } from './runtime/contract';
import type {
  CommitListener,
  CommitSource,
  DocumentCommit,
  DocumentDiagnostic,
  DocumentProblem,
  DocumentRuntime,
  DocumentTransaction,
  OperationResult,
  TransactionResult,
} from './runtime/contract';
import { bindRuntimeAccess } from './runtime/access';
import {
  createNotification,
  disposeNotification,
  notify,
  subscribeRoot,
  subscribeTargets,
  type RuntimeNotification,
} from './runtime/notification';

class RejectedUpdate extends Error {
  readonly issues: readonly DocumentProblem[];

  constructor(issues: readonly DocumentProblem[]) {
    super('Document update rejected.');
    this.issues = Object.freeze(issues.slice());
  }
}

const EMPTY: readonly never[] = Object.freeze([]) as readonly never[];

const publishDiagnostic = (value: DocumentDiagnostic): DocumentDiagnostic =>
  Object.freeze({
    ...value,
    ...(value.address === undefined ? {} : { address: Object.freeze(value.address.slice()) }),
  });

export const createDocument = <TSchema extends DocumentSchema>(input: {
  readonly schema: TSchema;
  readonly initial: ReadonlyDocument<TSchema>;
  readonly history?: { readonly capacity?: number } | false;
}): DocumentRuntime<TSchema> => {
  const initialTreeError = tree.invalidDocument(input.schema, input.initial);
  if (initialTreeError)
    throw new TypeError(
      `Initial document contains an invalid tree at '${initialTreeError.join('.')}'.`
    );
  profile.clone.initialDocument();
  const state = {
    schema: input.schema,
    document: cloneValue(input.initial, 'initial'),
    disposed: false,
  };
  let revision = 0;
  let busy = false;
  let runtime!: DocumentRuntime<TSchema>;
  let notification!: RuntimeNotification<TSchema>;

  const assertWritable = (): void => {
    if (state.disposed) throw new DocumentDisposedError();
    if (busy) throw new DocumentReentrancyError();
  };

  const history = createHistory<DocumentCommit<TSchema>>({
    capacity: input.history === false ? 0 : Math.max(0, input.history?.capacity ?? 100),
    revision: () => revision,
    apply: operations => applyBatch(operations, 'history', false),
  });

  const publish = (
    batch: Extract<MutationBatch<TSchema>, { readonly status: 'changed' }>,
    source: CommitSource,
    kind: 'operations' | 'replace',
    recordHistory: boolean
  ): Extract<OperationResult<DocumentCommit<TSchema>>, { readonly status: 'committed' }> => {
    revision += 1;
    const commit: DocumentCommit<TSchema> = Object.freeze({
      revision,
      kind,
      source,
      operations: batch.operations,
      inverse: batch.inverse,
      impact: createImpact({
        schema: input.schema,
        operations: batch.operations,
        paths: batch.paths,
        collections: batch.collections,
        reset: kind === 'replace',
      }),
    });
    if (kind === 'replace' || source === 'remote') history.invalidate();
    else if (recordHistory && (source === 'local' || source === 'system'))
      history.record(batch.operations, batch.inverse);
    busy = true;
    let observerErrors;
    try {
      observerErrors = notify(notification, commit);
    } finally {
      busy = false;
    }
    return { status: 'committed', commit, observerErrors };
  };

  function applyBatch(
    operations: unknown,
    source: CommitSource,
    recordHistory: boolean
  ): OperationResult<DocumentCommit<TSchema>> {
    assertWritable();
    const batch = mutateOperations(state.document, input.schema, operations, {
      copyPayload: source === 'history',
    });
    if (batch.status === 'rejected') return { status: 'rejected', issues: batch.issues, revision };
    if (batch.status === 'unchanged') return { status: 'unchanged', revision };
    return publish(batch, source, 'operations', recordHistory);
  }

  runtime = {
    address: {
      resolve: address => resolveAddress(input.schema, address, state.document),
      read: address => readAddress(state.document, address),
      contains,
      overlaps,
      debugKey,
    },
    revision: () => revision,
    update: <TResult>(
      run: (transaction: DocumentTransaction<TSchema>) => TResult,
      options?: {
        readonly source?: Extract<CommitSource, 'local' | 'system'>;
        readonly history?: boolean;
      }
    ): TransactionResult<TResult, DocumentCommit<TSchema>> => {
      assertWritable();
      busy = true;
      const session = createMutationSession(state.document, input.schema);
      let reports: DocumentDiagnostic[] | undefined;
      let active = true;
      const transaction: DocumentTransaction<TSchema> = {
        read: documentReader(
          input.schema,
          () => state.document,
          () => active
        ),
        write: documentWriter(input.schema, operation => {
          if (!active) throw new Error('Document writer is no longer active.');
          const rejected = session.apply(operation);
          if (rejected) throw new RejectedUpdate([rejected]);
        }),
        reject: diagnostic => {
          throw new RejectedUpdate(
            (Array.isArray(diagnostic) ? diagnostic : [diagnostic]).map(entry =>
              publishDiagnostic(entry)
            )
          );
        },
        report: diagnostic => {
          if (!active) throw new Error('Document transaction is no longer active.');
          (reports ??= []).push(publishDiagnostic(diagnostic));
        },
      };
      try {
        const value = run(transaction);
        if (
          value !== null &&
          typeof value === 'object' &&
          typeof (value as { then?: unknown }).then === 'function'
        )
          throw new TypeError('Document update callback must be synchronous.');
        active = false;
        busy = false;
        const batch = session.finish();
        if (batch.status === 'unchanged')
          return {
            status: 'unchanged',
            value,
            revision,
            reports: Object.freeze(reports ?? EMPTY),
          };
        if (batch.status === 'rejected')
          return { status: 'rejected', issues: batch.issues, revision };
        const result = publish(
          batch,
          options?.source ?? 'local',
          'operations',
          options?.history ?? true
        );
        return {
          status: 'committed',
          value,
          commit: result.commit,
          reports: Object.freeze(reports ?? EMPTY),
          observerErrors: result.observerErrors,
        };
      } catch (error) {
        active = false;
        try {
          session.rollback();
        } finally {
          busy = false;
        }
        if (error instanceof RejectedUpdate)
          return { status: 'rejected', issues: error.issues, revision };
        throw error;
      } finally {
        active = false;
        busy = false;
      }
    },
    apply: (operations, options) =>
      applyBatch(operations, options?.source ?? 'local', options?.history ?? true),
    replace: (document, options) => {
      assertWritable();
      const invalidTree = tree.invalidDocument(input.schema, document);
      if (invalidTree)
        return {
          status: 'rejected',
          issues: [
            issue.at(invalidTree, 'invalid-tree', 'Document replacement contains an invalid tree.'),
          ],
          revision,
        };
      if (deepEqual(state.document, document)) return { status: 'unchanged', revision };
      state.document = cloneValue(document, 'replace');
      const batch: Extract<MutationBatch<TSchema>, { readonly status: 'changed' }> = {
        status: 'changed',
        operations: EMPTY,
        inverse: EMPTY,
        paths: EMPTY,
        collections: EMPTY,
      };
      return publish(batch, options?.source ?? 'system', 'replace', false);
    },
    subscribe: ((
      targetOrListener:
        ImpactTarget<unknown> | readonly ImpactTarget<unknown>[] | CommitListener<TSchema>,
      listener?: CommitListener<TSchema>
    ) => {
      if (state.disposed) throw new DocumentDisposedError();
      if (typeof targetOrListener === 'function')
        return subscribeRoot(notification, targetOrListener);
      const targets = Array.isArray(targetOrListener)
        ? targetOrListener
        : [targetOrListener as ImpactTarget<unknown>];
      if (targets.length === 0 || !listener)
        throw new TypeError('Filtered subscribe requires at least one target and a listener.');
      return subscribeTargets(notification, targets, listener);
    }) as DocumentRuntime<TSchema>['subscribe'],
    history: history.api,
    dispose: () => {
      if (state.disposed) return;
      state.disposed = true;
      disposeNotification(notification);
      history.api.clear();
    },
  };

  bindRuntimeAccess(runtime, state);
  notification = createNotification(runtime);
  return runtime;
};
