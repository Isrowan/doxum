export type LocalSyncErrorCode =
  | 'unavailable'
  | 'schema-mismatch'
  | 'consistency'
  | 'read-only'
  | 'unsupported-operation'
  | 'disposed'
  | 'invalid-data';

export class LocalSyncError extends Error {
  readonly code: LocalSyncErrorCode;

  constructor(code: LocalSyncErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'LocalSyncError';
    this.code = code;
  }
}

export const normalizeLocalSyncError = (
  error: unknown,
  code: LocalSyncErrorCode,
  message: string
): LocalSyncError =>
  error instanceof LocalSyncError ? error : new LocalSyncError(code, message, { cause: error });
