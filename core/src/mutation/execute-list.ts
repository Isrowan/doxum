import type { ResolvedAddress } from '../address';
import type { DocumentOperationUnion } from '../operations';
import type { MutationOutcome } from './contract';
import * as anchor from './anchor';
import type { MutationIssueCode } from './issue';
import * as issue from './issue';
import { cloneValue, ownPayload, sameStructuralValue } from '../value/ownership';

type ListOperation = Extract<
  DocumentOperationUnion,
  { type: 'list.insert' | 'list.move' | 'list.remove' | 'list.replace' }
>;

const rejected = (
  operation: ListOperation,
  code: MutationIssueCode,
  message: string
): MutationOutcome => ({
  status: 'rejected',
  issue: issue.from(operation, code, message),
});

export const executeList = (
  target: ResolvedAddress,
  operation: ListOperation,
  copyPayload: boolean
): MutationOutcome => {
  if (!Array.isArray(target.value) || target.node.kind !== 'list')
    return rejected(operation, 'invalid-address', 'List target is invalid.');
  const list = target.value;
  const orderedKeys = anchor.keys(list, target.node.keyOf);
  const own = <T>(value: T): T => (copyPayload ? ownPayload(value) : value);

  if (operation.type === 'list.replace') {
    if (operation.keys.length !== operation.value.length)
      return rejected(operation, 'invalid-list-keys', 'List replacement keys are invalid.');
    const seen = new Set<string>();
    for (let index = 0; index < operation.value.length; index += 1) {
      const key = operation.keys[index];
      if (seen.has(key) || target.node.keyOf(operation.value[index]) !== key)
        return rejected(operation, 'invalid-list-keys', 'List replacement keys are invalid.');
      seen.add(key);
    }
    if (sameStructuralValue(list, operation.value)) return { status: 'unchanged' };
    const keys = new Array<string>(list.length);
    for (let index = 0; index < list.length; index += 1)
      keys[index] = target.node.keyOf(list[index]);
    const inverse: DocumentOperationUnion = {
      type: 'list.replace',
      at: operation.at,
      value: cloneValue(list, 'inverse'),
      keys,
    };
    const owned = own(operation.value) as unknown[];
    list.length = owned.length;
    for (let index = 0; index < owned.length; index += 1) list[index] = owned[index];
    return { status: 'changed', inverse: [inverse] };
  }

  if (operation.type === 'list.insert') {
    if (target.node.keyOf(operation.value) !== operation.key)
      return rejected(operation, 'invalid-list-key', 'List item key does not match schema.');
    if (orderedKeys.index(operation.key) >= 0)
      return rejected(
        operation,
        'duplicate-list-item',
        `List item '${operation.key}' already exists.`
      );
    if (!anchor.valid(orderedKeys, operation.anchor))
      return rejected(operation, 'invalid-anchor', 'List anchor is invalid.');
    list.splice(anchor.index(orderedKeys, operation.anchor), 0, own(operation.value));
    return {
      status: 'changed',
      inverse: [{ type: 'list.remove', at: operation.at, key: operation.key }],
    };
  }

  const position = orderedKeys.index(operation.key);
  if (position < 0)
    return rejected(operation, 'missing-list-item', `List item '${operation.key}' does not exist.`);
  if (operation.type === 'list.remove') {
    const inverse: DocumentOperationUnion = {
      type: 'list.insert',
      at: operation.at,
      key: operation.key,
      value: cloneValue(list[position], 'inverse'),
      anchor: anchor.at(orderedKeys, position),
    };
    list.splice(position, 1);
    return { status: 'changed', inverse: [inverse] };
  }
  if (!anchor.valid(orderedKeys, operation.anchor))
    return rejected(operation, 'invalid-anchor', 'List anchor is invalid.');
  if (
    operation.anchor &&
    (('before' in operation.anchor && operation.anchor.before === operation.key) ||
      ('after' in operation.anchor && operation.anchor.after === operation.key))
  )
    return rejected(operation, 'invalid-anchor', 'A list item cannot be moved relative to itself.');
  const nextIndex = anchor.afterRemove(orderedKeys, position, operation.anchor);
  if (nextIndex === position) return { status: 'unchanged' };
  const inverse: DocumentOperationUnion = {
    type: 'list.move',
    at: operation.at,
    key: operation.key,
    anchor: anchor.at(orderedKeys, position),
  };
  const [entry] = list.splice(position, 1);
  list.splice(nextIndex, 0, entry);
  return { status: 'changed', inverse: [inverse] };
};
