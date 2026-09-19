import { compiledShape } from '../address';
import * as anchor from '../mutation/anchor';
import { installMember } from '../mutation/state';
import { profile } from '../profile';
import type { DocumentNode, DocumentTreeNode } from '../schema';
import { copyTreeNode, copyValue, equalTreeNode, equalValue } from '../schema-value';
import { isRecord } from '../value/ownership';

export type DocumentDirty = {
  replace: boolean;
  order: boolean;
  treeRoot: boolean;
  readonly treeNodes: Set<string>;
  readonly children: Map<string, DocumentDirty>;
};

export const createDocumentDirty = (): DocumentDirty => ({
  replace: false,
  order: false,
  treeRoot: false,
  treeNodes: new Set(),
  children: new Map(),
});

export const clearDocumentDirty = (dirty: DocumentDirty): void => {
  dirty.replace = false;
  dirty.order = false;
  dirty.treeRoot = false;
  dirty.treeNodes.clear();
  dirty.children.clear();
};

export const hasDocumentDirty = (dirty: DocumentDirty): boolean =>
  dirty.replace ||
  dirty.order ||
  dirty.treeRoot ||
  dirty.treeNodes.size > 0 ||
  dirty.children.size > 0;

const locate = (dirty: DocumentDirty, path: readonly string[]): DocumentDirty | undefined => {
  let current = dirty;
  for (const key of path) {
    if (current.replace) return undefined;
    let child = current.children.get(key);
    if (!child) {
      child = createDocumentDirty();
      current.children.set(key, child);
    }
    current = child;
  }
  return current;
};

export const markDocumentReplace = (dirty: DocumentDirty, path: readonly string[]): void => {
  const current = locate(dirty, path);
  if (!current) return;
  current.replace = true;
  current.order = false;
  current.treeRoot = false;
  current.treeNodes.clear();
  current.children.clear();
};

export const markDocumentOrder = (dirty: DocumentDirty, path: readonly string[]): void => {
  const current = locate(dirty, path);
  if (current && !current.replace) current.order = true;
};

export const markDocumentTree = (
  dirty: DocumentDirty,
  path: readonly string[],
  root: boolean,
  nodes: Iterable<string>
): void => {
  const current = locate(dirty, path);
  if (!current || current.replace) return;
  current.treeRoot ||= root;
  for (const id of nodes) current.treeNodes.add(id);
};

const equivalent = (node: DocumentNode, left: unknown, right: unknown): boolean =>
  node.kind === 'field' ? Object.is(left, right) : equalValue(node, left, right);

const replaceValue = (node: DocumentNode, previous: unknown, current: unknown): unknown =>
  equivalent(node, previous, current) ? previous : copyValue(node, current);

const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> => {
  profile.copy.shallowRecord(Object.getOwnPropertyNames(value).length);
  return Object.create(
    Object.getPrototypeOf(value),
    Object.getOwnPropertyDescriptors(value)
  ) as Record<string, unknown>;
};

const materializeRecordChild = (
  node: DocumentNode,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  key: string,
  dirty: DocumentDirty
):
  | { readonly changed: false }
  | { readonly changed: true; readonly present: boolean; readonly value: unknown } => {
  const before = Object.hasOwn(previous, key);
  const after = Object.hasOwn(current, key);
  if (!before && !after) return { changed: false };
  if (!after) return { changed: true, present: false, value: undefined };
  const next = before
    ? materializeDocumentValue(node, previous[key], current[key], dirty)
    : copyValue(node, current[key]);
  if (before && next === previous[key]) return { changed: false };
  return { changed: true, present: true, value: next };
};

const materializeObject = (
  node: Extract<DocumentNode, { kind: 'object' | 'variant' }>,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  dirty: DocumentDirty
): unknown => {
  if (node.kind === 'variant' && previous[node.tag] !== current[node.tag])
    return replaceValue(node, previous, current);
  const layout = compiledShape(node, current);
  if (!layout) return replaceValue(node, previous, current);
  let result: Record<string, unknown> | undefined;
  for (const [key, childDirty] of dirty.children) {
    const member = layout.members.get(key);
    if (!member) return replaceValue(node, previous, current);
    const child = materializeRecordChild(member.node, previous, current, key, childDirty);
    if (!child.changed) continue;
    result ??= cloneRecord(previous);
    installMember(result, key, child.present, child.value);
  }
  return result ?? previous;
};

const materializeMap = (
  node: Extract<DocumentNode, { kind: 'map' }>,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  dirty: DocumentDirty
): unknown => {
  let result: Record<string, unknown> | undefined;
  for (const [key, childDirty] of dirty.children) {
    const child = materializeRecordChild(node.value, previous, current, key, childDirty);
    if (!child.changed) continue;
    result ??= cloneRecord(previous);
    installMember(result, key, child.present, child.value);
  }
  return result ?? previous;
};

const materializeTable = (
  node: Extract<DocumentNode, { kind: 'table' }>,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  dirty: DocumentDirty
): unknown => {
  if (!isRecord(previous.byId) || !isRecord(current.byId))
    return replaceValue(node, previous, current);
  const beforeById = previous.byId;
  const afterById = current.byId;
  let result: Record<string, unknown> | undefined;
  let nextById: Record<string, unknown> | undefined;
  for (const [key, childDirty] of dirty.children) {
    const child = materializeRecordChild(node.value, beforeById, afterById, key, childDirty);
    if (!child.changed) continue;
    nextById ??= cloneRecord(beforeById);
    installMember(nextById, key, child.present, child.value);
  }
  if (nextById) {
    result = cloneRecord(previous);
    installMember(result, 'byId', true, nextById);
  }
  if (dirty.order) {
    const beforeIds = previous.ids;
    const afterIds = current.ids;
    if (!Array.isArray(beforeIds) || !Array.isArray(afterIds))
      return replaceValue(node, previous, current);
    if (!anchor.equal(beforeIds as string[], afterIds as string[])) {
      result ??= cloneRecord(previous);
      installMember(result, 'ids', true, [...(afterIds as string[])]);
    }
  }
  return result ?? previous;
};

const materializeList = (
  node: Extract<DocumentNode, { kind: 'list' }>,
  previous: readonly unknown[],
  current: readonly unknown[],
  dirty: DocumentDirty
): unknown => {
  if (dirty.order) {
    const before = anchor.listSequence(previous, node.keyOf);
    const after = anchor.listSequence(current, node.keyOf);
    const sameOrder = anchor.equal(before.order, after.order);
    let changed = !sameOrder;
    const result = new Array<unknown>(after.order.length);
    for (let index = 0; index < after.order.length; index++) {
      const key = after.order[index];
      const currentValue = after.values.get(key);
      if (!before.values.has(key)) {
        changed = true;
        result[index] = currentValue;
        continue;
      }
      const previousValue = before.values.get(key);
      const childDirty = dirty.children.get(key);
      const next = childDirty
        ? materializeDocumentValue(node.value, previousValue, currentValue, childDirty)
        : previousValue;
      changed ||= next !== previousValue;
      result[index] = next;
    }
    return changed ? result : previous;
  }

  let result: unknown[] | undefined;
  const before = anchor.indexedKeys(previous, node.keyOf);
  const after = anchor.indexedKeys(current, node.keyOf);
  for (const [key, childDirty] of dirty.children) {
    const previousIndex = before.index(key);
    const currentIndex = after.index(key);
    if (previousIndex < 0 || currentIndex < 0) return replaceValue(node, previous, current);
    const next = materializeDocumentValue(
      node.value,
      previous[previousIndex],
      current[currentIndex],
      childDirty
    );
    if (next === previous[previousIndex] && previousIndex === currentIndex) continue;
    result ??= [...previous];
    result[currentIndex] = next;
  }
  return result ?? previous;
};

const materializeTree = (
  node: Extract<DocumentNode, { kind: 'tree' }>,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  dirty: DocumentDirty
): unknown => {
  if (!isRecord(previous.nodes) || !isRecord(current.nodes))
    return replaceValue(node, previous, current);
  let result: Record<string, unknown> | undefined;

  if (dirty.treeRoot) {
    const beforePresent = Object.hasOwn(previous, 'rootId');
    const afterPresent = Object.hasOwn(current, 'rootId');
    if (beforePresent !== afterPresent || !Object.is(previous.rootId, current.rootId)) {
      result = cloneRecord(previous);
      installMember(result, 'rootId', afterPresent, current.rootId);
    }
  }

  let nodes: Record<string, unknown> | undefined;
  for (const id of dirty.treeNodes) {
    const beforePresent = Object.hasOwn(previous.nodes, id);
    const afterPresent = Object.hasOwn(current.nodes, id);
    const before = beforePresent
      ? (previous.nodes[id] as DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true>)
      : undefined;
    const after = afterPresent
      ? (current.nodes[id] as DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true>)
      : undefined;
    if (beforePresent === afterPresent && equalTreeNode(before, after)) continue;
    nodes ??= cloneRecord(previous.nodes);
    installMember(nodes, id, afterPresent, after && copyTreeNode(after));
  }
  if (nodes) {
    result ??= cloneRecord(previous);
    installMember(result, 'nodes', true, nodes);
  }
  return result ?? previous;
};

export const materializeDocumentValue = (
  node: DocumentNode,
  previous: unknown,
  current: unknown,
  dirty: DocumentDirty
): unknown => {
  if (!hasDocumentDirty(dirty)) return previous;
  if (dirty.replace || previous === undefined || current === undefined || node.kind === 'field')
    return replaceValue(node, previous, current);
  if (node.kind === 'object' || node.kind === 'variant') {
    if (!isRecord(previous) || !isRecord(current)) return replaceValue(node, previous, current);
    return materializeObject(node, previous, current, dirty);
  }
  if (node.kind === 'map') {
    if (!isRecord(previous) || !isRecord(current)) return replaceValue(node, previous, current);
    return materializeMap(node, previous, current, dirty);
  }
  if (node.kind === 'table') {
    if (!isRecord(previous) || !isRecord(current)) return replaceValue(node, previous, current);
    return materializeTable(node, previous, current, dirty);
  }
  if (node.kind === 'list') {
    if (!Array.isArray(previous) || !Array.isArray(current))
      return replaceValue(node, previous, current);
    return materializeList(node, previous, current, dirty);
  }
  if (!isRecord(previous) || !isRecord(current)) return replaceValue(node, previous, current);
  return materializeTree(node, previous, current, dirty);
};
