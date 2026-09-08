import type { DocumentNode, ObjectNode } from '../schema';
import * as anchor from './anchor';

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
      if (index < 0) anchor.insert(parent, parent.length, value);
      else parent[index] = value;
    } else if (index >= 0) anchor.remove(parent, index);
  } else if (!present) delete parent[key];
  else if (Object.hasOwn(parent, key)) parent[key] = value;
  else
    Object.defineProperty(parent, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
};

export const orderOf = (node: DocumentNode, value: unknown): string[] => {
  if (node.kind === 'list') return (value as unknown[]).map(node.keyOf);
  if (node.kind === 'table') return [...(value as { ids: string[] }).ids];
  throw new Error('Order requires a table or list.');
};

export const installOrder = (
  node: DocumentNode,
  value: unknown,
  order: readonly string[]
): void => {
  if (node.kind === 'list') anchor.install(value as unknown[], node.keyOf, order);
  else if (node.kind === 'table') (value as { ids: string[] }).ids = [...order];
  else throw new Error('Order requires a table or list.');
};
