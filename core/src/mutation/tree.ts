import type { DocumentAddress, DocumentNode, DocumentSchema } from '../schema';
import type { DocumentOperationUnion } from '../operations';
import { cloneValue, isRecord, ownPayload, sameStructuralValue } from '../value/ownership';

type TreeOperation = Extract<
  DocumentOperationUnion,
  {
    type: 'tree.insert' | 'tree.move' | 'tree.remove' | 'tree.set' | 'tree.replace';
  }
>;

type MutableTreeNode = {
  parentId?: string;
  children: string[];
  value?: unknown;
};

export type MutableTree = {
  rootId?: string;
  nodes: Record<string, MutableTreeNode>;
};

export type TreeOutcome =
  | {
      readonly status: 'changed';
      readonly inverse: readonly DocumentOperationUnion[];
    }
  | { readonly status: 'unchanged' }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'invalid-tree'
        | 'duplicate-tree-node'
        | 'missing-tree-parent'
        | 'invalid-tree-index'
        | 'missing-tree-node'
        | 'tree-cycle';
      readonly message: string;
    };

type TreeNodePresence =
  | { readonly status: 'absent' }
  | {
      readonly status: 'present';
      readonly parentId?: string;
      readonly children: readonly string[];
      readonly value: unknown;
    };

type TreeRootPresence =
  { readonly status: 'absent' } | { readonly status: 'present'; readonly id: string };

export type TreeChange =
  | {
      readonly mode: 'incremental';
      readonly root: TreeRootPresence;
      readonly nodes: Map<string, TreeNodePresence>;
    }
  | { readonly mode: 'whole'; readonly value: unknown };

const has = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const validIndex = (index: number | undefined): boolean =>
  index === undefined || (Number.isInteger(index) && index >= 0);
const rejected = (
  code: Extract<TreeOutcome, { status: 'rejected' }>['code'],
  message: string
): TreeOutcome => ({ status: 'rejected', code, message });

const node = (tree: MutableTree, id: string): MutableTreeNode | undefined => tree.nodes[id];
const childIndex = (parent: MutableTreeNode, id: string): number => parent.children.indexOf(id);
const sameOrder = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

const rootPresence = (id: string | undefined): TreeRootPresence =>
  id === undefined ? { status: 'absent' } : { status: 'present', id };

const capture = (
  change: Extract<TreeChange, { readonly mode: 'incremental' }>,
  id: string,
  presence: TreeNodePresence
): void => {
  if (!change.nodes.has(id)) change.nodes.set(id, presence);
};

const without = (values: readonly string[], id: string): string[] => {
  const result: string[] = [];
  for (const value of values) if (value !== id) result.push(value);
  return result;
};

const inserted = (values: readonly string[], id: string, index: number): string[] => {
  const result = [...values];
  result.splice(Math.min(index, result.length), 0, id);
  return result;
};

const moved = (values: readonly string[], id: string, index: number): string[] => {
  const result = without(values, id);
  result.splice(Math.min(index, result.length), 0, id);
  return result;
};

const parentPresence = (
  tree: MutableTree,
  id: string,
  children: readonly string[]
): TreeNodePresence => {
  const entry = node(tree, id);
  return entry
    ? {
        status: 'present',
        ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
        children,
        value: entry.value,
      }
    : { status: 'absent' };
};

const restoreIncremental = (
  value: unknown,
  change: Extract<TreeChange, { readonly mode: 'incremental' }>
): unknown => {
  if (!is(value)) return value;
  if (change.root.status === 'absent') delete value.rootId;
  else value.rootId = change.root.id;
  for (const [id, before] of change.nodes) {
    if (before.status === 'absent') {
      delete value.nodes[id];
      continue;
    }
    value.nodes[id] = {
      ...(before.parentId === undefined ? {} : { parentId: before.parentId }),
      children: [...before.children],
      value: before.value,
    };
  }
  return value;
};

export const restoreChange = (value: unknown, change: TreeChange): unknown =>
  change.mode === 'whole' ? ownPayload(change.value, 'journal') : restoreIncremental(value, change);

const wholeChange = (
  inverse: Extract<TreeOperation, { readonly type: 'tree.replace' }>,
  previous?: TreeChange
): TreeChange => {
  if (!previous) return { mode: 'whole', value: inverse.value };
  if (previous.mode === 'whole') return previous;
  return {
    mode: 'whole',
    value: restoreIncremental(ownPayload(inverse.value, 'journal'), previous),
  };
};

const removedNodePresences = (
  inverses: readonly Extract<TreeOperation, { readonly type: 'tree.insert' }>[]
): Map<string, TreeNodePresence> => {
  const children = new Map<string, Array<{ readonly id: string; readonly index: number }>>();
  for (const inverse of inverses) {
    if (inverse.parentId === undefined) continue;
    const entries = children.get(inverse.parentId);
    const child = { id: inverse.treeNodeId, index: inverse.index ?? Number.MAX_SAFE_INTEGER };
    if (entries) entries.push(child);
    else children.set(inverse.parentId, [child]);
  }
  const result = new Map<string, TreeNodePresence>();
  for (const inverse of inverses) {
    const ordered = children.get(inverse.treeNodeId) ?? [];
    ordered.sort((left, right) => left.index - right.index);
    result.set(inverse.treeNodeId, {
      status: 'present',
      ...(inverse.parentId === undefined ? {} : { parentId: inverse.parentId }),
      children: ordered.map(entry => entry.id),
      value: inverse.value,
    });
  }
  return result;
};

export const recordChange = (
  previous: TreeChange | undefined,
  current: MutableTree,
  forward: TreeOperation,
  inverses: readonly TreeOperation[]
): TreeChange => {
  const replacement = inverses[0];
  if (replacement?.type === 'tree.replace') return wholeChange(replacement, previous);
  if (previous?.mode === 'whole') return previous;

  const change: Extract<TreeChange, { readonly mode: 'incremental' }> = previous ?? {
    mode: 'incremental',
    root:
      forward.type === 'tree.insert' && forward.parentId === undefined
        ? { status: 'absent' }
        : forward.type === 'tree.remove' && inverses[0]?.type === 'tree.insert'
          ? rootPresence(
              inverses[0].parentId === undefined ? inverses[0].treeNodeId : current.rootId
            )
          : rootPresence(current.rootId),
    nodes: new Map(),
  };

  if (forward.type === 'tree.insert') {
    capture(change, forward.treeNodeId, { status: 'absent' });
    if (forward.parentId !== undefined) {
      const parentNode = node(current, forward.parentId);
      if (parentNode)
        capture(
          change,
          forward.parentId,
          parentPresence(
            current,
            forward.parentId,
            without(parentNode.children, forward.treeNodeId)
          )
        );
    }
    return change;
  }

  if (forward.type === 'tree.remove') {
    const inserts = inverses.filter(
      (inverse): inverse is Extract<TreeOperation, { readonly type: 'tree.insert' }> =>
        inverse.type === 'tree.insert'
    );
    const removed = removedNodePresences(inserts);
    for (const [id, presence] of removed) capture(change, id, presence);
    const first = inserts[0];
    if (first?.parentId !== undefined) {
      const parentNode = node(current, first.parentId);
      if (parentNode)
        capture(
          change,
          first.parentId,
          parentPresence(
            current,
            first.parentId,
            inserted(
              parentNode.children,
              first.treeNodeId,
              first.index ?? parentNode.children.length
            )
          )
        );
    }
    return change;
  }

  if (forward.type === 'tree.set') {
    const inverse = inverses[0];
    const entry = node(current, forward.treeNodeId);
    if (entry && inverse?.type === 'tree.set')
      capture(change, forward.treeNodeId, {
        status: 'present',
        ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
        children: [...entry.children],
        value: inverse.value,
      });
    return change;
  }

  if (forward.type === 'tree.move') {
    const inverse = inverses[0];
    const entry = node(current, forward.treeNodeId);
    if (!entry || inverse?.type !== 'tree.move' || inverse.parentId === undefined) return change;
    capture(change, forward.treeNodeId, {
      status: 'present',
      parentId: inverse.parentId,
      children: [...entry.children],
      value: entry.value,
    });
    const oldParent = node(current, inverse.parentId);
    if (oldParent) {
      const children =
        inverse.parentId === forward.parentId
          ? moved(
              oldParent.children,
              forward.treeNodeId,
              inverse.index ?? oldParent.children.length
            )
          : inserted(
              oldParent.children,
              forward.treeNodeId,
              inverse.index ?? oldParent.children.length
            );
      capture(change, inverse.parentId, parentPresence(current, inverse.parentId, children));
    }
    if (forward.parentId !== undefined && forward.parentId !== inverse.parentId) {
      const nextParent = node(current, forward.parentId);
      if (nextParent)
        capture(
          change,
          forward.parentId,
          parentPresence(
            current,
            forward.parentId,
            without(nextParent.children, forward.treeNodeId)
          )
        );
    }
  }
  return change;
};

const sameNodePresence = (
  before: TreeNodePresence,
  value: MutableTreeNode | undefined
): boolean => {
  if (before.status === 'absent') return value === undefined;
  return (
    value !== undefined &&
    before.parentId === value.parentId &&
    sameOrder(before.children, value.children) &&
    sameStructuralValue(before.value, value.value)
  );
};

export const changeChanged = (change: TreeChange, value: unknown): boolean => {
  if (change.mode === 'whole') return !sameStructuralValue(change.value, value);
  if (!is(value)) return true;
  const rootId = change.root.status === 'present' ? change.root.id : undefined;
  if (rootId !== value.rootId) return true;
  for (const [id, before] of change.nodes)
    if (!sameNodePresence(before, node(value, id))) return true;
  return false;
};

export const is = (value: unknown): value is MutableTree =>
  isRecord(value) && isRecord(value.nodes);

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
    if (!isRecord(entry) || !Array.isArray(entry.children)) return false;
    if (
      entry.children.some(child => typeof child !== 'string') ||
      new Set(entry.children).size !== entry.children.length
    )
      return false;
    if (entry.parentId !== undefined && typeof entry.parentId !== 'string') return false;
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

const documentTreeError = (
  node: DocumentNode,
  value: unknown,
  address: DocumentAddress
): DocumentAddress | undefined => {
  if ('optional' in node && node.optional && value === undefined) return undefined;
  if (node.kind === 'tree') return validate(value) ? undefined : address;
  if (node.kind === 'object') {
    if (!isRecord(value)) return undefined;
    for (const [key, child] of Object.entries(node.shape)) {
      const error = documentTreeError(child, value[key], [...address, key]);
      if (error) return error;
    }
    return undefined;
  }
  if (node.kind === 'single') return documentTreeError(node.value, value, address);
  if (node.kind === 'variant') {
    if (!isRecord(value) || typeof value[node.tag] !== 'string') return undefined;
    const variant = node.variants[value[node.tag] as keyof typeof node.variants];
    return variant ? documentTreeError(variant, value, address) : undefined;
  }
  if (node.kind === 'table') {
    if (!isRecord(value) || !isRecord(value.byId)) return undefined;
    for (const [id, entry] of Object.entries(value.byId)) {
      const error = documentTreeError(node.value, entry, [...address, id]);
      if (error) return error;
    }
    return undefined;
  }
  if (node.kind === 'map') {
    if (!isRecord(value)) return undefined;
    for (const [id, entry] of Object.entries(value)) {
      const error = documentTreeError(node.value, entry, [...address, id]);
      if (error) return error;
    }
  }
  return undefined;
};

export const invalidDocument = (
  schema: DocumentSchema,
  value: unknown
): DocumentAddress | undefined =>
  documentTreeError({ kind: 'object', shape: schema.shape }, value, []);

export const replace = (
  current: MutableTree,
  operation: Extract<TreeOperation, { type: 'tree.replace' }>
): TreeOutcome => {
  if (!validate(operation.value)) return rejected('invalid-tree', 'Tree replacement is malformed.');
  if (sameStructuralValue(current, operation.value)) return { status: 'unchanged' };
  return {
    status: 'changed',
    inverse: [
      {
        type: 'tree.replace',
        at: operation.at,
        value: cloneValue(current, 'inverse'),
      },
    ],
  };
};

export const insert = (
  tree: MutableTree,
  operation: Extract<TreeOperation, { type: 'tree.insert' }>,
  value: unknown
): TreeOutcome => {
  if (contains(tree, operation.treeNodeId))
    return rejected('duplicate-tree-node', `Tree node '${operation.treeNodeId}' already exists.`);
  if (!validIndex(operation.index)) return rejected('invalid-tree-index', 'Tree index is invalid.');

  if (tree.rootId === undefined) {
    if (operation.parentId !== undefined)
      return rejected('missing-tree-parent', `Tree parent '${operation.parentId}' does not exist.`);
    tree.nodes[operation.treeNodeId] = { children: [], value };
    tree.rootId = operation.treeNodeId;
  } else {
    if (operation.parentId === undefined)
      return rejected('invalid-tree', 'A non-empty tree has exactly one root.');
    const parentNode = node(tree, operation.parentId);
    if (!parentNode)
      return rejected('missing-tree-parent', `Tree parent '${operation.parentId}' does not exist.`);
    tree.nodes[operation.treeNodeId] = {
      parentId: operation.parentId,
      children: [],
      value,
    };
    parentNode.children.splice(
      Math.min(operation.index ?? parentNode.children.length, parentNode.children.length),
      0,
      operation.treeNodeId
    );
  }
  return {
    status: 'changed',
    inverse: [
      {
        type: 'tree.remove',
        at: operation.at,
        treeNodeId: operation.treeNodeId,
      },
    ],
  };
};

export const set = (
  tree: MutableTree,
  operation: Extract<TreeOperation, { type: 'tree.set' }>,
  value: unknown
): TreeOutcome => {
  const entry = node(tree, operation.treeNodeId);
  if (!entry)
    return rejected('missing-tree-node', `Tree node '${operation.treeNodeId}' does not exist.`);
  if (Object.is(entry.value, value)) return { status: 'unchanged' };
  const inverse: DocumentOperationUnion = {
    type: 'tree.set',
    at: operation.at,
    treeNodeId: operation.treeNodeId,
    value: cloneValue(entry.value, 'inverse'),
  };
  entry.value = value;
  return { status: 'changed', inverse: [inverse] };
};

export const remove = (
  tree: MutableTree,
  operation: Extract<TreeOperation, { type: 'tree.remove' }>
): TreeOutcome => {
  const first = node(tree, operation.treeNodeId);
  if (!first)
    return rejected('missing-tree-node', `Tree node '${operation.treeNodeId}' does not exist.`);
  const parentId = first.parentId;
  const parentNode = parentId === undefined ? undefined : node(tree, parentId);
  const originalIndex = parentNode ? childIndex(parentNode, operation.treeNodeId) : 0;
  if (
    (parentId !== undefined && (!parentNode || originalIndex < 0)) ||
    (parentId === undefined && tree.rootId !== operation.treeNodeId)
  )
    return rejected('invalid-tree', 'Tree parent links are inconsistent.');

  const entries: Array<{
    readonly id: string;
    readonly parentId?: string;
    readonly index: number;
    readonly value: unknown;
  }> = [];
  const seen = new Set<string>();
  const stack: Array<{
    readonly id: string;
    readonly parentId?: string;
    readonly index: number;
  }> = [{ id: operation.treeNodeId, parentId, index: originalIndex }];
  while (stack.length) {
    const frame = stack.pop() as (typeof stack)[number];
    const entry = node(tree, frame.id);
    if (!entry || seen.has(frame.id) || entry.parentId !== frame.parentId)
      return rejected('invalid-tree', 'Tree contains an invalid descendant.');
    seen.add(frame.id);
    entries.push({
      id: frame.id,
      parentId: frame.parentId,
      index: frame.index,
      value: cloneValue(entry.value, 'inverse'),
    });
    for (let index = entry.children.length - 1; index >= 0; index -= 1) {
      const childId = entry.children[index];
      const child = node(tree, childId);
      if (!child || child.parentId !== frame.id)
        return rejected('invalid-tree', 'Tree child links are inconsistent.');
      stack.push({ id: childId, parentId: frame.id, index });
    }
  }

  if (parentNode) parentNode.children.splice(originalIndex, 1);
  for (let index = entries.length - 1; index >= 0; index -= 1) delete tree.nodes[entries[index].id];
  if (tree.rootId === operation.treeNodeId) delete tree.rootId;
  return {
    status: 'changed',
    inverse: entries.map(entry => ({
      type: 'tree.insert' as const,
      at: operation.at,
      treeNodeId: entry.id,
      ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
      index: entry.index,
      value: entry.value,
    })),
  };
};

export const move = (
  tree: MutableTree,
  operation: Extract<TreeOperation, { type: 'tree.move' }>
): TreeOutcome => {
  const entry = node(tree, operation.treeNodeId);
  if (!entry)
    return rejected('missing-tree-node', `Tree node '${operation.treeNodeId}' does not exist.`);
  if (!validIndex(operation.index)) return rejected('invalid-tree-index', 'Tree index is invalid.');
  if (tree.rootId === operation.treeNodeId)
    return rejected('invalid-tree', 'The root cannot be moved.');
  if (operation.parentId === undefined) {
    return rejected('invalid-tree', 'Only the root can have no parent.');
  }
  const nextParent = node(tree, operation.parentId);
  if (!nextParent)
    return rejected('missing-tree-parent', `Tree parent '${operation.parentId}' does not exist.`);
  if (operation.parentId === operation.treeNodeId)
    return rejected('tree-cycle', 'A tree node cannot parent itself.');

  const descendants = [operation.treeNodeId];
  const seen = new Set<string>();
  while (descendants.length) {
    const id = descendants.pop() as string;
    if (seen.has(id)) return rejected('invalid-tree', 'Tree contains a cycle.');
    seen.add(id);
    const current = node(tree, id);
    if (!current) return rejected('invalid-tree', 'Tree contains a missing node.');
    for (const childId of current.children) {
      const child = node(tree, childId);
      if (!child || child.parentId !== id)
        return rejected('invalid-tree', 'Tree child links are inconsistent.');
      if (childId === operation.parentId)
        return rejected('tree-cycle', 'Tree move would create a cycle.');
      descendants.push(childId);
    }
  }

  const parentId = entry.parentId;
  const currentParent = parentId === undefined ? undefined : node(tree, parentId);
  if (!currentParent || parentId === undefined)
    return rejected('invalid-tree', 'Tree parent links are inconsistent.');
  const originalIndex = childIndex(currentParent, operation.treeNodeId);
  if (originalIndex < 0) return rejected('invalid-tree', 'Tree parent links are inconsistent.');
  let nextIndex = Math.min(
    operation.index ?? nextParent.children.length,
    nextParent.children.length
  );
  currentParent.children.splice(originalIndex, 1);
  if (parentId === operation.parentId && nextIndex > originalIndex) nextIndex -= 1;
  if (parentId === operation.parentId && nextIndex === originalIndex) {
    currentParent.children.splice(originalIndex, 0, operation.treeNodeId);
    return { status: 'unchanged' };
  }
  nextParent.children.splice(nextIndex, 0, operation.treeNodeId);
  entry.parentId = operation.parentId;
  return {
    status: 'changed',
    inverse: [
      {
        type: 'tree.move',
        at: operation.at,
        treeNodeId: operation.treeNodeId,
        parentId,
        index: originalIndex,
      },
    ],
  };
};
