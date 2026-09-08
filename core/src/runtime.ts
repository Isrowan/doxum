import type { DocumentSchema, ImpactTarget, Infer } from './schema';
import { contains, debugKey, overlaps, read as readAddress, resolveAddress } from './address';
import { createImpact } from './impact';
import { createHistory } from './history';
import { documentReader } from './access/reader';
import { documentWriter } from './access/writer';
import { createMutationSession, mutateOperations, type MutationSession } from './mutation/session';
import type { MutationBatch } from './mutation/contract';
import * as issue from './mutation/issue';
import { commandFootprint } from './mutation/footprint';
import { cloneValue, deepEqual } from './value/ownership';
import { checkValue, ParseError, snapshotValue } from './schema-value';
import { profile } from './profile';
import { DocumentDisposedError, DocumentReentrancyError } from './runtime/contract';
import type {
  CommitListener,
  CommitSource,
  DocumentCommit,
  DocumentDiagnostic,
  DiagnosticInput,
  DocumentProblem,
  DocumentRuntime,
  DocumentTransaction,
  OperationResult,
  PreparedUpdateResult,
  TransactionResult,
} from './runtime/contract';
import { bindRuntimeAccess, accessOf } from './runtime/access';
import { assertRuntimeWritable, bindRuntimeDriver, disposeRuntimeDriver } from './runtime/driver';
import {
  bindDocumentReadable,
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

const publishDiagnostic = (value: DiagnosticInput): DocumentDiagnostic =>
  Object.freeze({
    ...value,
    source: 'application',
    ...(value.address === undefined ? {} : { address: Object.freeze(value.address.slice()) }),
  });

export const createDocument = <TSchema extends DocumentSchema>(input: {
  readonly schema: TSchema;
  readonly initial: Infer<TSchema>;
  readonly history?: { readonly capacity?: number } | false;
}): DocumentRuntime<TSchema> => {
  const rootNode = { kind: 'object', shape: input.schema.shape } as const;
  const initialError = checkValue(rootNode, input.initial);
  if (initialError) throw new ParseError(initialError);
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

  const assertWritable = (intent: Parameters<typeof assertRuntimeWritable>[1]): void => {
    if (state.disposed) throw new DocumentDisposedError();
    if (busy) throw new DocumentReentrancyError();
    if (accessOf(runtime).projectionLocks) throw new DocumentReentrancyError();
    assertRuntimeWritable(runtime, intent);
  };

  const runTransaction = <TResult>(
    session: MutationSession<TSchema>,
    run: (transaction: DocumentTransaction<TSchema>) => TResult
  ): { readonly value: TResult; readonly reports: readonly DocumentDiagnostic[] } => {
    let reports: DocumentDiagnostic[] | undefined;
    let active = true;
    const transaction: DocumentTransaction<TSchema> = {
      read: documentReader(
        input.schema,
        () => state.document,
        () => active
      ),
      write: documentWriter(input.schema, {
        set: (address, value) => {
          if (!active) throw new Error('Document writer is no longer active.');
          const rejected = session.set(address, value);
          if (rejected) throw new RejectedUpdate([rejected]);
        },
        apply: operation => {
          if (!active) throw new Error('Document writer is no longer active.');
          const rejected = session.apply(operation);
          if (rejected) throw new RejectedUpdate([rejected]);
        },
        update: (address, transform) => {
          if (!active) throw new Error('Document writer is no longer active.');
          const rejected = session.update(address, transform);
          if (rejected) throw new RejectedUpdate([rejected]);
        },
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
      return {
        value,
        reports: Object.freeze(reports ? reports.slice() : EMPTY),
      };
    } finally {
      active = false;
    }
  };

  const impactFor = (
    batch: Extract<MutationBatch<TSchema>, { readonly status: 'changed' }>,
    kind: 'operations' | 'replace'
  ) =>
    createImpact({
      schema: input.schema,
      operations: batch.operations,
      paths: batch.paths,
      collections: batch.collections,
      reset: kind === 'replace',
    });

  const history = createHistory<DocumentCommit<TSchema>>({
    capacity: input.history === false ? 0 : Math.max(0, input.history?.capacity ?? 100),
    revision: () => revision,
    apply: operations => applyBatch(operations, 'history', false),
    assertIdle: () => {
      if (state.disposed) throw new DocumentDisposedError();
      if (busy || accessOf(runtime).projectionLocks) throw new DocumentReentrancyError();
    },
    notify: run => {
      busy = true;
      try {
        return run();
      } finally {
        busy = false;
      }
    },
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
      impact: impactFor(batch, kind),
    });
    if (kind === 'replace' || source === 'remote') history.invalidate();
    else if (recordHistory && (source === 'local' || source === 'system'))
      history.record(batch.operations, batch.inverse);
    else if (source === 'history') history.publish();
    else history.endGroup();
    busy = true;
    let observerErrors;
    try {
      observerErrors = notify(notification, commit, history.flush);
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
    assertWritable({ kind: 'apply', source });
    const batch = mutateOperations(state.document, input.schema, operations, {
      copyPayload: source === 'history',
    });
    if (batch.status === 'rejected') return { status: 'rejected', issues: batch.issues, revision };
    if (batch.status === 'unchanged') return { status: 'unchanged', revision };
    return publish(batch, source, 'operations', recordHistory);
  }

  runtime = {
    schema: input.schema,
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
      const source = options?.source ?? 'local';
      assertWritable({ kind: 'update', source });
      busy = true;
      const session = createMutationSession(state.document, input.schema);
      let committed = false;
      try {
        const { value, reports } = runTransaction(session, run);
        const batch = session.finish();
        if (batch.status === 'unchanged')
          return {
            status: 'unchanged',
            value,
            revision,
            reports,
          };
        if (batch.status === 'rejected')
          return { status: 'rejected', issues: batch.issues, revision };
        const result = publish(batch, source, 'operations', options?.history ?? true);
        committed = true;
        return {
          status: 'committed',
          value,
          commit: result.commit,
          reports,
          observerErrors: result.observerErrors,
        };
      } catch (error) {
        try {
          if (!committed) session.rollback();
        } finally {
          busy = false;
        }
        if (error instanceof RejectedUpdate)
          return { status: 'rejected', issues: error.issues, revision };
        throw error;
      } finally {
        busy = false;
      }
    },
    prepare: <TResult>(
      run: (transaction: DocumentTransaction<TSchema>) => TResult
    ): PreparedUpdateResult<TResult, TSchema> => {
      assertWritable({ kind: 'prepare' });
      busy = true;
      const session = createMutationSession(state.document, input.schema);
      try {
        const { value, reports } = runTransaction(session, run);
        const batch = session.finish();
        if (batch.status === 'unchanged') {
          session.rollback();
          return { status: 'unchanged', value, reports };
        }
        if (batch.status === 'rejected') {
          session.rollback();
          return { status: 'rejected', issues: batch.issues };
        }
        const impact = impactFor(batch, 'operations');
        session.rollback();
        return {
          status: 'prepared',
          value,
          operations: batch.operations,
          inverse: batch.inverse,
          impact,
          footprint: commandFootprint(batch.operations),
          reports,
        };
      } catch (error) {
        try {
          session.rollback();
        } finally {
          busy = false;
        }
        if (error instanceof RejectedUpdate) return { status: 'rejected', issues: error.issues };
        throw error;
      } finally {
        busy = false;
      }
    },
    apply: (operations, options) =>
      applyBatch(operations, options?.source ?? 'local', options?.history ?? true),
    replace: (document, options) => {
      const source = options?.source ?? 'system';
      assertWritable({ kind: 'replace', source });
      let invalid: ReturnType<typeof checkValue>;
      busy = true;
      try {
        invalid = checkValue(rootNode, document);
      } finally {
        busy = false;
      }
      if (invalid)
        return {
          status: 'rejected',
          issues: [
            issue.at(
              invalid.address,
              invalid.code === 'invalid-tree' ? 'invalid-tree' : 'invalid-value',
              invalid.message
            ),
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
      return publish(batch, source, 'replace', false);
    },
    snapshot: () => {
      if (state.disposed) throw new DocumentDisposedError();
      return snapshotValue(rootNode, state.document) as Infer<TSchema>;
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
      if (busy || accessOf(runtime).projectionLocks) throw new DocumentReentrancyError();
      state.disposed = true;
      try {
        disposeNotification(notification);
      } finally {
        history.dispose();
        disposeRuntimeDriver(runtime);
      }
    },
  };

  bindRuntimeAccess(runtime, state);
  bindRuntimeDriver(runtime);
  notification = createNotification(runtime);
  bindDocumentReadable(history.api, runtime);
  return runtime;
};
