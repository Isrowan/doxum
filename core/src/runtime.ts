import type { ObjectNode, Infer, PathPick } from './schema';
import { compilePath } from './schema';
import { contains, debugKey, overlaps, read, resolveAddress } from './address';
import { createImpact } from './impact';
import { createHistory } from './history';
import { createAccess, type Draft } from './access/scope';
import { MutationSession } from './mutation/session';
import * as replay from './mutation/operations/replay';
import type { RuntimeWriteIntent } from './runtime/driver';
import { decodeChanges } from './mutation/changes';
import { MutationRejected, fail } from './mutation/issue';
import type { ChangeSet } from './changes';
import { checkValue, copyValue, ParseError } from './schema-value';
import {
  DocumentDisposedError,
  DocumentReentrancyError,
  TransactionRejected,
} from './runtime/contract';
import type {
  CommitListener,
  CommitSource,
  DocumentCommit,
  DocumentRuntime,
  OperationResult,
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

export const createDocument = <S extends ObjectNode>(input: {
  readonly schema: S;
  readonly initial: Infer<S>;
  readonly history?: { readonly capacity?: number } | false;
}): DocumentRuntime<S> => {
  if (input.schema.kind !== 'object')
    throw new TypeError('Document schema must be a root object node.');
  const invalid = checkValue(input.schema, input.initial);
  if (invalid) throw new ParseError(invalid);
  const state = {
    schema: input.schema,
    document: copyValue(input.schema, input.initial) as Infer<S>,
    disposed: false,
  };
  let revision = 0,
    busy = false;
  let runtime!: DocumentRuntime<S>, notification!: RuntimeNotification<S>;
  const idle = () => {
    if (state.disposed) throw new DocumentDisposedError();
    if (busy || accessOf(runtime).projectionLocks) throw new DocumentReentrancyError();
  };
  const writable = (intent: Parameters<typeof assertRuntimeWritable>[1]) => {
    idle();
    assertRuntimeWritable(runtime, intent);
  };
  const history = createHistory<DocumentCommit<S>>({
    capacity: input.history === false ? 0 : Math.max(0, input.history?.capacity ?? 100),
    revision: () => revision,
    apply: (changes, direction) =>
      mutate({ kind: 'apply', source: 'history' }, false, session => {
        for (const change of changes) replay.apply(session, change, direction);
      }),
    assertIdle: idle,
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
    changes: ChangeSet,
    source: CommitSource,
    recordHistory: boolean
  ): Extract<OperationResult<DocumentCommit<S>>, { status: 'committed' }> => {
    const commit: DocumentCommit<S> = {
      revision: ++revision,
      source,
      changes,
      impact: createImpact(input.schema, changes),
    };
    if (source === 'remote') history.invalidate();
    else if (recordHistory && (source === 'local' || source === 'system')) history.record(changes);
    else if (source === 'history') history.publish();
    else history.endGroup();
    return {
      status: 'committed',
      commit,
      observerErrors: notify(notification, commit, history.flush),
    };
  };
  function mutate(
    intent: Extract<RuntimeWriteIntent, { kind: 'update' }>,
    recordHistory: boolean,
    execute: (session: MutationSession) => void
  ):
    | OperationResult<DocumentCommit<S>>
    | Extract<TransactionResult<never, never>, { status: 'rejected' }>;
  function mutate(
    intent: Exclude<RuntimeWriteIntent, { kind: 'update' }>,
    recordHistory: boolean,
    execute: (session: MutationSession) => void
  ): OperationResult<DocumentCommit<S>>;
  function mutate(
    intent: RuntimeWriteIntent,
    recordHistory: boolean,
    execute: (session: MutationSession) => void
  ):
    | OperationResult<DocumentCommit<S>>
    | Extract<TransactionResult<never, never>, { status: 'rejected' }> {
    writable(intent);
    busy = true;
    try {
      const session = new MutationSession(state);
      let changes: ChangeSet;
      try {
        execute(session);
        changes = session.finish();
      } catch (error) {
        session.rollback();
        if (error instanceof MutationRejected)
          return { status: 'rejected', issues: [error.issue], revision };
        if (intent.kind === 'update' && error instanceof TransactionRejected)
          return { status: 'rejected', issues: error.issues, revision };
        throw error;
      }
      if (!changes.changes.length) return { status: 'unchanged', revision };
      // Publication is outside the rollback boundary: observers see accepted state.
      return publish(changes, intent.source, recordHistory);
    } finally {
      busy = false;
    }
  }
  runtime = {
    schema: input.schema,
    address: {
      resolve: at => resolveAddress(input.schema, at, state.document),
      read: at => read(state.document, at, input.schema),
      contains,
      overlaps,
      debugKey,
    },
    revision: () => revision,
    update: <V>(
      run: (draft: Draft<S>) => V,
      options?: { source?: Extract<CommitSource, 'local' | 'system'>; history?: boolean }
    ): TransactionResult<V, DocumentCommit<S>> => {
      const source = options?.source ?? 'local';
      let value!: V;
      const result = mutate({ kind: 'update', source }, options?.history ?? true, session => {
        // Draft is a trusted borrowed view. It must not escape this synchronous callback.
        const draft = createAccess({
          schema: input.schema,
          root: () => state.document,
          session,
        }) as Draft<S>;
        value = run(draft);
        if (
          value !== null &&
          (typeof value === 'object' || typeof value === 'function') &&
          typeof (value as { then?: unknown }).then === 'function'
        )
          throw new TypeError('Document updates must be synchronous.');
      });
      return result.status === 'rejected' ? result : { ...result, value };
    },
    apply: (inputChanges, options) =>
      mutate(
        { kind: 'apply', source: options?.source ?? 'local' },
        options?.history ?? true,
        session => {
          if (!options || options.expectedRevision !== revision)
            fail([], 'baseline-mismatch', 'apply requires the current expectedRevision.');
          replay.apply(session, decodeChanges(inputChanges), 'forward');
        }
      ),
    replace: (value, options) => {
      const source = options?.source ?? 'system';
      return mutate({ kind: 'replace', source }, source !== 'remote', session =>
        session.replace([], value)
      );
    },
    snapshot: () => {
      if (state.disposed) throw new DocumentDisposedError();
      return copyValue(input.schema, state.document) as Infer<S>;
    },
    subscribe: ((
      pick: PathPick<S> | readonly PathPick<S>[] | CommitListener<S>,
      listener?: CommitListener<S>
    ) => {
      if (state.disposed) throw new DocumentDisposedError();
      if (!listener) return subscribeRoot(notification, pick as CommitListener<S>);
      const picks: readonly PathPick<S>[] = Array.isArray(pick) ? pick : [pick as PathPick<S>];
      if (!picks.length) throw new TypeError('Expected at least one subscription path.');
      return subscribeTargets(
        notification,
        picks.map(p => compilePath<S['shape']>(input.schema, 'value', p)),
        listener
      );
    }) as DocumentRuntime<S>['subscribe'],
    history: history.api,
    dispose: () => {
      if (state.disposed) return;
      idle();
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
