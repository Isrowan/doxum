import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { field, object, schema, select, table } from '../src';
import { LocalSyncDataError, openLocalDocument } from '../src/local-sync';

class TestLockManager {
  #tail = Promise.resolve();

  request<T>(
    _name: string,
    _options: { readonly mode: 'exclusive' },
    callback: () => T | PromiseLike<T>
  ): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise(resolve => {
      release = resolve;
    });
    return previous.then(callback, callback).finally(release);
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
const documentSchema = schema({
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

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for local sync.');
};

describe('local sync', () => {
  it('persists prepared commands before exposing the committed document', async () => {
    const name = database();
    const first = await openLocalDocument({
      database: name,
      documentId: 'document',
      schema: documentSchema,
      initial,
    });
    const update = await first.update(tx => {
      tx.write.title.set('two');
      return tx.read.title.get();
    });
    expect(update.status).toBe('committed');
    if (update.status === 'committed') {
      expect(update.value).toBe('two');
      expect(update.commit.seq).toBe(1);
    }
    expect(select(first.document, read => read.title.get())).toBe('two');
    await first.dispose();

    const restored = await openLocalDocument({
      database: name,
      documentId: 'document',
      schema: documentSchema,
      initial,
    });
    expect(select(restored.document, read => read.title.get())).toBe('two');
    expect(restored.state()).toEqual({ status: 'ready', headSeq: 1, checkpointSeq: 0 });
    await restored.dispose();
  });

  it('serializes cross-tab writes and recovers a tab from a compacted checkpoint', async () => {
    const name = database();
    const first = await openLocalDocument({
      database: name,
      documentId: 'document',
      schema: documentSchema,
      initial,
      checkpointEvery: 1,
    });
    const second = await openLocalDocument({
      database: name,
      documentId: 'document',
      schema: documentSchema,
      initial,
      checkpointEvery: 1,
    });
    await first.update(tx => tx.write.title.set('two'));
    await waitFor(() => select(second.document, read => read.title.get()) === 'two');
    expect(select(second.document, read => read.title.get())).toBe('two');
    expect(second.state()).toEqual({ status: 'ready', headSeq: 1, checkpointSeq: 1 });

    await Promise.all([
      first.update(tx => tx.write.tasks.item('a').title.set('AA')),
      second.update(tx => tx.write.title.set('three')),
    ]);
    await first.sync();
    await second.sync();
    const firstSnapshot = select(first.document, read => ({
      title: read.title.get(),
      task: read.tasks.get('a')?.title.get(),
    }));
    const secondSnapshot = select(second.document, read => ({
      title: read.title.get(),
      task: read.tasks.get('a')?.title.get(),
    }));
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(first.state().status).toBe('ready');
    const firstState = first.state();
    if (firstState.status === 'ready') expect(firstState.headSeq).toBe(3);
    await first.dispose();
    await second.dispose();
  });

  it('records durable local undo and redo as new timeline commits', async () => {
    const local = await openLocalDocument({
      database: database(),
      documentId: 'document',
      schema: documentSchema,
      initial,
    });
    await local.update(tx => tx.write.title.set('two'));
    await local.update(tx => tx.write.title.set('three'));
    const undone = await local.undo();
    expect(undone.status).toBe('committed');
    if (undone.status === 'committed') expect(undone.commit.seq).toBe(3);
    expect(select(local.document, read => read.title.get())).toBe('two');
    const redone = await local.redo();
    expect(redone.status).toBe('committed');
    if (redone.status === 'committed') expect(redone.commit.seq).toBe(4);
    expect(select(local.document, read => read.title.get())).toBe('three');
    await local.dispose();
  });

  it('rejects non-JSON local payloads before durable state or the document changes', async () => {
    const local = await openLocalDocument({
      database: database(),
      documentId: 'document',
      schema: documentSchema,
      initial,
    });
    await expect(
      local.update(tx => tx.write.title.set(new Date() as never))
    ).rejects.toBeInstanceOf(LocalSyncDataError);
    expect(select(local.document, read => read.title.get())).toBe('one');
    expect(local.state().status).toBe('ready');
    await local.dispose();
  });

  it('rejects local commands that exceed the configured operation limit', async () => {
    const local = await openLocalDocument({
      database: database(),
      documentId: 'document',
      schema: documentSchema,
      initial,
      commandLimits: { maxOperations: 1 },
    });
    await expect(
      local.update(tx => {
        tx.write.title.set('two');
        tx.write.tasks.item('a').title.set('AA');
      })
    ).rejects.toBeInstanceOf(LocalSyncDataError);
    expect(select(local.document, read => read.title.get())).toBe('one');
    expect(select(local.document, read => read.tasks.get('a')?.title.get())).toBe('A');
    expect(local.state()).toEqual({ status: 'ready', headSeq: 0, checkpointSeq: 0 });
    await local.dispose();
  });
});
