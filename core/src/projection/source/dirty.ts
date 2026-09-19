import * as relation from '../../address/relation';
import type { ChangeSet } from '../../changes';
import type { CollectionSelector, ValueSelector } from '../../schema';
import {
  createDocumentDirty,
  markDocumentOrder,
  markDocumentReplace,
  markDocumentTree,
  type DocumentDirty,
} from './materialization';

export type DocumentCollectionPending = {
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
      markDocumentReplace(dirty, []);
      return;
    }
    if (change.kind === 'members') {
      for (const member of change.members) {
        const changed = [...change.at, member.key];
        if (relation.contains(changed, at)) markDocumentReplace(dirty, []);
        else if (relation.contains(at, changed))
          markDocumentReplace(dirty, changed.slice(at.length));
      }
      if (change.order && relation.contains(at, change.at))
        markDocumentOrder(dirty, change.at.slice(at.length));
      continue;
    }
    if (relation.contains(at, change.at))
      markDocumentTree(
        dirty,
        change.at.slice(at.length),
        change.before !== change.after,
        change.nodes.map(node => node.id)
      );
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
          const changed = [...change.at, member.key];
          if (relation.contains(changed, at)) {
            resetCollectionPending(pending);
            return;
          }
        }
      } else if (change.at.length === at.length && relation.contains(change.at, at)) {
        for (const node of change.nodes) {
          markDocumentReplace(dirtyEntry(pending, node.id), []);
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
        const changed = [...change.at, member.key];
        if (relation.contains(changed, at)) {
          resetCollectionPending(pending);
          return;
        }
        if (!relation.contains(at, changed)) continue;
        const relative = changed.slice(at.length);
        if (!relative.length) {
          resetCollectionPending(pending);
          return;
        }
        const entry = dirtyEntry(pending, relative[0]);
        markDocumentReplace(entry, relative.slice(1));
        if (relative.length === 1 && member.kind !== 'updated') pending.order = true;
      }
      if (change.order && relation.contains(at, change.at)) {
        const relative = change.at.slice(at.length);
        if (!relative.length) pending.order = true;
        else markDocumentOrder(dirtyEntry(pending, relative[0]), relative.slice(1));
      }
      continue;
    }

    if (!relation.contains(at, change.at)) continue;
    const relative = change.at.slice(at.length);
    if (!relative.length) {
      resetCollectionPending(pending);
      return;
    }
    markDocumentTree(
      dirtyEntry(pending, relative[0]),
      relative.slice(1),
      change.before !== change.after,
      change.nodes.map(node => node.id)
    );
  }
};
