import { set as setAddress } from '../address';
import type { ResolvedAddress } from '../address';
import type { DocumentOperationUnion } from '../operations';
import type { MutationOutcome } from './contract';
import * as issue from './issue';
import * as tree from './tree';
import { ownPayload } from '../value/ownership';

type TreeOperation = Extract<
  DocumentOperationUnion,
  {
    type: 'tree.insert' | 'tree.move' | 'tree.remove' | 'tree.set' | 'tree.replace';
  }
>;

const outcome = (operation: TreeOperation, value: tree.TreeOutcome): MutationOutcome =>
  value.status === 'rejected'
    ? {
        status: 'rejected',
        issue: issue.from(operation, value.code, value.message),
      }
    : value;

export const executeTree = (
  root: unknown,
  target: ResolvedAddress,
  operation: TreeOperation,
  copyPayload: boolean
): MutationOutcome => {
  if (!tree.is(target.value))
    return {
      status: 'rejected',
      issue: issue.from(operation, 'invalid-address', 'Tree target is invalid.'),
    };
  const own = <T>(value: T): T => (copyPayload ? ownPayload(value) : value);
  if (operation.type === 'tree.replace') {
    const result = tree.replace(target.value, operation);
    if (result.status === 'changed') setAddress(root, operation.at, ownPayload(operation.value));
    return outcome(operation, result);
  }
  if (operation.type === 'tree.insert')
    return outcome(operation, tree.insert(target.value, operation, own(operation.value)));
  if (operation.type === 'tree.set')
    return outcome(operation, tree.set(target.value, operation, own(operation.value)));
  if (operation.type === 'tree.remove')
    return outcome(operation, tree.remove(target.value, operation));
  return outcome(operation, tree.move(target.value, operation));
};
