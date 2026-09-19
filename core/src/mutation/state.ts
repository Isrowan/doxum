import type { DocumentNode, ObjectNode } from '../schema';
import * as ordered from '../ordered-key';
import { installOwn } from '../value/record';

export type CanonicalState = { schema: ObjectNode; document: unknown };

/** Install validated values, or captured before values during rollback. */
export const installMember = (
  parent: Record<string, unknown> | unknown[],
  key: string | number,
  present: boolean,
  value: unknown
): void => {
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (present) {
      if (index < 0) ordered.insert(parent, parent.length, value);
      else parent[index] = value;
    } else if (index >= 0) ordered.remove(parent, index);
  } else installOwn(parent, key, present, value);
};

export const orderOf = (node: DocumentNode, value: unknown): string[] => {
  if (node.kind === 'list')
    return ordered.toArray(ordered.indexedKeys(value as unknown[], node.keyOf));
  if (node.kind === 'table') return [...(value as { ids: string[] }).ids];
  throw new Error('Order requires a table or list.');
};

export const installOrder = (
  node: DocumentNode,
  value: unknown,
  order: readonly string[]
): void => {
  if (node.kind === 'list') ordered.install(value as unknown[], node.keyOf, order);
  else if (node.kind === 'table') (value as { ids: string[] }).ids = [...order];
  else throw new Error('Order requires a table or list.');
};
