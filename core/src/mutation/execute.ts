import type { ResolvedAddress } from '../address';
import type { DocumentOperationUnion } from '../operations';
import type { MutationOutcome } from './contract';
import * as issue from './issue';
import { executeEntity } from './execute-entity';
import { executeList } from './execute-list';
import { executeTree } from './execute-tree';
import { executeValue } from './execute-value';
import { cloneValue } from '../value/ownership';

const hasOwn = (value: object, key: string | number): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const executeClear = (
  target: ResolvedAddress,
  operation: Extract<DocumentOperationUnion, { type: 'value.clear' }>
): MutationOutcome => {
  if (!('optional' in target.node) || !target.node.optional)
    return {
      status: 'rejected',
      issue: issue.from(operation, 'required-field', 'Only optional values can be cleared.'),
    };
  if (!hasOwn(target.parent, target.key)) return { status: 'unchanged' };
  if (
    target.node.kind !== 'field' &&
    target.node.kind !== 'variant' &&
    target.node.kind !== 'dict' &&
    target.node.kind !== 'record' &&
    target.node.kind !== 'list' &&
    target.node.kind !== 'tree'
  )
    return {
      status: 'rejected',
      issue: issue.from(
        operation,
        'invalid-operation',
        'This optional value has no clear operation.'
      ),
    };

  const inverse: DocumentOperationUnion = (() => {
    switch (target.node.kind) {
      case 'field':
        return { type: 'field.set', at: operation.at, value: target.value };
      case 'variant':
        return {
          type: 'variant.replace',
          at: operation.at,
          value: cloneValue(target.value, 'inverse'),
        };
      case 'dict':
      case 'record':
        return {
          type: 'dict.replace',
          at: operation.at,
          value: cloneValue(target.value, 'inverse') as Record<string, unknown>,
        };
      case 'list': {
        if (!Array.isArray(target.value))
          return { type: 'list.replace', at: operation.at, value: [], keys: [] };
        return {
          type: 'list.replace',
          at: operation.at,
          value: cloneValue(target.value, 'inverse'),
          keys: target.value.map(target.node.keyOf),
        };
      }
      case 'tree':
        return {
          type: 'tree.replace',
          at: operation.at,
          value: cloneValue(target.value, 'inverse'),
        };
    }
  })();
  delete (target.parent as Record<string | number, unknown>)[target.key];
  return { status: 'changed', inverse: [inverse] };
};

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
  if (operation.type === 'value.clear')
    return !target ? invalidTarget(operation) : executeClear(target, operation);

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
