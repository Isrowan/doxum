import type { ResolvedAddress } from '../address';
import type { DocumentOperationUnion } from '../operations';
import type { MutationOutcome } from './contract';
import * as issue from './issue';
import { cloneValue, isRecord, ownPayload, sameStructuralValue } from '../value/ownership';

type ValueOperation = Extract<
  DocumentOperationUnion,
  {
    type:
      'field.set' | 'field.clear' | 'variant.replace' | 'dict.set' | 'dict.delete' | 'dict.replace';
  }
>;

const rejected = (
  operation: ValueOperation,
  code: Extract<import('./issue').MutationIssueCode, 'invalid-address' | 'required-field'>,
  message: string
): MutationOutcome => ({
  status: 'rejected',
  issue: issue.from(operation, code, message),
});

export const executeValue = (
  target: ResolvedAddress,
  operation: ValueOperation,
  copyPayload: boolean
): MutationOutcome => {
  const own = <T>(value: T): T => (copyPayload ? ownPayload(value) : value);

  if (operation.type === 'field.set' || operation.type === 'field.clear') {
    const existed = Object.prototype.hasOwnProperty.call(target.parent, target.key);
    if (operation.type === 'field.clear') {
      if (target.node.kind !== 'field' || !target.node.optional)
        return rejected(operation, 'required-field', 'Only optional fields can be cleared.');
      if (!existed) return { status: 'unchanged' };
      const inverse: DocumentOperationUnion = {
        type: 'field.set',
        at: operation.at,
        value: target.value,
      };
      delete (target.parent as Record<string | number, unknown>)[target.key];
      return { status: 'changed', inverse: [inverse] };
    }
    if (existed && Object.is(target.value, operation.value)) return { status: 'unchanged' };
    const inverse: DocumentOperationUnion = existed
      ? { type: 'field.set', at: operation.at, value: target.value }
      : { type: 'field.clear', at: operation.at };
    (target.parent as Record<string | number, unknown>)[target.key] = operation.value;
    return { status: 'changed', inverse: [inverse] };
  }

  if (operation.type === 'variant.replace') {
    if (sameStructuralValue(target.value, operation.value)) return { status: 'unchanged' };
    const inverse: DocumentOperationUnion = {
      type: 'variant.replace',
      at: operation.at,
      value: ownPayload(target.value, 'inverse'),
    };
    (target.parent as Record<string | number, unknown>)[target.key] = own(operation.value);
    return { status: 'changed', inverse: [inverse] };
  }

  if (operation.type === 'dict.replace' && target.value === undefined) {
    if (!('optional' in target.node) || !target.node.optional)
      return rejected(operation, 'invalid-address', 'Dictionary target is invalid.');
    const inverse: DocumentOperationUnion = { type: 'value.clear', at: operation.at };
    (target.parent as Record<string | number, unknown>)[target.key] = own(operation.value);
    return { status: 'changed', inverse: [inverse] };
  }
  if (!isRecord(target.value))
    return rejected(operation, 'invalid-address', 'Dictionary target is invalid.');
  if (operation.type === 'dict.replace') {
    if (sameStructuralValue(target.value, operation.value)) return { status: 'unchanged' };
    const inverse: DocumentOperationUnion = {
      type: 'dict.replace',
      at: operation.at,
      value: cloneValue(target.value, 'inverse'),
    };
    (target.parent as Record<string | number, unknown>)[target.key] = own(operation.value);
    return { status: 'changed', inverse: [inverse] };
  }
  const existed = Object.prototype.hasOwnProperty.call(target.value, operation.key);
  if (operation.type === 'dict.delete') {
    if (!existed) return { status: 'unchanged' };
    const inverse: DocumentOperationUnion = {
      type: 'dict.set',
      at: operation.at,
      key: operation.key,
      value: target.value[operation.key],
    };
    delete target.value[operation.key];
    return { status: 'changed', inverse: [inverse] };
  }
  if (existed && Object.is(target.value[operation.key], operation.value))
    return { status: 'unchanged' };
  const inverse: DocumentOperationUnion = existed
    ? {
        type: 'dict.set',
        at: operation.at,
        key: operation.key,
        value: target.value[operation.key],
      }
    : { type: 'dict.delete', at: operation.at, key: operation.key };
  target.value[operation.key] = operation.value;
  return { status: 'changed', inverse: [inverse] };
};
