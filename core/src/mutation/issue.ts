import type { DocumentAddress } from '../schema';
import type { DocumentOperation } from '../operations';

export type MutationIssueCode =
  | 'invalid-address'
  | 'invalid-operation'
  | 'unknown-operation'
  | 'required-field'
  | 'invalid-anchor'
  | 'duplicate-entity'
  | 'missing-entity'
  | 'invalid-collection'
  | 'invalid-list-keys'
  | 'invalid-list-key'
  | 'duplicate-list-item'
  | 'missing-list-item'
  | 'invalid-tree'
  | 'duplicate-tree-node'
  | 'missing-tree-parent'
  | 'invalid-tree-index'
  | 'missing-tree-node'
  | 'tree-cycle';

export type MutationIssue = {
  readonly source: 'mutation';
  readonly code: MutationIssueCode;
  readonly address: DocumentAddress;
  readonly message: string;
  readonly operation?: DocumentOperation['type'];
};

const ownAddress = (address: DocumentAddress): DocumentAddress => Object.freeze(address.slice());

export const at = (
  address: DocumentAddress,
  code: MutationIssueCode,
  message: string,
  operation?: DocumentOperation['type']
): MutationIssue =>
  Object.freeze({
    source: 'mutation',
    code,
    address: ownAddress(address),
    message,
    ...(operation === undefined ? {} : { operation }),
  });

export const from = (
  operation: DocumentOperation,
  code: MutationIssueCode,
  message: string
): MutationIssue => at(operation.at, code, message, operation.type);

export const input = (code: MutationIssueCode, message: string): MutationIssue =>
  at([], code, message);
