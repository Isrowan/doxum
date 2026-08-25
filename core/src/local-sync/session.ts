import {
  installRuntimeWriteDriver,
  type RuntimeWriteDriverLease,
  type RuntimeWriteIntent,
} from '../runtime/driver';
import type { DocumentCommit, DocumentRuntime, OperationResult } from '../runtime/contract';
import type { DocumentSchema, ReadonlyDocument } from '../schema';
import {
  LocalSyncConsistencyError,
  LocalSyncDisposedError,
  LocalSyncReadOnlyError,
  LocalSyncUnsupportedOperationError,
  LocalSyncUnavailableError,
  type AttachLocalSyncOptions,
  type LocalSync,
  type LocalSyncState,
} from './contract';
import { json, jsonArray, type JsonValue } from './json';
import { openIndexedDbTimeline, type StoredCommit } from './timeline';

type LockOptions = {
  readonly mode: 'exclusive';
  readonly ifAvailable?: boolean;
};

type LockManager = {
  readonly request: <TResult>(
    name: string,
    options: LockOptions,
    callback: (lock: unknown | null) => TResult | PromiseLike<TResult>
  ) => Promise<TResult>;
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

const positiveInteger = (value: number, label: string): number => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new TypeError(`${label} must be a positive safe integer.`);
};

const notification = (value: unknown): CommitNotification | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'commit' ||
    typeof record.documentId !== 'string' ||
    typeof record.headSeq !== 'number' ||
    !Number.isSafeInteger(record.headSeq) ||
    record.headSeq < 0
  )
    return undefined;
  return record as CommitNotification;
};

export const attachLocalSync = async <TSchema extends DocumentSchema>(
  input: AttachLocalSyncOptions<TSchema>
): Promise<LocalSync> => {
  const runtime = input.runtime;
  const databaseName = requiredString(input.database, 'database');
  const documentId = requiredString(input.documentId, 'documentId');
  const schemaVersion = positiveInteger(input.schemaVersion ?? 1, 'schemaVersion');
  const lockManager = locks();
  const BroadcastChannel = channelConstructor();
  const timeline = await openIndexedDbTimeline(databaseName);

  let channel: Channel | undefined;
  let unsubscribe: (() => void) | undefined;
  let driver: RuntimeWriteDriverLease | undefined;
  try {
    const stored = await timeline.initialize(
      documentId,
      schemaVersion,
      json(runtime.snapshot(), 'runtime snapshot')
    );
    let headSeq = stored.checkpointSeq;
    let checkpointSeq = stored.checkpointSeq;
    let role: 'leader' | 'follower' = 'follower';
    let fault: unknown;
    let closing = false;
    let disposed = false;
    let releaseLeadership: (() => void) | undefined;
    let leadershipLease: Promise<void> | undefined;
    let queued: Promise<void> = Promise.resolve();

    const fail = (error: unknown): void => {
      if (fault || disposed) return;
      fault = error;
      try {
        input.onError?.(error);
      } catch {
        // Error reporting cannot repair or replace the original synchronization failure.
      }
    };

    const assertOpen = (): void => {
      if (closing || disposed) throw new LocalSyncDisposedError();
      if (fault) throw fault;
    };

    const assertLeader = (intent: RuntimeWriteIntent): void => {
      assertOpen();
      if (role !== 'leader') throw new LocalSyncReadOnlyError();
      if (intent.kind === 'replace' || (intent.kind === 'apply' && intent.source === 'remote'))
        throw new LocalSyncUnsupportedOperationError();
    };

    const runRuntime = <TResult>(run: () => TResult): TResult => driver?.run(run) ?? run();

    const applyStored = (commit: StoredCommit): void => {
      if (commit.seq !== headSeq + 1)
        throw new LocalSyncConsistencyError('Local commit log contains a sequence gap.');
      const result = runRuntime(() =>
        runtime.apply(commit.operations, { source: 'remote', history: false })
      );
      if (result.status !== 'committed')
        throw new LocalSyncConsistencyError('A stored local command could not be applied.');
      headSeq = commit.seq;
    };

    const restore = async (reset = false): Promise<void> => {
      const current = await timeline.read(documentId);
      if (current.schemaVersion !== schemaVersion)
        throw new LocalSyncConsistencyError(
          'Local document schema changed while this attachment was open.'
        );
      if (headSeq > current.headSeq)
        throw new LocalSyncConsistencyError('The local timeline moved behind this attachment.');
      if (reset || headSeq < current.checkpointSeq) {
        const result = runRuntime(() =>
          runtime.replace(current.checkpoint as ReadonlyDocument<TSchema>, { source: 'remote' })
        );
        if (result.status === 'rejected')
          throw new LocalSyncConsistencyError('The local checkpoint could not be restored.');
        headSeq = current.checkpointSeq;
      }
      const tail = await timeline.tail(documentId, headSeq);
      for (const commit of tail) applyStored(commit);
      if (headSeq !== current.headSeq)
        throw new LocalSyncConsistencyError(
          'Local commit log does not reach its recorded head sequence.'
        );
      checkpointSeq = current.checkpointSeq;
    };

    const enqueue = (run: () => Promise<void>): Promise<void> => {
      const next = queued.then(run, run);
      queued = next.then(
        () => undefined,
        error => {
          fail(error);
        }
      );
      return next;
    };

    const persist = async (operations: readonly JsonValue[]): Promise<void> => {
      const storedCommit = await timeline.append({
        documentId,
        expectedHeadSeq: headSeq,
        operations,
      });
      if (storedCommit.seq !== headSeq + 1)
        throw new LocalSyncConsistencyError('A local command was assigned an unexpected sequence.');
      headSeq = storedCommit.seq;
      channel?.postMessage({
        kind: 'commit',
        documentId,
        headSeq,
      } satisfies CommitNotification);
    };

    const record = (commit: DocumentCommit<TSchema>): void => {
      try {
        const operations = jsonArray(
          commit.operations,
          'local command operations',
          input.commandLimits
        );
        void enqueue(() => persist(operations)).catch(() => undefined);
      } catch (error) {
        fail(error);
      }
    };

    const holdLeadership = (): Promise<void> =>
      new Promise(resolve => {
        releaseLeadership = resolve;
      });

    const lead = async (activated?: () => void): Promise<void> => {
      if (closing || disposed || fault) return;
      await restore();
      if (closing || disposed || fault) return;
      role = 'leader';
      activated?.();
      try {
        await holdLeadership();
      } finally {
        releaseLeadership = undefined;
        if (!closing && !disposed && !fault) role = 'follower';
      }
    };

    const watchLeadership = (): void => {
      leadershipLease = lockManager
        .request(`doxum:${documentId}`, { mode: 'exclusive' }, async () => {
          try {
            await lead();
          } catch (error) {
            fail(error);
          }
        })
        .catch(error => {
          if (!closing && !disposed) fail(error);
        });
    };

    const claimInitialLeadership = async (): Promise<void> => {
      let resolve!: (value: boolean) => void;
      const claimed = new Promise<boolean>(done => {
        resolve = done;
      });
      leadershipLease = lockManager
        .request(`doxum:${documentId}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (lock === null) {
            resolve(false);
            return;
          }
          try {
            await lead(() => resolve(true));
          } catch (error) {
            fail(error);
            resolve(false);
          }
        })
        .catch(error => {
          if (!closing && !disposed) fail(error);
          resolve(false);
        });
      if (!(await claimed) && !fault && !closing && !disposed) watchLeadership();
    };

    await restore(true);
    // The timeline, not a runtime constructed before attachment, is the baseline
    // for local undo. Even an identical restored snapshot must discard prior history.
    runtime.history.clear();
    driver = installRuntimeWriteDriver(runtime, { assertWritable: assertLeader });
    channel = new BroadcastChannel(`doxum:${databaseName}:${documentId}`);
    unsubscribe = runtime.subscribe(commit => {
      if (
        (commit.source === 'local' || commit.source === 'system' || commit.source === 'history') &&
        !closing &&
        !disposed
      )
        record(commit);
    });
    channel.onmessage = event => {
      const message = notification(event.data);
      if (
        !message ||
        message.documentId !== documentId ||
        message.headSeq <= headSeq ||
        closing ||
        disposed ||
        fault
      )
        return;
      void enqueue(restore).catch(() => undefined);
    };
    await claimInitialLeadership();
    if (fault) throw fault;

    const localSync: LocalSync = {
      state: (): LocalSyncState => {
        if (disposed) return { status: 'disposed' };
        if (fault) return { status: 'error', headSeq, checkpointSeq, error: fault };
        return { status: role, headSeq, checkpointSeq };
      },
      flush: async (): Promise<void> => {
        assertOpen();
        try {
          await enqueue(restore);
        } catch (error) {
          fail(error);
          throw error;
        }
        assertOpen();
      },
      dispose: async (): Promise<void> => {
        if (disposed) return;
        if (closing) {
          await queued;
          return;
        }
        closing = true;
        unsubscribe?.();
        await queued;
        releaseLeadership?.();
        if (role === 'leader') await leadershipLease;
        disposed = true;
        driver?.dispose();
        channel?.close();
        timeline.close();
      },
    };
    return Object.freeze(localSync);
  } catch (error) {
    unsubscribe?.();
    driver?.dispose();
    channel?.close();
    timeline.close();
    throw error;
  }
};
