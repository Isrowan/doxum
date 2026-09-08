import { isRecord } from '../value/ownership';
import type { DocumentAddress } from '../schema';
import { fail } from './issue';
export type MutableTreeNode = { parentId?: string; children: string[]; value?: unknown };
export type MutableTree = { rootId?: string; nodes: Record<string, MutableTreeNode> };
const has = (v: object, k: string) => Object.prototype.hasOwnProperty.call(v, k);
const node = (tree: MutableTree, id: string) => (has(tree.nodes, id) ? tree.nodes[id] : undefined);
export const is = (value: unknown): value is MutableTree =>
  isRecord(value) && isRecord(value.nodes);

export const validNode = (value: unknown): value is MutableTreeNode => {
  if (!isRecord(value) || !Array.isArray(value.children)) return false;
  if (value.parentId !== undefined && typeof value.parentId !== 'string') return false;
  const children = new Set<string>();
  for (const id of value.children) {
    if (typeof id !== 'string' || children.has(id)) return false;
    children.add(id);
  }
  return true;
};

export const contains = (tree: MutableTree, id: string): boolean => has(tree.nodes, id);

export const parent = (tree: MutableTree, id: string): string | undefined =>
  node(tree, id)?.parentId;

export const children = (tree: MutableTree, id: string): readonly string[] | undefined =>
  node(tree, id)?.children;

export const validate = (value: unknown): value is MutableTree => {
  if (!is(value)) return false;
  const ids = Object.keys(value.nodes);
  if (ids.length === 0) return value.rootId === undefined;
  if (typeof value.rootId !== 'string' || !has(value.nodes, value.rootId)) return false;

  for (const id of ids) {
    const entry = value.nodes[id];
    if (!validNode(entry)) return false;
    if (id === value.rootId) {
      if (entry.parentId !== undefined) return false;
    } else if (entry.parentId === undefined || !has(value.nodes, entry.parentId)) return false;
    for (const child of entry.children) {
      const childNode = value.nodes[child];
      if (!childNode || childNode.parentId !== id) return false;
    }
  }

  const seen = new Set<string>();
  const stack = [value.rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) return false;
    seen.add(id);
    const entry = value.nodes[id];
    if (!entry) return false;
    for (const child of entry.children) stack.push(child);
  }
  return seen.size === ids.length;
};

export type TreePosition = { readonly parentId?: string; readonly index?: number };
type Capture = (ids: readonly string[]) => void;
const positionIndex = (index: number | undefined, length: number, at: DocumentAddress): number => {
  if (index !== undefined && (!Number.isInteger(index) || index < 0))
    return fail(at, 'invalid-tree-index', 'Tree index must be nonnegative.');
  return Math.min(index ?? length, length);
};
export const insert = (
  tree: MutableTree,
  id: string,
  value: unknown,
  position: TreePosition | undefined,
  capture: Capture,
  at: DocumentAddress
): void => {
  if (typeof id !== 'string') return fail(at, 'invalid-key', 'Tree keys must be strings.');
  if (contains(tree, id)) return fail(at, 'duplicate-tree-node', 'Tree node already exists.');
  const parentId = position?.parentId;
  const parent = parentId === undefined ? undefined : node(tree, parentId);
  if (
    (tree.rootId !== undefined && !parent) ||
    (tree.rootId === undefined && parentId !== undefined)
  )
    return fail(at, 'missing-tree-parent', 'A nonempty tree requires an existing parent.');
  const index = positionIndex(position?.index, parent?.children.length ?? 0, at);
  capture(parentId === undefined ? [id] : [id, parentId]);
  Object.defineProperty(tree.nodes, id, {
    value: { ...(parentId === undefined ? {} : { parentId }), children: [], value },
    writable: true,
    configurable: true,
    enumerable: true,
  });
  if (parent) parent.children.splice(index, 0, id);
  else tree.rootId = id;
};
export const set = (
  tree: MutableTree,
  id: string,
  value: unknown,
  capture: Capture,
  at: DocumentAddress
): void => {
  const entry = node(tree, id);
  if (!entry) return fail(at, 'missing-tree-node', 'Tree node does not exist.');
  if (Object.is(entry.value, value) && Object.hasOwn(entry, 'value')) return;
  capture([id]);
  entry.value = value;
};
export const remove = (
  tree: MutableTree,
  id: string,
  capture: Capture,
  at: DocumentAddress
): void => {
  const entry = node(tree, id);
  if (!entry) return fail(at, 'missing-tree-node', 'Tree node does not exist.');
  const ids: string[] = [],
    stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    ids.push(current);
    stack.push(...tree.nodes[current].children);
  }
  capture(entry.parentId === undefined ? ids : [...ids, entry.parentId]);
  if (entry.parentId === undefined) delete tree.rootId;
  else {
    const children = tree.nodes[entry.parentId].children;
    children.splice(children.indexOf(id), 1);
  }
  for (const key of ids) delete tree.nodes[key];
};
export const move = (
  tree: MutableTree,
  id: string,
  position: TreePosition | undefined,
  capture: Capture,
  at: DocumentAddress
): void => {
  const entry = node(tree, id),
    parentId = position?.parentId;
  if (!entry) return fail(at, 'missing-tree-node', 'Tree node does not exist.');
  if (entry.parentId === undefined || parentId === undefined || !contains(tree, parentId))
    return fail(
      at,
      'missing-tree-parent',
      'Moving requires a non-root node and an existing parent.'
    );
  for (
    let ancestor: string | undefined = parentId;
    ancestor !== undefined;
    ancestor = tree.nodes[ancestor].parentId
  )
    if (ancestor === id) return fail(at, 'tree-cycle', 'Cannot move a node under its descendant.');
  const old = tree.nodes[entry.parentId],
    next = tree.nodes[parentId];
  const index = positionIndex(position?.index, next.children.length - (old === next ? 1 : 0), at);
  const previous = old.children.indexOf(id);
  if (old === next && previous === index) return;
  capture([id, entry.parentId, parentId]);
  old.children.splice(previous, 1);
  next.children.splice(index, 0, id);
  entry.parentId = parentId;
};
