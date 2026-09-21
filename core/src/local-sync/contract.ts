import type { ObjectSchema } from '@/schema/model';
import type { DocumentRuntime } from '@/runtime/contract';
import type { JsonChangeLimits } from './json';
import type { Readable } from '@/readable';
import type { LocalSyncError } from './error';

export type LocalSyncState =
  | {
      readonly status: 'leader' | 'follower';
      readonly headSeq: number;
      readonly checkpointSeq: number;
    }
  | {
      readonly status: 'error';
      readonly headSeq: number;
      readonly checkpointSeq: number;
      readonly error: LocalSyncError;
    }
  | { readonly status: 'disposed' };

export type LocalSync = {
  readonly state: Readable<LocalSyncState>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export type AttachLocalSyncOptions<TSchema extends ObjectSchema<object>> = {
  readonly runtime: DocumentRuntime<TSchema>;
  readonly database: string;
  readonly documentId: string;
  readonly schemaVersion?: number;
  /** Admission limits for new local commits; durable replay does not reapply them. */
  readonly changeLimits?: JsonChangeLimits;
  readonly onError?: (error: LocalSyncError) => void;
};
