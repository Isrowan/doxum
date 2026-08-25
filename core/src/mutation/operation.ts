import type { DocumentAddress, DocumentSchema } from '../schema';
import type { DocumentAnchor, DocumentOperationUnion } from '../operations';
import { profile } from '../profile';
import { isRecord, isPlainObject, isStablePayload, snapshotPayload } from '../value/ownership';
import type { MutationIssue } from './issue';
import * as issue from './issue';

export type OperationDecode =
  | { readonly status: 'decoded'; readonly operation: DocumentOperationUnion }
  | { readonly status: 'rejected'; readonly issue: MutationIssue };
export type OperationBatchDecode =
  | { readonly status: 'decoded'; readonly operations: readonly unknown[] }
  | { readonly status: 'rejected'; readonly issue: MutationIssue };

const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');
const positions = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.every(entry => Number.isInteger(entry) && entry >= 0);
const address = (value: unknown): value is DocumentAddress => stringArray(value);
const anchor = (value: unknown): value is DocumentAnchor => {
  if (!isRecord(value)) return false;
  const count =
    Number(has(value, 'at')) + Number(has(value, 'before')) + Number(has(value, 'after'));
  if (count !== 1) return false;
  if (has(value, 'at')) return value.at === 'start' || value.at === 'end';
  return typeof (has(value, 'before') ? value.before : value.after) === 'string';
};
const optionalAnchor = (value: Record<string, unknown>): boolean =>
  !has(value, 'anchor') || value.anchor === undefined || anchor(value.anchor);
const optionalParent = (value: Record<string, unknown>): boolean =>
  !has(value, 'parentId') || value.parentId === undefined || typeof value.parentId === 'string';
const optionalIndex = (value: Record<string, unknown>): boolean =>
  !has(value, 'index') ||
  value.index === undefined ||
  (Number.isInteger(value.index) && (value.index as number) >= 0);
const entries = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(entry => isRecord(entry) && typeof entry.id === 'string' && has(entry, 'value'));

const decoded = (operation: DocumentOperationUnion): OperationDecode => ({
  status: 'decoded',
  operation,
});
const rejected = (code: MutationIssue['code'], message: string): OperationDecode => ({
  status: 'rejected',
  issue: issue.input(code, message),
});

export const decode = (input: unknown): OperationDecode => {
  if (!isRecord(input)) return rejected('invalid-operation', 'Operation must be an object.');
  if (!address(input.at)) return rejected('invalid-address', 'Operation address is malformed.');
  if (typeof input.type !== 'string')
    return rejected('invalid-operation', 'Operation type must be a string.');

  switch (input.type) {
    case 'field.set':
    case 'variant.replace':
      return has(input, 'value')
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Operation value is required.');
    case 'field.clear':
      return decoded(input as DocumentOperationUnion);
    case 'dict.set':
      return typeof input.key === 'string' && has(input, 'value')
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Dictionary set requires a string key and value.');
    case 'dict.delete':
      return typeof input.key === 'string'
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Dictionary delete requires a string key.');
    case 'dict.replace':
      return isRecord(input.value)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Dictionary replacement must be an object.');
    case 'entity.create':
      return entries(input.entries) &&
        optionalAnchor(input) &&
        (!has(input, 'positions') || input.positions === undefined || positions(input.positions))
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Entity create payload is malformed.');
    case 'entity.remove':
      return stringArray(input.ids)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Entity remove requires string ids.');
    case 'entity.move':
      return typeof input.id === 'string' && optionalAnchor(input)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Entity move payload is malformed.');
    case 'list.insert':
      return typeof input.key === 'string' && has(input, 'value') && optionalAnchor(input)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'List insert payload is malformed.');
    case 'list.move':
      return typeof input.key === 'string' && optionalAnchor(input)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'List move payload is malformed.');
    case 'list.remove':
      return typeof input.key === 'string'
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'List remove requires a string key.');
    case 'list.replace':
      return Array.isArray(input.value) && stringArray(input.keys)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'List replacement payload is malformed.');
    case 'tree.insert':
      return typeof input.treeNodeId === 'string' && optionalParent(input) && optionalIndex(input)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Tree insert payload is malformed.');
    case 'tree.move':
      return typeof input.treeNodeId === 'string' && optionalParent(input) && optionalIndex(input)
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Tree move payload is malformed.');
    case 'tree.remove':
      return typeof input.treeNodeId === 'string'
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Tree remove requires a node id.');
    case 'tree.set':
      return typeof input.treeNodeId === 'string' && has(input, 'value')
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Tree set payload is malformed.');
    case 'tree.replace':
      return has(input, 'value')
        ? decoded(input as DocumentOperationUnion)
        : rejected('invalid-operation', 'Tree replacement value is required.');
    default:
      return rejected('unknown-operation', 'Unknown document operation.');
  }
};

export const decodeBatch = (input: unknown): OperationBatchDecode =>
  Array.isArray(input)
    ? { status: 'decoded', operations: input }
    : {
        status: 'rejected',
        issue: issue.input('invalid-operation', 'Operation batch must be an array.'),
      };

const ownAddress = (value: DocumentAddress): DocumentAddress => {
  if (Object.isFrozen(value)) return value;
  profile.address.arrayCopied();
  return Object.freeze(value.slice());
};

const structuralPayload = (value: unknown): boolean => Array.isArray(value) || isPlainObject(value);

export const normalize = <TSchema extends DocumentSchema>(
  operation: DocumentOperationUnion<TSchema>
): DocumentOperationUnion<TSchema> => {
  profile.mutation.normalized();
  const copy = {
    ...operation,
    at: ownAddress(operation.at),
  } as DocumentOperationUnion<TSchema> & {
    anchor?: DocumentAnchor;
    keys?: readonly string[];
    entries?: readonly { readonly id: string; readonly value: unknown }[];
    ids?: readonly string[];
    positions?: readonly number[];
    value?: unknown;
  };
  if (copy.anchor) copy.anchor = Object.freeze({ ...copy.anchor });
  if (copy.keys) copy.keys = Object.freeze([...copy.keys]);
  if (copy.entries)
    copy.entries = Object.freeze(copy.entries.map(entry => Object.freeze({ ...entry })));
  if (copy.ids) copy.ids = Object.freeze([...copy.ids]);
  if (copy.positions) copy.positions = Object.freeze([...copy.positions]);
  return Object.freeze(copy);
};

export const publish = <TSchema extends DocumentSchema>(
  operation: DocumentOperationUnion<TSchema>
): DocumentOperationUnion<TSchema> => {
  if (
    operation.type === 'entity.create' &&
    operation.entries.every(
      entry => !structuralPayload(entry.value) || isStablePayload(entry.value)
    )
  )
    return operation;
  if (
    'value' in operation &&
    (!structuralPayload(operation.value) || isStablePayload(operation.value))
  )
    return operation;
  const copy = { ...operation } as DocumentOperationUnion<TSchema> & {
    value?: unknown;
    entries?: readonly { readonly id: string; readonly value: unknown }[];
  };
  if (copy.entries)
    copy.entries = Object.freeze(
      copy.entries.map(entry =>
        Object.freeze({
          id: entry.id,
          value: structuralPayload(entry.value)
            ? isStablePayload(entry.value)
              ? entry.value
              : snapshotPayload(entry.value, 'commit')
            : entry.value,
        })
      )
    );
  else if ('value' in copy && structuralPayload(copy.value))
    copy.value = isStablePayload(copy.value) ? copy.value : snapshotPayload(copy.value, 'commit');
  return Object.freeze(copy);
};

// Published operation snapshots are frozen so they can be safely retained by
// commits, history, or a persistence adapter. Replaying one must clone its
// structural payload before it becomes canonical mutable document state.
export const requiresPayloadCopy = (operation: DocumentOperationUnion): boolean => {
  if (operation.type === 'entity.create')
    return operation.entries.some(entry => isStablePayload(entry.value));
  return 'value' in operation && isStablePayload(operation.value);
};

export const inverse = <TSchema extends DocumentSchema>(
  operation: DocumentOperationUnion<TSchema>
): DocumentOperationUnion<TSchema> => {
  const copy = { ...operation } as DocumentOperationUnion<TSchema> & {
    anchor?: DocumentAnchor;
    keys?: readonly string[];
    entries?: readonly { readonly id: string; readonly value: unknown }[];
    ids?: readonly string[];
    positions?: readonly number[];
  };
  if (copy.anchor) copy.anchor = Object.freeze({ ...copy.anchor });
  if (copy.keys) copy.keys = Object.freeze([...copy.keys]);
  if (copy.entries)
    copy.entries = Object.freeze(
      copy.entries.map(entry =>
        Object.freeze({
          id: entry.id,
          value: structuralPayload(entry.value)
            ? isStablePayload(entry.value)
              ? entry.value
              : snapshotPayload(entry.value, 'inverse')
            : entry.value,
        })
      )
    );
  if (copy.ids) copy.ids = Object.freeze([...copy.ids]);
  if (copy.positions) copy.positions = Object.freeze([...copy.positions]);
  if ('value' in copy && structuralPayload(copy.value)) {
    const payload = copy as { value?: unknown };
    payload.value = isStablePayload(payload.value)
      ? payload.value
      : snapshotPayload(payload.value, 'inverse');
  }
  return Object.freeze(copy);
};
