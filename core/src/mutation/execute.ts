import type { ResolvedAddress } from '../address';
import type { DocumentOperationUnion } from '../operations';
import type { MutationOutcome } from './contract';
import * as issue from './issue';
import { executeEntity } from './execute-entity';
import { executeList } from './execute-list';
import { executeTree } from './execute-tree';
import { executeValue } from './execute-value';

const invalidTarget = (operation: DocumentOperationUnion): MutationOutcome => ({
  status: 'rejected',
  issue: issue.from(
    operation,
    'invalid-address',
    `Operation '${operation.type}' does not match the schema address.`
  ),
});

// Operations reach this dispatcher only after operation.decode and
// operation.normalize. Executors therefore only validate their domain-specific
// semantics against one resolved schema address.
export const execute = (
  root: unknown,
  operation: DocumentOperationUnion,
  target: ResolvedAddress | undefined,
  copyPayload: boolean
): MutationOutcome => {
  if (operation.type === 'field.set' || operation.type === 'field.clear')
    return !target || target.node.kind !== 'field'
      ? invalidTarget(operation)
      : executeValue(target, operation, copyPayload);

  if (operation.type === 'variant.replace')
    return !target || target.node.kind !== 'variant'
      ? invalidTarget(operation)
      : executeValue(target, operation, copyPayload);

  if (
    operation.type === 'dict.set' ||
    operation.type === 'dict.delete' ||
    operation.type === 'dict.replace'
  )
    return !target || (target.node.kind !== 'dict' && target.node.kind !== 'record')
      ? invalidTarget(operation)
      : executeValue(target, operation, copyPayload);

  if (
    operation.type === 'entity.create' ||
    operation.type === 'entity.remove' ||
    operation.type === 'entity.move'
  )
    return !target || (target.node.kind !== 'table' && target.node.kind !== 'map')
      ? invalidTarget(operation)
      : executeEntity(target, operation, copyPayload);

  if (
    operation.type === 'list.insert' ||
    operation.type === 'list.move' ||
    operation.type === 'list.remove' ||
    operation.type === 'list.replace'
  )
    return !target || target.node.kind !== 'list'
      ? invalidTarget(operation)
      : executeList(target, operation, copyPayload);

  if (
    operation.type === 'tree.insert' ||
    operation.type === 'tree.move' ||
    operation.type === 'tree.remove' ||
    operation.type === 'tree.set' ||
    operation.type === 'tree.replace'
  )
    return !target || target.node.kind !== 'tree'
      ? invalidTarget(operation)
      : executeTree(root, target, operation, copyPayload);

  return {
    status: 'rejected',
    issue: issue.from(operation, 'unknown-operation', 'Unknown document operation.'),
  };
};
