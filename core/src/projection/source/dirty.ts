import * as relation from '@/address/relation';
import type { ChangeSet } from '@/changes';
import type { CollectionSelector, ValueSelector } from '@/schema/path';

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

const locateRange = (
  dirty: DocumentDirty,
  path: readonly string[],
  start: number,
  tail?: string
): DocumentDirty | undefined => {
  let current = dirty;
  for (let index = start; index < path.length; index++) {
    if (current.replace) return undefined;
    const key = path[index];
    let child = current.children.get(key);
    if (!child) {
      child = createDocumentDirty();
      current.children.set(key, child);
    }
    current = child;
  }
  if (tail === undefined) return current;
  if (current.replace) return undefined;
  let child = current.children.get(tail);
  if (!child) {
    child = createDocumentDirty();
    current.children.set(tail, child);
  }
  return child;
};

const replaceAt = (
  dirty: DocumentDirty,
  path: readonly string[],
  start: number,
  tail?: string
): void => {
  const current = locateRange(dirty, path, start, tail);
  if (!current) return;
  current.replace = true;
  current.order = false;
  current.treeRoot = false;
  current.treeNodes.clear();
  current.children.clear();
};

export const markDocumentReplace = (dirty: DocumentDirty, path: readonly string[]): void => {
  replaceAt(dirty, path, 0);
};

const markDocumentOrderRange = (
  dirty: DocumentDirty,
  path: readonly string[],
  start: number
): void => {
  const current = locateRange(dirty, path, start);
  if (current && !current.replace) current.order = true;
};

const markDocumentTree = (
  dirty: DocumentDirty,
  path: readonly string[],
  start: number,
  root: boolean,
  nodes: readonly { readonly id: string }[]
): void => {
  const current = locateRange(dirty, path, start);
  if (!current || current.replace) return;
  current.treeRoot ||= root;
  for (const node of nodes) current.treeNodes.add(node.id);
};

type DocumentCollectionPending = {
  reset: boolean;
  order: boolean;
  readonly entries: Map<string, DocumentDirty>;
};

export const createCollectionPending = (): DocumentCollectionPending => ({
  reset: false,
  order: false,
  entries: new Map(),
});

export const resetCollectionPending = (pending: DocumentCollectionPending): void => {
  pending.reset = true;
  pending.order = false;
  pending.entries.clear();
};

export const clearCollectionPending = (pending: DocumentCollectionPending): void => {
  pending.reset = false;
  pending.order = false;
  pending.entries.clear();
};

const dirtyEntry = (pending: DocumentCollectionPending, key: string): DocumentDirty => {
  let dirty = pending.entries.get(key);
  if (!dirty) {
    dirty = createDocumentDirty();
    pending.entries.set(key, dirty);
  }
  return dirty;
};

export const mergeValueChanges = (
  selector: ValueSelector,
  dirty: DocumentDirty,
  changes: ChangeSet
): void => {
  if (selector.tree) return;
  const at = selector.address;
  for (const change of changes.changes) {
    if (change.kind === 'reset') {
      replaceAt(dirty, at, at.length);
      return;
    }
    if (change.kind === 'members') {
      for (const member of change.members) {
        const compared = relation.compareExtended(change.at, member.key, at);
        if (compared === 'ancestor' || compared === 'equal') replaceAt(dirty, at, at.length);
        else if (compared === 'descendant') replaceAt(dirty, change.at, at.length, member.key);
      }
      if (change.order && relation.contains(at, change.at))
        markDocumentOrderRange(dirty, change.at, at.length);
      continue;
    }
    if (relation.contains(at, change.at))
      markDocumentTree(dirty, change.at, at.length, change.before !== change.after, change.nodes);
  }
};

export const mergeCollectionChanges = (
  selector: CollectionSelector,
  pending: DocumentCollectionPending,
  changes: ChangeSet
): void => {
  if (pending.reset) return;
  const at = selector.address;
  for (const change of changes.changes) {
    if (change.kind === 'reset') {
      resetCollectionPending(pending);
      return;
    }

    if (selector.tree?.kind === 'nodes') {
      if (change.kind === 'members') {
        for (const member of change.members) {
          const compared = relation.compareExtended(change.at, member.key, at);
          if (compared === 'ancestor' || compared === 'equal') {
            resetCollectionPending(pending);
            return;
          }
        }
      } else if (change.at.length === at.length && relation.contains(change.at, at)) {
        for (const node of change.nodes) {
          replaceAt(dirtyEntry(pending, node.id), at, at.length);
          pending.order ||= node.kind !== 'updated';
        }
      } else if (relation.contains(change.at, at)) {
        resetCollectionPending(pending);
        return;
      }
      continue;
    }

    if (change.kind === 'members') {
      for (const member of change.members) {
        const compared = relation.compareExtended(change.at, member.key, at);
        if (compared === 'ancestor' || compared === 'equal') {
          resetCollectionPending(pending);
          return;
        }
        if (compared !== 'descendant') continue;
        if (at.length === change.at.length) {
          replaceAt(dirtyEntry(pending, member.key), change.at, change.at.length);
          if (member.kind !== 'updated') pending.order = true;
        } else {
          const entry = dirtyEntry(pending, change.at[at.length]);
          replaceAt(entry, change.at, at.length + 1, member.key);
        }
      }
      if (change.order && relation.contains(at, change.at)) {
        if (change.at.length === at.length) pending.order = true;
        else
          markDocumentOrderRange(
            dirtyEntry(pending, change.at[at.length]),
            change.at,
            at.length + 1
          );
      }
      continue;
    }

    if (!relation.contains(at, change.at)) continue;
    if (change.at.length === at.length) {
      resetCollectionPending(pending);
      return;
    }
    markDocumentTree(
      dirtyEntry(pending, change.at[at.length]),
      change.at,
      at.length + 1,
      change.before !== change.after,
      change.nodes
    );
  }
};
