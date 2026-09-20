import {
  installRuntimeWriteDriver,
  type RuntimeWriteDriverLease,
  type RuntimeWriteIntent,
} from '../runtime/driver';
import type { DocumentCommit } from '../runtime/contract';
import type { Infer, ObjectSchema } from '../schema/model';
import { type AttachLocalSyncOptions, type LocalSync, type LocalSyncState } from './contract';
import { LocalSyncError, normalizeLocalSyncError } from './error';
import { json, jsonChanges } from './json';
import type { ChangeSet } from '../changes';
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
    throw new LocalSyncError(
      'unavailable',
      'Web Locks is required by doxum/local-sync in this environment.'
    );
  return value as LockManager;
};

const channelConstructor = (): ChannelConstructor => {
  const value: unknown = globalThis.BroadcastChannel;
  if (typeof value !== 'function')
    throw new LocalSyncError(
      'unavailable',
      'BroadcastChannel is required by doxum/local-sync in this environment.'
    );
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

export const attachLocalSync = async <TSchema extends ObjectSchema<object>>(
  input: AttachLocalSyncOptions<TSchema>
): Promise<LocalSync> => {
  const runtime = input.runtime;
  const databaseName = requiredString(input.database, 'database');
  const documentId = requiredString(input.documentId, 'documentId');
  const schemaVersion = positiveInteger(input.schemaVersion ?? 1, 'schemaVersion');
  const lockManager = locks();
  const BroadcastChannel = channelConstructor();
  const timeline = await openIndexedDbTimeline(databaseName).catch(error => {
    throw normalizeLocalSyncError(error, 'unavailable', 'Unable to open local sync storage.');
  });

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
    let fault: LocalSyncError | undefined;
    let closing = false;
    let disposed = false;
    let releaseLeadership: (() => void) | undefined;
    let leadershipLease: Promise<void> | undefined;
    let queued: Promise<void> = Promise.resolve();
    let snapshot: LocalSyncState = Object.freeze({ status: role, headSeq, checkpointSeq });
    let stateRevision = 0;
    const stateListeners = new Set<() => void>();
    const publishState = (): void => {
      const next: LocalSyncState = disposed
        ? { status: 'disposed' }
        : fault
          ? { status: 'error', headSeq, checkpointSeq, error: fault }
          : { status: role, headSeq, checkpointSeq };
      if (
        snapshot.status === next.status &&
        (snapshot.status === 'disposed' ||
          (next.status !== 'disposed' &&
            snapshot.headSeq === next.headSeq &&
            snapshot.checkpointSeq === next.checkpointSeq &&
            (snapshot.status !== 'error' ||
              (next.status === 'error' && snapshot.error === next.error))))
      )
        return;
      snapshot = Object.freeze(next);
      stateRevision++;
      for (const listener of [...stateListeners]) {
        if (!stateListeners.has(listener)) continue;
        try {
          listener();
        } catch {
          // Consumer state listeners are isolated from synchronization state.
        }
      }
    };

    const fail = (error: unknown): LocalSyncError => {
      const failure = normalizeLocalSyncError(
        error,
        'unavailable',
        'Local synchronization failed.'
      );
      if (fault || disposed) return fault ?? failure;
      fault = failure;
      publishState();
      try {
        input.onError?.(failure);
      } catch {
        // Error reporting cannot repair or replace the original synchronization failure.
      }
      return failure;
    };

    const assertOpen = (): void => {
      if (closing || disposed)
        throw new LocalSyncError('disposed', 'Local sync has been disposed.');
      if (fault) throw fault;
    };

    const assertLeader = (intent: RuntimeWriteIntent): void => {
      assertOpen();
      if (role !== 'leader')
        throw new LocalSyncError(
          'read-only',
          'This tab is following the local document and cannot write until it becomes the leader.'
        );
      if (intent.kind === 'replace' || (intent.kind === 'apply' && intent.source === 'remote'))
        throw new LocalSyncError(
          'unsupported-operation',
          'Local sync appends committed changes. runtime.replace() and externally supplied remote changes are unavailable while it is attached.'
        );
    };

    const runRuntime = <TResult>(run: () => TResult): TResult => driver?.run(run) ?? run();
    const replayRuntime = <TResult>(run: () => TResult, message: string): TResult => {
      try {
        return runRuntime(run);
      } catch (error) {
        throw normalizeLocalSyncError(error, 'consistency', message);
      }
    };

    const applyStored = (commit: StoredCommit): void => {
      if (commit.seq !== headSeq + 1)
        throw new LocalSyncError('consistency', 'Local commit log contains a sequence gap.');
      const result = replayRuntime(
        () =>
          runtime.apply(commit.changes, {
            expectedRevision: runtime.revision(),
            source: 'remote',
          }),
        'A stored local ChangeSet could not be replayed.'
      );
      if (result.status !== 'committed')
        throw new LocalSyncError('consistency', 'A stored local ChangeSet could not be applied.');
      headSeq = commit.seq;
    };

    const restore = async (reset = false): Promise<void> => {
      const current = await timeline.read(documentId);
      if (current.schemaVersion !== schemaVersion)
        throw new LocalSyncError(
          'consistency',
          'Local document schema changed while this attachment was open.'
        );
      if (headSeq > current.headSeq)
        throw new LocalSyncError('consistency', 'The local timeline moved behind this attachment.');
      if (reset || headSeq < current.checkpointSeq) {
        const result = replayRuntime(
          () => runtime.replace(current.checkpoint as Infer<TSchema>, { source: 'remote' }),
          'The local checkpoint could not be restored.'
        );
        if (result.status === 'rejected')
          throw new LocalSyncError('consistency', 'The local checkpoint could not be restored.');
        headSeq = current.checkpointSeq;
      }
      const tail = await timeline.tail(documentId, headSeq);
      for (const commit of tail) applyStored(commit);
      if (headSeq !== current.headSeq)
        throw new LocalSyncError(
          'consistency',
          'Local commit log does not reach its recorded head sequence.'
        );
      checkpointSeq = current.checkpointSeq;
      publishState();
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

    const persist = async (changes: ChangeSet): Promise<void> => {
      const storedCommit = await timeline.append({
        documentId,
        expectedHeadSeq: headSeq,
        changes,
      });
      if (storedCommit.seq !== headSeq + 1)
        throw new LocalSyncError(
          'consistency',
          'A local commit was assigned an unexpected sequence.'
        );
      headSeq = storedCommit.seq;
      publishState();
      channel?.postMessage({
        kind: 'commit',
        documentId,
        headSeq,
      } satisfies CommitNotification);
    };

    const record = (commit: DocumentCommit<TSchema>): void => {
      try {
        const changes = jsonChanges(
          commit.changes,
          'local commit changes',
          input.changeLimits ?? {}
        );
        void enqueue(() => persist(changes)).catch(() => undefined);
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
      publishState();
      activated?.();
      try {
        await holdLeadership();
      } finally {
        releaseLeadership = undefined;
        if (!closing && !disposed && !fault) {
          role = 'follower';
          publishState();
        }
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
      state: Object.freeze({
        current: () => snapshot,
        revision: () => stateRevision,
        subscribe: (listener: () => void) => {
          if (disposed) throw new LocalSyncError('disposed', 'Local sync has been disposed.');
          stateListeners.add(listener);
          return () => {
            stateListeners.delete(listener);
          };
        },
      }),
      flush: async (): Promise<void> => {
        assertOpen();
        try {
          await enqueue(restore);
        } catch (error) {
          throw fail(error);
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
        publishState();
        stateListeners.clear();
      },
    };
    return Object.freeze(localSync);
  } catch (error) {
    unsubscribe?.();
    driver?.dispose();
    channel?.close();
    timeline.close();
    throw normalizeLocalSyncError(error, 'unavailable', 'Unable to attach local sync.');
  }
};
