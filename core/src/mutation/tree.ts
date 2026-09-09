import { isRecord } from '../value/ownership';
export type MutableTreeNode = { parentId?: string; children: string[]; value?: unknown };
export type MutableTree = { rootId?: string; nodes: Record<string, MutableTreeNode> };
const node = (tree: MutableTree, id: string) =>
  Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
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

export const contains = (tree: MutableTree, id: string): boolean => Object.hasOwn(tree.nodes, id);

export const parent = (tree: MutableTree, id: string): string | undefined =>
  node(tree, id)?.parentId;

export const children = (tree: MutableTree, id: string): readonly string[] | undefined =>
  node(tree, id)?.children;

export const validate = (value: unknown): value is MutableTree => {
  if (!is(value)) return false;
  const ids = Object.keys(value.nodes);
  if (ids.length === 0) return value.rootId === undefined;
  if (typeof value.rootId !== 'string' || !Object.hasOwn(value.nodes, value.rootId)) return false;

  for (const id of ids) {
    const entry = value.nodes[id];
    if (!validNode(entry)) return false;
    if (id === value.rootId) {
      if (entry.parentId !== undefined) return false;
    } else if (entry.parentId === undefined || !Object.hasOwn(value.nodes, entry.parentId))
      return false;
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
