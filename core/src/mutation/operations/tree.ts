import type { DocumentAddress } from '../../schema';
import type { ResolvedTreeContainer } from '../../address';
import type { MutationSession } from '../session';
import { contains, type MutableTree, type TreePosition } from '../tree';
import { fail } from '../issue';
const node = (tree: MutableTree, id: string) =>
  Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
const positionIndex = (index: number | undefined, length: number, at: DocumentAddress): number => {
  if (index !== undefined && (!Number.isInteger(index) || index < 0))
    return fail(at, 'invalid-tree-index', 'Tree index must be nonnegative.');
  return Math.min(index ?? length, length);
};
export const insert = (
  session: MutationSession,
  container: ResolvedTreeContainer,
  id: string,
  value: unknown,
  position: TreePosition | undefined
): void => {
  const { at, node: schema, value: tree } = container;
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
  session.validate(schema.value, value, at.concat(id));
  session.recorder.tree(container, id);
  if (parentId !== undefined) session.recorder.tree(container, parentId);
  Object.defineProperty(tree.nodes, id, {
    value: { ...(parentId === undefined ? {} : { parentId }), children: [], value },
    writable: true,
    configurable: true,
    enumerable: true,
  });
  if (parent) parent.children.splice(index, 0, id);
  else tree.rootId = id;
  session.invalidate();
};
export const set = (
  session: MutationSession,
  container: ResolvedTreeContainer,
  id: string,
  value: unknown
): void => {
  const { at, node: schema, value: tree } = container;
  const entry = node(tree, id);
  if (!entry) return fail(at, 'missing-tree-node', 'Tree node does not exist.');
  if (Object.is(entry.value, value) && Object.hasOwn(entry, 'value')) return;
  session.validate(schema.value, value, at.concat(id));
  session.recorder.tree(container, id);
  entry.value = value;
};
export const remove = (
  session: MutationSession,
  container: ResolvedTreeContainer,
  id: string
): void => {
  const { at, value: tree } = container;
  const entry = node(tree, id);
  if (!entry) return fail(at, 'missing-tree-node', 'Tree node does not exist.');
  const ids: string[] = [],
    stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    ids.push(current);
    for (const child of tree.nodes[current].children) stack.push(child);
  }
  for (const key of ids) session.recorder.tree(container, key);
  if (entry.parentId !== undefined) session.recorder.tree(container, entry.parentId);
  if (entry.parentId === undefined) delete tree.rootId;
  else {
    const children = tree.nodes[entry.parentId].children;
    children.splice(children.indexOf(id), 1);
  }
  for (const key of ids) delete tree.nodes[key];
  session.invalidate();
};
export const move = (
  session: MutationSession,
  container: ResolvedTreeContainer,
  id: string,
  position: TreePosition | undefined
): void => {
  const { at, value: tree } = container;
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
  session.recorder.tree(container, id);
  session.recorder.tree(container, entry.parentId);
  session.recorder.tree(container, parentId);
  old.children.splice(previous, 1);
  next.children.splice(index, 0, id);
  entry.parentId = parentId;
  session.invalidate();
};
