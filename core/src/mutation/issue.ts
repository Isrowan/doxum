import type { DocumentAddress } from '../schema';
import type { ParseIssue } from '../schema-value';

export type MutationIssueCode =
  | 'invalid-address'
  | 'invalid-value'
  | 'invalid-key'
  | 'invalid-changes'
  | 'baseline-mismatch'
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
};
export const at = (
  address: DocumentAddress,
  code: MutationIssueCode,
  message: string
): MutationIssue =>
  Object.freeze({ source: 'mutation', code, address: Object.freeze([...address]), message });
export class MutationRejected extends Error {
  constructor(readonly issue: MutationIssue) {
    super(issue.message);
  }
}
export const fail = (address: DocumentAddress, code: MutationIssueCode, message: string): never => {
  throw new MutationRejected(at(address, code, message));
};

export const invalidValue = (issue: ParseIssue, address = issue.address): never =>
  fail(address, issue.code === 'missing-validator' ? 'invalid-value' : issue.code, issue.message);
