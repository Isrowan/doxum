import { createDocument } from '../runtime';
import { asReadable } from '../runtime/readable';
import { commandFootprint, type CommandFootprint } from '../mutation/footprint';
import type { DocumentSchema, ReadonlyDocument } from '../schema';
import type {
  DocumentCommit,
  DocumentTransaction,
  OperationResult,
  TransactionResult,
} from '../runtime/contract';
import {
  LocalSyncConsistencyError,
  LocalSyncDisposedError,
  LocalSyncUnavailableError,
  type LocalSyncCommit,
  type LocalSyncDocument,
  type LocalSyncState,
  type OpenLocalDocumentOptions,
} from './contract';
import { json, jsonArray, type JsonValue } from './json';
import {
  openIndexedDbTimeline,
  type ActorHistoryChange,
  type LocalCommitKind,
  type StoredActorHistory,
  type StoredCommit,
} from './timeline';

type LockManager = {
  readonly request: <T>(
    name: string,
    options: { readonly mode: 'exclusive' },
    callback: () => T | PromiseLike<T>
  ) => Promise<T>;
};

type Channel = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};

type ChannelConstructor = new (name: string) => Channel;

type CommitNotification = {
  readonly kind: 'commit';
  readonly documentId: string;
  readonly headSeq: number;
  readonly senderId: string;
};

const locks = (): LockManager => {
  const value: unknown = globalThis.navigator?.locks;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('request' in value) ||
    typeof value.request !== 'function'
  )
    throw new LocalSyncUnavailableError('Web Locks');
  return value as LockManager;
};

const channelConstructor = (): ChannelConstructor => {
  const value: unknown = globalThis.BroadcastChannel;
  if (typeof value !== 'function') throw new LocalSyncUnavailableError('BroadcastChannel');
  return value as ChannelConstructor;
};

const requiredString = (value: string, label: string): string => {
  if (value.length > 0) return value;
  throw new TypeError(`${label} must not be empty.`);
};

const nonNegativeInteger = (value: number, label: string): number => {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError(`${label} must be a non-negative safe integer.`);
};

const positiveInteger = (value: number, label: string): number => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new TypeError(`${label} must be a positive safe integer.`);
};

const identifier = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const notification = (value: unknown): CommitNotification | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'commit' ||
    typeof record.documentId !== 'string' ||
    typeof record.senderId !== 'string' ||
    typeof record.headSeq !== 'number' ||
    !Number.isSafeInteger(record.headSeq) ||
    record.headSeq < 0
  )
    return undefined;
  return record as CommitNotification;
};

const localCommit = <TSchema extends DocumentSchema>(
  commit: DocumentCommit<TSchema>,
  stored: StoredCommit
): LocalSyncCommit<TSchema> =>
  Object.freeze({
    ...commit,
    seq: stored.seq,
    commandId: stored.commandId,
    actorId: stored.actorId,
  });

const operationResult = <TSchema extends DocumentSchema>(
  result: OperationResult<DocumentCommit<TSchema>>,
  stored: StoredCommit
): OperationResult<LocalSyncCommit<TSchema>> => {
  if (result.status !== 'committed')
    throw new LocalSyncConsistencyError('A durable local command could not be applied.');
  return {
    status: 'committed',
    commit: localCommit(result.commit, stored),
    observerErrors: result.observerErrors,
  };
};

export const openLocalDocument = async <TSchema extends DocumentSchema>(
  input: OpenLocalDocumentOptions<TSchema>
): Promise<LocalSyncDocument<TSchema>> => {
  const databaseName = requiredString(input.database, 'database');
  const documentId = requiredString(input.documentId, 'documentId');
  const actorId = requiredString(input.actorId ?? 'local', 'actorId');
  const schemaVersion = positiveInteger(input.schemaVersion ?? 1, 'schemaVersion');
  const historyCapacity = nonNegativeInteger(input.historyCapacity ?? 100, 'historyCapacity');
  const checkpointEvery = nonNegativeInteger(input.checkpointEvery ?? 500, 'checkpointEvery');
  const commandLimits = input.commandLimits;
  const initial = json(input.initial, 'initial document');
  const lockManager = locks();
  const BroadcastChannel = channelConstructor();
  const timeline = await openIndexedDbTimeline(databaseName);

  let channel: Channel | undefined;
  let runtime: ReturnType<typeof createDocument<TSchema>> | undefined;
  try {
    const stored = await timeline.initialize(documentId, schemaVersion, initial);
    const documentRuntime = createDocument({
      schema: input.schema,
      initial: stored.checkpoint as ReadonlyDocument<TSchema>,
      history: false,
    });
    runtime = documentRuntime;
    let headSeq = stored.checkpointSeq;
    let checkpointSeq = stored.checkpointSeq;
    let queued: Promise<void> = Promise.resolve();
    let fault: unknown;
    let closing = false;
    let disposed = false;
    const senderId = identifier();

    const fail = (error: unknown): void => {
      if (closing || disposed || fault) return;
      fault = error;
      try {
        input.onError?.(error);
      } catch {
        // Error reporting cannot repair or replace the original session failure.
      }
    };

    const assertOpen = (): void => {
      if (closing || disposed) throw new LocalSyncDisposedError();
      if (fault) throw fault;
    };

    const applyStored = (commit: StoredCommit): LocalSyncCommit<TSchema> => {
      if (commit.seq !== headSeq + 1)
        throw new LocalSyncConsistencyError('Local commit log contains a sequence gap.');
      const result = documentRuntime.apply(commit.operations, { source: 'local', history: false });
      const local = operationResult(result, commit);
      if (local.status !== 'committed')
        throw new LocalSyncConsistencyError('A durable local command was not committed.');
      headSeq = commit.seq;
      return local.commit;
    };

    const catchUp = async (): Promise<void> => {
      const current = await timeline.read(documentId);
      if (current.schemaVersion !== schemaVersion)
        throw new LocalSyncConsistencyError(
          'Local document schema changed while this session was open.'
        );
      if (headSeq < current.checkpointSeq) {
        const replaced = documentRuntime.replace(current.checkpoint as ReadonlyDocument<TSchema>, {
          source: 'system',
        });
        if (replaced.status !== 'committed' && replaced.status !== 'unchanged')
          throw new LocalSyncConsistencyError('Local checkpoint could not be restored.');
        headSeq = current.checkpointSeq;
        checkpointSeq = current.checkpointSeq;
      }
      const tail = await timeline.tail(documentId, headSeq);
      for (const commit of tail) applyStored(commit);
      if (headSeq !== current.headSeq)
        throw new LocalSyncConsistencyError(
          'Local commit log does not reach its recorded head sequence.'
        );
      checkpointSeq = current.checkpointSeq;
    };

    const execute = <T>(run: () => Promise<T>): Promise<T> => {
      const next = queued.then(run, run);
      queued = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };

    const withWriter = <T>(run: () => Promise<T>): Promise<T> =>
      lockManager.request(`doxum:${documentId}`, { mode: 'exclusive' }, async () => {
        assertOpen();
        try {
          await catchUp();
        } catch (error) {
          fail(error);
          throw error;
        }
        return run();
      });

    const persistAndApply = async (input: {
      readonly commandId: string;
      readonly kind: LocalCommitKind;
      readonly operations: readonly JsonValue[];
      readonly inverse: readonly JsonValue[];
      readonly footprint: CommandFootprint;
      readonly history: ActorHistoryChange;
    }): Promise<OperationResult<LocalSyncCommit<TSchema>>> => {
      try {
        const storedCommit = await timeline.append({
          documentId,
          expectedHeadSeq: headSeq,
          commandId: input.commandId,
          actorId,
          kind: input.kind,
          operations: input.operations,
          inverse: input.inverse,
          footprint: input.footprint,
          history: input.history,
        });
        const result = operationResult(
          documentRuntime.apply(storedCommit.operations, { source: 'local', history: false }),
          storedCommit
        );
        headSeq = storedCommit.seq;
        if (checkpointEvery > 0 && headSeq - checkpointSeq >= checkpointEvery) {
          const checkpoint = json(documentRuntime.snapshot(), 'local checkpoint');
          const compacted = await timeline.compact(documentId, headSeq, checkpoint);
          checkpointSeq = compacted.checkpointSeq;
        }
        channel?.postMessage({
          kind: 'commit',
          documentId,
          headSeq,
          senderId,
        } satisfies CommitNotification);
        return result;
      } catch (error) {
        fail(error);
        throw error;
      }
    };

    const replay = (operations: readonly JsonValue[]): OperationResult<DocumentCommit<TSchema>> => {
      const candidate = createDocument({
        schema: input.schema,
        initial: documentRuntime.snapshot(),
        history: false,
      });
      try {
        return candidate.apply(operations, { source: 'local', history: false });
      } finally {
        candidate.dispose();
      }
    };

    const applyHistory = async (
      history: StoredActorHistory,
      kind: 'undo' | 'redo'
    ): Promise<OperationResult<LocalSyncCommit<TSchema>>> => {
      const source = kind === 'undo' ? history.undo : history.redo;
      const entry = source[source.length - 1];
      if (!entry) return { status: 'unchanged', revision: documentRuntime.revision() };
      const preview = replay(kind === 'undo' ? entry.inverse : entry.operations);
      if (preview.status !== 'committed') return preview;
      const operations = jsonArray(preview.commit.operations, `${kind} operations`, commandLimits);
      const inverse = jsonArray(preview.commit.inverse, `${kind} inverse`, commandLimits);
      return persistAndApply({
        commandId: identifier(),
        kind,
        operations,
        inverse,
        footprint: commandFootprint(preview.commit.operations),
        history:
          kind === 'undo'
            ? { kind: 'undo', expectedCommandId: entry.commandId, entry }
            : { kind: 'redo', expectedCommandId: entry.commandId, entry },
      });
    };

    const initialTail = await timeline.tail(documentId, headSeq);
    for (const commit of initialTail) applyStored(commit);
    if (headSeq !== stored.headSeq)
      throw new LocalSyncConsistencyError(
        'Local commit log does not reach its recorded head sequence.'
      );

    channel = new BroadcastChannel(`doxum:${databaseName}:${documentId}`);
    channel.onmessage = event => {
      const message = notification(event.data);
      if (
        !message ||
        message.documentId !== documentId ||
        message.senderId === senderId ||
        message.headSeq <= headSeq ||
        closing ||
        disposed
      )
        return;
      void execute(() => withWriter(async () => undefined)).catch(() => undefined);
    };

    const localDocument: LocalSyncDocument<TSchema> = {
      document: asReadable(documentRuntime),
      state: (): LocalSyncState => {
        if (disposed) return { status: 'disposed' };
        if (fault) return { status: 'failed', error: fault };
        return { status: 'ready', headSeq, checkpointSeq };
      },
      sync: () => execute(() => withWriter(async () => undefined)),
      update: <TResult>(
        run: (transaction: DocumentTransaction<TSchema>) => TResult
      ): Promise<TransactionResult<TResult, LocalSyncCommit<TSchema>>> => {
        assertOpen();
        return execute(() =>
          withWriter(async () => {
            const prepared = documentRuntime.prepare(run);
            if (prepared.status === 'unchanged')
              return {
                status: 'unchanged',
                value: prepared.value,
                revision: documentRuntime.revision(),
                reports: prepared.reports,
              };
            if (prepared.status === 'rejected')
              return {
                status: 'rejected',
                issues: prepared.issues,
                revision: documentRuntime.revision(),
              };
            const operations = jsonArray(
              prepared.operations,
              'local command operations',
              commandLimits
            );
            const inverse = jsonArray(prepared.inverse, 'local command inverse', commandLimits);
            const commandId = identifier();
            const result = await persistAndApply({
              commandId,
              kind: 'update',
              operations,
              inverse,
              footprint: prepared.footprint,
              history: {
                kind: 'record',
                entry: Object.freeze({
                  commandId,
                  operations,
                  inverse,
                  footprint: prepared.footprint,
                }),
                capacity: historyCapacity,
              },
            });
            if (result.status !== 'committed')
              throw new LocalSyncConsistencyError('Prepared local command was not committed.');
            return {
              status: 'committed',
              value: prepared.value,
              commit: result.commit,
              reports: prepared.reports,
              observerErrors: result.observerErrors,
            };
          })
        );
      },
      undo: () => {
        assertOpen();
        return execute(() =>
          withWriter(async () => applyHistory(await timeline.history(documentId, actorId), 'undo'))
        );
      },
      redo: () => {
        assertOpen();
        return execute(() =>
          withWriter(async () => applyHistory(await timeline.history(documentId, actorId), 'redo'))
        );
      },
      dispose: async () => {
        if (disposed) return;
        if (closing) {
          await queued;
          return;
        }
        closing = true;
        await queued;
        disposed = true;
        channel?.close();
        timeline.close();
        documentRuntime.dispose();
      },
    };
    return Object.freeze(localDocument);
  } catch (error) {
    channel?.close();
    runtime?.dispose();
    timeline.close();
    throw error;
  }
};
