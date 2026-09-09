import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  createDocument,
  createProjectionStore,
  field,
  map,
  object,
  project,
  select,
  table,
} from '../src';
import {
  attachLocalSync,
  LocalSyncDataError,
  LocalSyncReadOnlyError,
  LocalSyncUnsupportedOperationError,
} from '../src/local-sync';
import { openIndexedDbTimeline } from '../src/local-sync/timeline';
class TestLockManager {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #requests = new Map<string, number>();
  request<TResult>(
    name: string,
    options: {
      readonly mode: 'exclusive';
      readonly ifAvailable?: boolean;
    },
    callback: (lock: unknown | null) => TResult | PromiseLike<TResult>
  ): Promise<TResult> {
    if (options.ifAvailable && (this.#requests.get(name) ?? 0) > 0)
      return Promise.resolve(callback(null));
    this.#requests.set(name, (this.#requests.get(name) ?? 0) + 1);
    const previous = this.#tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    this.#tails.set(name, next);
    return previous
      .then(
        () => callback({}),
        () => callback({})
      )
      .finally(() => {
        const remaining = (this.#requests.get(name) ?? 1) - 1;
        if (remaining === 0) this.#requests.delete(name);
        else this.#requests.set(name, remaining);
        release();
      });
  }
}
class TestBroadcastChannel {
  static readonly channels = new Map<string, Set<TestBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly #listeners: Set<TestBroadcastChannel>;
  constructor(readonly name: string) {
    this.#listeners = TestBroadcastChannel.channels.get(name) ?? new Set();
    this.#listeners.add(this);
    TestBroadcastChannel.channels.set(name, this.#listeners);
  }
  postMessage(message: unknown): void {
    for (const listener of this.#listeners)
      if (listener !== this)
        queueMicrotask(() => listener.onmessage?.({ data: message } as MessageEvent));
  }
  close(): void {
    this.#listeners.delete(this);
    if (this.#listeners.size === 0) TestBroadcastChannel.channels.delete(this.name);
  }
}
const task = object({ title: field<string>(), complete: field<boolean>() });
const documentSchema = object({
  title: field<string>(),
  tasks: table(task),
});
const initial = {
  title: 'one',
  tasks: { ids: ['a'], byId: { a: { title: 'A', complete: false } } },
};
const globals = {
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
  keyRange: Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange'),
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  broadcastChannel: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};
beforeAll(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: IDBKeyRange,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: new TestLockManager() },
  });
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: TestBroadcastChannel,
  });
});
afterAll(() => {
  const names = {
    indexedDB: 'indexedDB',
    keyRange: 'IDBKeyRange',
    navigator: 'navigator',
    broadcastChannel: 'BroadcastChannel',
  } as const;
  const restore = (key: keyof typeof globals): void => {
    const descriptor = globals[key];
    if (descriptor) Object.defineProperty(globalThis, names[key], descriptor);
    else Reflect.deleteProperty(globalThis, names[key]);
  };
  restore('indexedDB');
  restore('keyRange');
  restore('navigator');
  restore('broadcastChannel');
});
let sequence = 0;
const database = (): string => `doxum-local-sync-${sequence++}`;
const runtime = () => createDocument({ schema: documentSchema, initial });
const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for local sync.');
};
describe('local sync', () => {
  it('persists complete member/order groups for live followers and reopened documents', async () => {
    const name = database();
    const leaderRuntime = runtime(),
      followerRuntime = runtime();
    const leader = await attachLocalSync({
      runtime: leaderRuntime,
      database: name,
      documentId: 'groups',
    });
    const follower = await attachLocalSync({
      runtime: followerRuntime,
      database: name,
      documentId: 'groups',
    });
    const result = leaderRuntime.update(d => {
      d.tasks.create({ id: 'b', value: { title: 'B', complete: false } }, { at: 'start' });
      d.tasks.get('a')!.complete = true;
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.changes.changes[0]).toMatchObject({
      kind: 'members',
      at: ['tasks'],
      members: [{ key: 'b', kind: 'added' }],
      order: { before: ['a'], after: ['b', 'a'] },
    });
    await leader.flush();
    await waitFor(() => followerRuntime.revision() === 1);
    expect(followerRuntime.snapshot()).toEqual(leaderRuntime.snapshot());
    await follower.dispose();
    await leader.dispose();
    const reopened = runtime();
    const sync = await attachLocalSync({ runtime: reopened, database: name, documentId: 'groups' });
    expect(reopened.snapshot()).toEqual(leaderRuntime.snapshot());
    await sync.dispose();
    reopened.dispose();
    followerRuntime.dispose();
    leaderRuntime.dispose();
  });
  it('rejects an old record inside a current database without changing its payload', async () => {
    const name = database();
    const timeline = await openIndexedDbTimeline(name);
    const original = await timeline.initialize('record', 1, initial);
    expect(original.formatVersion).toBe(3);
    timeline.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const old = { ...original, formatVersion: 2 };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').put(old);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const reopened = await openIndexedDbTimeline(name);
    await expect(reopened.read('record')).rejects.toThrow();
    const retained = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('documents').objectStore('documents').get('record');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(retained).toEqual(old);
    reopened.close();
    db.close();
  });
  it('rejects the previous storage format without upgrading or deleting its data', async () => {
    const name = database();
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 4);
      request.onupgradeneeded = () => request.result.createObjectStore('legacy');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction('legacy', 'readwrite');
      tx.objectStore('legacy').put('keep', 'sentinel');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    old.close();
    const documentRuntime = runtime();
    await expect(
      attachLocalSync({ runtime: documentRuntime, database: name, documentId: 'old' })
    ).rejects.toThrow('Unsupported Doxum storage format');
    const retained = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name, 4);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const r = retained.transaction('legacy').objectStore('legacy').get('sentinel');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(value).toBe('keep');
    retained.close();
    documentRuntime.dispose();
  });
  it('exposes stable observable state through persistence, leadership transfer and disposal', async () => {
    const name = database();
    const leaderRuntime = runtime();
    const followerRuntime = runtime();
    const errors: unknown[] = [];
    const leader = await attachLocalSync({
      runtime: leaderRuntime,
      database: name,
      documentId: 'observable',
      onError: error => errors.push(error),
    });
    const follower = await attachLocalSync({
      runtime: followerRuntime,
      database: name,
      documentId: 'observable',
    });
    const store = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const status = project({ state: project(follower.state) }, ({ state }) => state.status);
    const snapshot = leader.state.current();
    const revision = leader.state.revision();
    await leader.flush();
    expect(leader.state.current()).toBe(snapshot);
    expect(leader.state.revision()).toBe(revision);
    const heads: number[] = [];
    leader.state.subscribe(() => {
      throw new Error('observer');
    });
    leader.state.subscribe(() => {
      const state = leader.state.current();
      if (state.status !== 'disposed') heads.push(state.headSeq);
    });
    leaderRuntime.update(tx => (tx.title = 'persisted'));
    await leader.flush();
    expect(heads).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(leader.state.current().status).toBe('leader');
    expect(store.get(status)).toBe('follower');
    await leader.dispose();
    await waitFor(() => store.get(status) === 'leader');
    store.dispose();
    const states: string[] = [];
    follower.state.subscribe(() => states.push(follower.state.current().status));
    await follower.dispose();
    expect(states).toEqual(['disposed']);
    expect(follower.state.current()).toBe(follower.state.current());
    expect(() => follower.state.subscribe(() => {})).toThrow('disposed');
    leaderRuntime.dispose();
    followerRuntime.dispose();
  });
  it('keeps leader runtime writes synchronous and persists their commands in order', async () => {
    const name = database();
    const firstRuntime = runtime();
    const first = await attachLocalSync({
      runtime: firstRuntime,
      database: name,
      documentId: 'document',
    });
    expect(first.state.current()).toEqual({ status: 'leader', headSeq: 0, checkpointSeq: 0 });
    expect(() => firstRuntime.replace(initial)).toThrow(LocalSyncUnsupportedOperationError);
    expect(() =>
      firstRuntime.apply(
        { changes: [] },
        { expectedRevision: firstRuntime.revision(), source: 'remote' }
      )
    ).toThrow(LocalSyncUnsupportedOperationError);
    const update = firstRuntime.update(tx => {
      tx.title = 'two';
      return tx.title;
    });
    expect(update.status).toBe('committed');
    if (update.status === 'committed') expect(update.value).toBe('two');
    expect(select(firstRuntime, read => read.title)).toBe('two');
    await first.flush();
    expect(first.state.current()).toEqual({ status: 'leader', headSeq: 1, checkpointSeq: 0 });
    await first.dispose();
    expect(firstRuntime.update(tx => (tx.title = 'detached')).status).toBe('committed');
    const restoredRuntime = runtime();
    const restored = await attachLocalSync({
      runtime: restoredRuntime,
      database: name,
      documentId: 'document',
    });
    expect(restored.state.current()).toEqual({ status: 'leader', headSeq: 1, checkpointSeq: 0 });
    expect(select(restoredRuntime, read => read.title)).toBe('two');
    await restored.dispose();
  });
  it('allows one leader, applies ordered commands in followers, and transfers leadership', async () => {
    const name = database();
    const leaderRuntime = runtime();
    const followerRuntime = runtime();
    const leader = await attachLocalSync({
      runtime: leaderRuntime,
      database: name,
      documentId: 'document',
    });
    const follower = await attachLocalSync({
      runtime: followerRuntime,
      database: name,
      documentId: 'document',
    });
    expect(leader.state.current().status).toBe('leader');
    expect(follower.state.current()).toEqual({ status: 'follower', headSeq: 0, checkpointSeq: 0 });
    expect(() => followerRuntime.update(tx => (tx.title = 'forbidden'))).toThrow(
      LocalSyncReadOnlyError
    );
    expect(() =>
      followerRuntime.apply({ changes: [] }, { expectedRevision: followerRuntime.revision() })
    ).toThrow(LocalSyncReadOnlyError);
    expect(() => followerRuntime.replace(initial)).toThrow(LocalSyncReadOnlyError);
    leaderRuntime.update(tx => (tx.title = 'two'));
    await leader.flush();
    await waitFor(() => select(followerRuntime, read => read.title) === 'two');
    expect(follower.state.current()).toEqual({ status: 'follower', headSeq: 1, checkpointSeq: 0 });
    expect(followerRuntime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    await leader.dispose();
    await waitFor(() => follower.state.current().status === 'leader');
    followerRuntime.update(tx => (tx.tasks.get('a')!.title = 'AA'));
    await follower.flush();
    expect(follower.state.current()).toEqual({ status: 'leader', headSeq: 2, checkpointSeq: 0 });
    expect(select(followerRuntime, read => read.tasks.get('a')?.title)).toBe('AA');
    await follower.dispose();
  });
  it('uses runtime history directly and persists undo and redo as commands', async () => {
    const documentRuntime = runtime();
    const localSync = await attachLocalSync({
      runtime: documentRuntime,
      database: database(),
      documentId: 'document',
    });
    documentRuntime.update(tx => (tx.title = 'two'));
    documentRuntime.update(tx => (tx.title = 'three'));
    expect(documentRuntime.history.undo().status).toBe('committed');
    expect(select(documentRuntime, read => read.title)).toBe('two');
    expect(documentRuntime.history.redo().status).toBe('committed');
    expect(select(documentRuntime, read => read.title)).toBe('three');
    await localSync.flush();
    expect(localSync.state.current()).toEqual({ status: 'leader', headSeq: 4, checkpointSeq: 0 });
    expect(documentRuntime.history.current()).toEqual({ undoDepth: 2, redoDepth: 0 });
    await localSync.dispose();
  });
  it('clears history that predates attachment', async () => {
    const documentRuntime = runtime();
    documentRuntime.update(tx => (tx.title = 'two'));
    expect(documentRuntime.history.current()).toEqual({ undoDepth: 1, redoDepth: 0 });
    const localSync = await attachLocalSync({
      runtime: documentRuntime,
      database: database(),
      documentId: 'document',
    });
    expect(documentRuntime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    await localSync.dispose();
  });
  it('persists system commits because they are runtime commits too', async () => {
    const documentRuntime = runtime();
    const localSync = await attachLocalSync({
      runtime: documentRuntime,
      database: database(),
      documentId: 'document',
    });
    expect(documentRuntime.update(tx => (tx.title = 'two'), { source: 'system' }).status).toBe(
      'committed'
    );
    await localSync.flush();
    expect(localSync.state.current()).toEqual({ status: 'leader', headSeq: 1, checkpointSeq: 0 });
    await localSync.dispose();
  });
  it('reports non-JSON local commands after their synchronous runtime commit', async () => {
    const documentRuntime = runtime();
    const localSync = await attachLocalSync({
      runtime: documentRuntime,
      database: database(),
      documentId: 'document',
    });
    expect(documentRuntime.update(tx => (tx.title = new Date() as never)).status).toBe('committed');
    expect(select(documentRuntime, read => read.title)).toBeInstanceOf(Date);
    await waitFor(() => localSync.state.current().status === 'error');
    expect(localSync.state.current()).toMatchObject({
      status: 'error',
      headSeq: 0,
      checkpointSeq: 0,
    });
    await expect(localSync.flush()).rejects.toBeInstanceOf(LocalSyncDataError);
    await localSync.dispose();
  });
  it('reports command-limit failures after the document has committed synchronously', async () => {
    const documentRuntime = runtime();
    const localSync = await attachLocalSync({
      runtime: documentRuntime,
      database: database(),
      documentId: 'document',
      changeLimits: { maxChanges: 1 },
    });
    expect(
      documentRuntime.update(tx => {
        tx.tasks.get('a')!.title = 'AA';
        tx.tasks.get('a')!.complete = true;
      }).status
    ).toBe('committed');
    expect(select(documentRuntime, read => read.title)).toBe('one');
    expect(select(documentRuntime, read => read.tasks.get('a')?.title)).toBe('AA');
    await waitFor(() => localSync.state.current().status === 'error');
    await expect(localSync.flush()).rejects.toBeInstanceOf(LocalSyncDataError);
    await localSync.dispose();
  });
  it('replays previously admitted commits under smaller current write limits', async () => {
    const schema = object({ values: map(field<number>()) });
    const databaseName = database();
    const leader = createDocument({ schema, initial: { values: {} } });
    const sync = await attachLocalSync({
      runtime: leader,
      database: databaseName,
      documentId: 'document',
      changeLimits: { maxChanges: 2000 },
    });
    expect(
      leader.update(d => {
        for (let i = 0; i < 1500; i++) d.values[String(i)] = i;
      }).status
    ).toBe('committed');
    await sync.flush();
    const follower = createDocument({ schema, initial: { values: {} } });
    const followerSync = await attachLocalSync({
      runtime: follower,
      database: databaseName,
      documentId: 'document',
      changeLimits: { maxChanges: 1 },
    });
    expect(follower.snapshot()).toEqual(leader.snapshot());
    await followerSync.dispose();
    await sync.dispose();
    const reopened = createDocument({ schema, initial: { values: {} } });
    const reopenedSync = await attachLocalSync({
      runtime: reopened,
      database: databaseName,
      documentId: 'document',
      changeLimits: { maxChanges: 1 },
    });
    expect(reopened.snapshot()).toEqual(leader.snapshot());
    expect(
      reopened.update(d => {
        d.values['0'] = -1;
      }).status
    ).toBe('committed');
    await reopenedSync.flush();
    await reopenedSync.dispose();
    reopened.dispose();
    follower.dispose();
    leader.dispose();
  });
});
