import type { Infer, ObjectSchema, RootNodeOf } from './schema/model';
import { schemaNodeOf } from './schema/model';
import type { PathPick } from './schema/path';
import { compilePath } from './schema/path';
import { createImpact } from './impact';
import { createHistory } from './history';
import { createAccess, type Draft } from './access/scope';
import { MutationSession } from './mutation/session';
import * as replay from './mutation/operations/replay';
import type { RuntimeWriteIntent } from './runtime/driver';
import * as changeSet from './mutation/changes';
import * as issue from './mutation/issue';
import type { ChangeSet } from './changes';
import * as schemaValue from './schema/value';
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
  ReadonlyDocument,
  OperationResult,
  TransactionResult,
} from './runtime/contract';
import { readonlyDocument } from './runtime/readable';
import { assertRuntimeWritable } from './runtime/driver';
import { bindContext, type RuntimeContext, type RuntimeState } from './runtime/context';
import { createNotificationCenter } from './runtime/notification';

export const createDocument = <S extends ObjectSchema<object>>(input: {
  readonly schema: S;
  readonly initial: Infer<S>;
  readonly history?: { readonly capacity?: number } | false;
}): DocumentRuntime<S> => {
  const schema = schemaNodeOf(input.schema) as RootNodeOf<S>;
  const invalid = schemaValue.checkValue(schema, input.initial);
  if (invalid) throw new schemaValue.ParseError(invalid);
  const state: RuntimeState<S> = {
    schema,
    document: schemaValue.copyValue(schema, input.initial) as Infer<S>,
    disposed: false,
    projectionLocks: 0,
  };
  let revision = 0,
    busy = false;
  const notifications = createNotificationCenter<S>(schema);
  let runtime!: DocumentRuntime<S>, context!: RuntimeContext<S>;
  let readonlyAlias: ReadonlyDocument<S> | undefined;
  const idle = () => {
    if (state.disposed) throw new DocumentDisposedError();
    if (busy || state.projectionLocks) throw new DocumentReentrancyError();
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
      impact: createImpact<S>(schema, changes),
    };
    if (source === 'remote') history.invalidate();
    else if (recordHistory && (source === 'local' || source === 'system')) history.record(changes);
    else if (source === 'history') history.publish();
    else history.endGroup();
    return {
      status: 'committed',
      commit,
      observerErrors: notifications.publish(commit, history.flush),
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
        if (error instanceof issue.MutationRejected)
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
    revision: () => revision,
    readonly: () => (readonlyAlias ??= readonlyDocument(runtime)),
    update: <V>(
      run: (draft: Draft<S>) => V,
      options?: { source?: Extract<CommitSource, 'local' | 'system'>; history?: boolean }
    ): TransactionResult<V, DocumentCommit<S>> => {
      const source = options?.source ?? 'local';
      let value!: V;
      const result = mutate({ kind: 'update', source }, options?.history ?? true, session => {
        // Draft is a trusted borrowed view. It must not escape this synchronous callback.
        const draft = createAccess({
          state,
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
    apply: (inputChanges, options) => {
      const source = options?.source ?? 'local';
      return mutate(
        { kind: 'apply', source },
        source === 'remote' ? false : (options?.history ?? true),
        session => {
          if (!options || options.expectedRevision !== revision)
            issue.fail([], 'baseline-mismatch', 'apply requires the current expectedRevision.');
          replay.apply(session, changeSet.decodeChanges(inputChanges), 'forward');
        }
      );
    },
    replace: (value, options) => {
      const source = options?.source ?? 'system';
      return mutate({ kind: 'replace', source }, source !== 'remote', session =>
        session.replace([], value)
      );
    },
    snapshot: () => {
      if (state.disposed) throw new DocumentDisposedError();
      return schemaValue.copyValue(schema, state.document) as Infer<S>;
    },
    subscribe: ((
      pick: PathPick<S> | readonly PathPick<S>[] | CommitListener<S>,
      listener?: CommitListener<S>
    ) => {
      if (state.disposed) throw new DocumentDisposedError();
      if (!listener) return notifications.subscribe(pick as CommitListener<S>);
      const picks: readonly PathPick<S>[] = Array.isArray(pick) ? pick : [pick as PathPick<S>];
      if (!picks.length) throw new TypeError('Expected at least one subscription path.');
      return notifications.subscribeTargets(
        picks.map(p => compilePath<S>(schema, 'value', p)),
        listener
      );
    }) as DocumentRuntime<S>['subscribe'],
    history: history.api,
    dispose: () => {
      if (state.disposed) return;
      idle();
      state.disposed = true;
      try {
        notifications.dispose();
      } finally {
        history.dispose();
        context.driver = undefined;
      }
    },
  };
  context = {
    state,
    owner: runtime,
    notifications,
    driver: undefined,
    bypassDepth: 0,
  };
  bindContext(runtime, context);
  bindContext(history.api, context);
  return runtime;
};
