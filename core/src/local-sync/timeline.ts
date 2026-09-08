import {
  LocalSyncConsistencyError,
  LocalSyncSchemaError,
  LocalSyncUnavailableError,
} from './contract';
import { json, jsonChanges, type JsonValue } from './json';
import type { ChangeSet } from '../changes';
import { isRecord } from '../value/ownership';

const DATABASE_VERSION = 4;
const FORMAT_VERSION = 2;
const DOCUMENTS = 'documents';
const COMMITS = 'commits';

export type StoredDocument = {
  readonly formatVersion: number;
  readonly documentId: string;
  readonly schemaVersion: number;
  readonly checkpointSeq: number;
  readonly headSeq: number;
  readonly checkpoint: JsonValue;
};

export type StoredCommit = {
  readonly formatVersion: number;
  readonly documentId: string;
  readonly seq: number;
  readonly changes: ChangeSet;
  readonly createdAt: number;
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

const documentRecord = (value: unknown): StoredDocument => {
  if (!isRecord(value) || value.formatVersion !== FORMAT_VERSION)
    throw new LocalSyncConsistencyError('Document record is malformed in IndexedDB.');
  const checkpointSeq = nonNegativeInteger(value.checkpointSeq, 'document.checkpointSeq');
  const headSeq = nonNegativeInteger(value.headSeq, 'document.headSeq');
  if (checkpointSeq > headSeq)
    throw new LocalSyncConsistencyError('Document checkpoint exceeds its head sequence.');
  return Object.freeze({
    formatVersion: FORMAT_VERSION,
    documentId: string(value.documentId, 'document.documentId'),
    schemaVersion: positiveInteger(value.schemaVersion, 'document.schemaVersion'),
    checkpointSeq,
    headSeq,
    checkpoint: json(value.checkpoint, 'document.checkpoint'),
  });
};

const commitRecord = (value: unknown): StoredCommit => {
  if (!isRecord(value) || value.formatVersion !== FORMAT_VERSION)
    throw new LocalSyncConsistencyError('Commit record is malformed in IndexedDB.');
  return Object.freeze({
    formatVersion: FORMAT_VERSION,
    documentId: string(value.documentId, 'commit.documentId'),
    seq: positiveInteger(value.seq, 'commit.seq'),
    changes: jsonChanges({ changes: value.changes }, 'commit.changes'),
    createdAt: nonNegativeInteger(value.createdAt, 'commit.createdAt'),
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
  readonly append: (input: {
    readonly documentId: string;
    readonly expectedHeadSeq: number;
    readonly changes: ChangeSet;
  }) => Promise<StoredCommit>;
  readonly close: () => void;
};

export const openIndexedDbTimeline = async (databaseName: string): Promise<IndexedDbTimeline> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let incompatible = false;
    const open = factory().open(databaseName, DATABASE_VERSION);
    open.onerror = () =>
      reject(
        incompatible
          ? new LocalSyncConsistencyError(
              'Unsupported Doxum storage format. Existing data was left unchanged.'
            )
          : (open.error ?? new Error('Unable to open IndexedDB.'))
      );
    open.onblocked = () => reject(new Error(`IndexedDB database '${databaseName}' is blocked.`));
    open.onupgradeneeded = event => {
      if (event.oldVersion !== 0) {
        incompatible = true;
        open.transaction?.abort();
        return;
      }
      const db = open.result;
      if (!db.objectStoreNames.contains(DOCUMENTS))
        db.createObjectStore(DOCUMENTS, { keyPath: 'documentId' });
      if (!db.objectStoreNames.contains(COMMITS))
        db.createObjectStore(COMMITS, { keyPath: ['documentId', 'seq'] });
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
        formatVersion: FORMAT_VERSION,
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
    append: async input => {
      const transaction = database.transaction([DOCUMENTS, COMMITS], 'readwrite');
      const documents = transaction.objectStore(DOCUMENTS);
      const current = await readDocument(transaction, input.documentId);
      if (current.headSeq !== input.expectedHeadSeq)
        throw new LocalSyncConsistencyError(
          'Local document advanced before the leader could append its commit.'
        );
      const commit: StoredCommit = {
        formatVersion: FORMAT_VERSION,
        documentId: input.documentId,
        seq: current.headSeq + 1,
        changes: input.changes,
        createdAt: Date.now(),
      };
      documents.put({ ...current, headSeq: commit.seq });
      transaction.objectStore(COMMITS).put({ ...commit, changes: commit.changes.changes });
      await complete(transaction);
      return Object.freeze(commit);
    },
    close: () => database.close(),
  };
};
