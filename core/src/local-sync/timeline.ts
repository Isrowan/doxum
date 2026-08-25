import { isRecord } from '../value/ownership';
import { decodeCommandFootprint, type CommandFootprint } from '../mutation/footprint';
import {
  LocalSyncConsistencyError,
  LocalSyncSchemaError,
  LocalSyncUnavailableError,
} from './contract';
import { json, jsonArray, type JsonValue } from './json';

const DATABASE_VERSION = 1;
const DOCUMENTS = 'documents';
const COMMITS = 'commits';
const ACTORS = 'actors';

export type LocalCommitKind = 'update' | 'undo' | 'redo';

export type StoredDocument = {
  readonly documentId: string;
  readonly schemaVersion: number;
  readonly checkpointSeq: number;
  readonly headSeq: number;
  readonly checkpoint: JsonValue;
};

export type StoredHistoryEntry = {
  readonly commandId: string;
  readonly operations: readonly JsonValue[];
  readonly inverse: readonly JsonValue[];
  readonly footprint: CommandFootprint;
};

export type StoredActorHistory = {
  readonly documentId: string;
  readonly actorId: string;
  readonly undo: readonly StoredHistoryEntry[];
  readonly redo: readonly StoredHistoryEntry[];
};

export type StoredCommit = {
  readonly documentId: string;
  readonly seq: number;
  readonly commandId: string;
  readonly actorId: string;
  readonly kind: LocalCommitKind;
  readonly operations: readonly JsonValue[];
  readonly inverse: readonly JsonValue[];
  readonly footprint: CommandFootprint;
  readonly createdAt: number;
};

export type ActorHistoryChange =
  | { readonly kind: 'record'; readonly entry: StoredHistoryEntry; readonly capacity: number }
  | {
      readonly kind: 'undo';
      readonly expectedCommandId: string;
      readonly entry: StoredHistoryEntry;
    }
  | {
      readonly kind: 'redo';
      readonly expectedCommandId: string;
      readonly entry: StoredHistoryEntry;
    };

const request = <T>(value: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed.'));
  });

const complete = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });

const factory = (): IDBFactory => {
  if (!globalThis.indexedDB) throw new LocalSyncUnavailableError('IndexedDB');
  return globalThis.indexedDB;
};

const keyRange = (): typeof IDBKeyRange => {
  if (!globalThis.IDBKeyRange) throw new LocalSyncUnavailableError('IndexedDB');
  return globalThis.IDBKeyRange;
};

const string = (value: unknown, label: string): string => {
  if (typeof value === 'string') return value;
  throw new LocalSyncConsistencyError(`${label} is malformed in IndexedDB.`);
};

const nonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new LocalSyncConsistencyError(`${label} is malformed in IndexedDB.`);
};

const positiveInteger = (value: unknown, label: string): number => {
  const parsed = nonNegativeInteger(value, label);
  if (parsed > 0) return parsed;
  throw new LocalSyncConsistencyError(`${label} is malformed in IndexedDB.`);
};

const historyEntry = (value: unknown, label: string): StoredHistoryEntry => {
  if (!isRecord(value)) throw new LocalSyncConsistencyError(`${label} is malformed in IndexedDB.`);
  const footprint = decodeCommandFootprint(value.footprint);
  if (!footprint)
    throw new LocalSyncConsistencyError(`${label}.footprint is malformed in IndexedDB.`);
  return Object.freeze({
    commandId: string(value.commandId, `${label}.commandId`),
    operations: jsonArray(value.operations, `${label}.operations`),
    inverse: jsonArray(value.inverse, `${label}.inverse`),
    footprint,
  });
};

const historyEntries = (value: unknown, label: string): readonly StoredHistoryEntry[] => {
  if (!Array.isArray(value))
    throw new LocalSyncConsistencyError(`${label} is malformed in IndexedDB.`);
  return Object.freeze(value.map((entry, index) => historyEntry(entry, `${label}.${index}`)));
};

const documentRecord = (value: unknown): StoredDocument => {
  if (!isRecord(value))
    throw new LocalSyncConsistencyError('Document record is malformed in IndexedDB.');
  const checkpointSeq = nonNegativeInteger(value.checkpointSeq, 'document.checkpointSeq');
  const headSeq = nonNegativeInteger(value.headSeq, 'document.headSeq');
  if (checkpointSeq > headSeq)
    throw new LocalSyncConsistencyError('Document checkpoint exceeds its head sequence.');
  return Object.freeze({
    documentId: string(value.documentId, 'document.documentId'),
    schemaVersion: positiveInteger(value.schemaVersion, 'document.schemaVersion'),
    checkpointSeq,
    headSeq,
    checkpoint: json(value.checkpoint, 'document.checkpoint'),
  });
};

const commitRecord = (value: unknown): StoredCommit => {
  if (!isRecord(value))
    throw new LocalSyncConsistencyError('Commit record is malformed in IndexedDB.');
  const kind = value.kind;
  if (kind !== 'update' && kind !== 'undo' && kind !== 'redo')
    throw new LocalSyncConsistencyError('Commit kind is malformed in IndexedDB.');
  const footprint = decodeCommandFootprint(value.footprint);
  if (!footprint)
    throw new LocalSyncConsistencyError('Commit footprint is malformed in IndexedDB.');
  return Object.freeze({
    documentId: string(value.documentId, 'commit.documentId'),
    seq: positiveInteger(value.seq, 'commit.seq'),
    commandId: string(value.commandId, 'commit.commandId'),
    actorId: string(value.actorId, 'commit.actorId'),
    kind,
    operations: jsonArray(value.operations, 'commit.operations'),
    inverse: jsonArray(value.inverse, 'commit.inverse'),
    footprint,
    createdAt: nonNegativeInteger(value.createdAt, 'commit.createdAt'),
  });
};

const actorRecord = (value: unknown, documentId: string, actorId: string): StoredActorHistory => {
  if (value === undefined)
    return Object.freeze({
      documentId,
      actorId,
      undo: Object.freeze([]),
      redo: Object.freeze([]),
    });
  if (!isRecord(value))
    throw new LocalSyncConsistencyError('Actor history is malformed in IndexedDB.');
  const storedDocumentId = string(value.documentId, 'actor.documentId');
  const storedActorId = string(value.actorId, 'actor.actorId');
  if (storedDocumentId !== documentId || storedActorId !== actorId)
    throw new LocalSyncConsistencyError('Actor history key does not match its record.');
  return Object.freeze({
    documentId,
    actorId,
    undo: historyEntries(value.undo, 'actor.undo'),
    redo: historyEntries(value.redo, 'actor.redo'),
  });
};

const nextHistory = (
  current: StoredActorHistory,
  change: ActorHistoryChange
): StoredActorHistory => {
  if (change.kind === 'record') {
    const undo = [...current.undo, change.entry];
    const start = Math.max(0, undo.length - change.capacity);
    return Object.freeze({
      documentId: current.documentId,
      actorId: current.actorId,
      undo: Object.freeze(undo.slice(start)),
      redo: Object.freeze([]),
    });
  }
  const source = change.kind === 'undo' ? current.undo : current.redo;
  const latest = source[source.length - 1];
  if (!latest || latest.commandId !== change.expectedCommandId)
    throw new LocalSyncConsistencyError('Local undo history changed before it could be committed.');
  if (change.kind === 'undo')
    return Object.freeze({
      documentId: current.documentId,
      actorId: current.actorId,
      undo: Object.freeze(current.undo.slice(0, -1)),
      redo: Object.freeze([...current.redo, change.entry]),
    });
  return Object.freeze({
    documentId: current.documentId,
    actorId: current.actorId,
    undo: Object.freeze([...current.undo, change.entry]),
    redo: Object.freeze(current.redo.slice(0, -1)),
  });
};

const deleteCommitsThrough = async (
  store: IDBObjectStore,
  documentId: string,
  seq: number
): Promise<void> => {
  const range = keyRange().bound([documentId, 0], [documentId, seq]);
  await new Promise<void>((resolve, reject) => {
    const cursor = store.openCursor(range);
    cursor.onerror = () => reject(cursor.error ?? new Error('IndexedDB cursor failed.'));
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) {
        resolve();
        return;
      }
      current.delete();
      current.continue();
    };
  });
};

export type IndexedDbTimeline = {
  readonly initialize: (
    documentId: string,
    schemaVersion: number,
    checkpoint: JsonValue
  ) => Promise<StoredDocument>;
  readonly read: (documentId: string) => Promise<StoredDocument>;
  readonly tail: (documentId: string, afterSeq: number) => Promise<readonly StoredCommit[]>;
  readonly history: (documentId: string, actorId: string) => Promise<StoredActorHistory>;
  readonly append: (input: {
    readonly documentId: string;
    readonly expectedHeadSeq: number;
    readonly commandId: string;
    readonly actorId: string;
    readonly kind: LocalCommitKind;
    readonly operations: readonly JsonValue[];
    readonly inverse: readonly JsonValue[];
    readonly footprint: CommandFootprint;
    readonly history: ActorHistoryChange;
  }) => Promise<StoredCommit>;
  readonly compact: (
    documentId: string,
    seq: number,
    checkpoint: JsonValue
  ) => Promise<StoredDocument>;
  readonly close: () => void;
};

export const openIndexedDbTimeline = async (databaseName: string): Promise<IndexedDbTimeline> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory().open(databaseName, DATABASE_VERSION);
    open.onerror = () => reject(open.error ?? new Error('Unable to open IndexedDB.'));
    open.onblocked = () => reject(new Error(`IndexedDB database '${databaseName}' is blocked.`));
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(DOCUMENTS))
        db.createObjectStore(DOCUMENTS, { keyPath: 'documentId' });
      if (!db.objectStoreNames.contains(COMMITS))
        db.createObjectStore(COMMITS, { keyPath: ['documentId', 'seq'] });
      if (!db.objectStoreNames.contains(ACTORS))
        db.createObjectStore(ACTORS, { keyPath: ['documentId', 'actorId'] });
    };
    open.onsuccess = () => resolve(open.result);
  });

  const readDocument = async (
    transaction: IDBTransaction,
    documentId: string
  ): Promise<StoredDocument> => {
    const value = await request(transaction.objectStore(DOCUMENTS).get(documentId));
    if (value === undefined)
      throw new LocalSyncConsistencyError(`Local document '${documentId}' does not exist.`);
    return documentRecord(value);
  };

  return {
    initialize: async (documentId, schemaVersion, checkpoint) => {
      const transaction = database.transaction(DOCUMENTS, 'readwrite');
      const store = transaction.objectStore(DOCUMENTS);
      const existing = await request(store.get(documentId));
      if (existing !== undefined) {
        const record = documentRecord(existing);
        if (record.schemaVersion !== schemaVersion)
          throw new LocalSyncSchemaError(documentId, schemaVersion, record.schemaVersion);
        await complete(transaction);
        return record;
      }
      const record: StoredDocument = {
        documentId,
        schemaVersion,
        checkpointSeq: 0,
        headSeq: 0,
        checkpoint,
      };
      store.put(record);
      await complete(transaction);
      return Object.freeze(record);
    },
    read: async documentId => {
      const transaction = database.transaction(DOCUMENTS, 'readonly');
      const record = await readDocument(transaction, documentId);
      await complete(transaction);
      return record;
    },
    tail: async (documentId, afterSeq) => {
      const transaction = database.transaction(COMMITS, 'readonly');
      const range = keyRange().bound(
        [documentId, afterSeq + 1],
        [documentId, Number.MAX_SAFE_INTEGER]
      );
      const values = await request(transaction.objectStore(COMMITS).getAll(range));
      await complete(transaction);
      return Object.freeze(values.map(commitRecord).sort((left, right) => left.seq - right.seq));
    },
    history: async (documentId, actorId) => {
      const transaction = database.transaction(ACTORS, 'readonly');
      const value = await request(transaction.objectStore(ACTORS).get([documentId, actorId]));
      await complete(transaction);
      return actorRecord(value, documentId, actorId);
    },
    append: async input => {
      const transaction = database.transaction([DOCUMENTS, COMMITS, ACTORS], 'readwrite');
      const documents = transaction.objectStore(DOCUMENTS);
      const commits = transaction.objectStore(COMMITS);
      const actors = transaction.objectStore(ACTORS);
      const current = await readDocument(transaction, input.documentId);
      if (current.headSeq !== input.expectedHeadSeq)
        throw new LocalSyncConsistencyError(
          'Local document advanced before the writer lock was acquired.'
        );
      const actor = actorRecord(
        await request(actors.get([input.documentId, input.actorId])),
        input.documentId,
        input.actorId
      );
      const seq = current.headSeq + 1;
      const commit: StoredCommit = {
        documentId: input.documentId,
        seq,
        commandId: input.commandId,
        actorId: input.actorId,
        kind: input.kind,
        operations: input.operations,
        inverse: input.inverse,
        footprint: input.footprint,
        createdAt: Date.now(),
      };
      const nextDocument: StoredDocument = { ...current, headSeq: seq };
      commits.put(commit);
      documents.put(nextDocument);
      actors.put(nextHistory(actor, input.history));
      await complete(transaction);
      return Object.freeze(commit);
    },
    compact: async (documentId, seq, checkpoint) => {
      const transaction = database.transaction([DOCUMENTS, COMMITS], 'readwrite');
      const current = await readDocument(transaction, documentId);
      if (seq < current.checkpointSeq || seq > current.headSeq)
        throw new LocalSyncConsistencyError(
          'Local checkpoint sequence is outside the durable timeline.'
        );
      const next: StoredDocument = { ...current, checkpointSeq: seq, checkpoint };
      transaction.objectStore(DOCUMENTS).put(next);
      await deleteCommitsThrough(transaction.objectStore(COMMITS), documentId, seq);
      await complete(transaction);
      return Object.freeze(next);
    },
    close: () => database.close(),
  };
};
