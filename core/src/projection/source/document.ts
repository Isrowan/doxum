import { contains, nodeAt, read as readAddress } from '../../address';
import type { ChangeSet } from '../../changes';
import * as impactTarget from '../../impact-target';
import * as ordered from '../../ordered-key';
import { accessOf } from '../../runtime/access';
import { attachProjection } from '../../runtime/notification';
import type { DocumentCommit, DocumentReadable, Unsubscribe } from '../../runtime/contract';
import { collectionEntryNode } from '../../schema';
import type {
  CollectionSelector,
  DocumentTreeNode,
  ImpactTarget,
  ObjectNode,
  ValueSelector,
} from '../../schema';
import { copyTreeNode, copyValue, equalTreeNode } from '../../schema-value';
import { isRecord } from '../../value/ownership';
import type { CollectionRead } from '../contract';
import type { SourceDefinition } from '../definition';
import {
  clearDocumentDirty,
  createDocumentDirty,
  markDocumentOrder,
  markDocumentReplace,
  markDocumentTree,
  materializeDocumentValue,
  type DocumentDirty,
} from './materialization';
import { assertScope, type Scheduler } from '../graph/scheduler';
import {
  createCollectionBoundary,
  createValueBoundary,
  type CollectionBoundary,
  type SourceMaterialization,
  type ValueBoundary,
} from './boundary';

type DocumentBinding = {
  readonly target: ImpactTarget;
  capture(commit: DocumentCommit<ObjectNode>): void;
  dispose(): void;
};

type DocumentConnection = {
  add(binding: DocumentBinding): Unsubscribe;
  close(): void;
};

type DocumentCollectionPending = {
  reset: boolean;
  order: boolean;
  readonly entries: Map<string, DocumentDirty>;
};

const documentRootTarget: ImpactTarget = Object.freeze({
  kind: 'value' as const,
  at: Object.freeze([]),
});

const createCollectionPending = (): DocumentCollectionPending => ({
  reset: false,
  order: false,
  entries: new Map(),
});

const resetCollectionPending = (pending: DocumentCollectionPending): void => {
  pending.reset = true;
  pending.order = false;
  pending.entries.clear();
};

const clearCollectionPending = (pending: DocumentCollectionPending): void => {
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

const mergeValueChanges = (
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
        if (contains(changed, at)) markDocumentReplace(dirty, []);
        else if (contains(at, changed)) markDocumentReplace(dirty, changed.slice(at.length));
      }
      if (change.order && contains(at, change.at))
        markDocumentOrder(dirty, change.at.slice(at.length));
      continue;
    }
    if (contains(at, change.at))
      markDocumentTree(
        dirty,
        change.at.slice(at.length),
        change.before !== change.after,
        change.nodes.map(node => node.id)
      );
  }
};

const mergeCollectionChanges = (
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
          if (contains(changed, at)) {
            resetCollectionPending(pending);
            return;
          }
        }
      } else if (change.at.length === at.length && contains(change.at, at)) {
        for (const node of change.nodes) {
          markDocumentReplace(dirtyEntry(pending, node.id), []);
          pending.order ||= node.kind !== 'updated';
        }
      } else if (contains(change.at, at)) {
        resetCollectionPending(pending);
        return;
      }
      continue;
    }

    if (change.kind === 'members') {
      for (const member of change.members) {
        const changed = [...change.at, member.key];
        if (contains(changed, at)) {
          resetCollectionPending(pending);
          return;
        }
        if (!contains(at, changed)) continue;
        const relative = changed.slice(at.length);
        if (!relative.length) {
          resetCollectionPending(pending);
          return;
        }
        const entry = dirtyEntry(pending, relative[0]);
        markDocumentReplace(entry, relative.slice(1));
        if (relative.length === 1 && member.kind !== 'updated') pending.order = true;
      }
      if (change.order && contains(at, change.at)) {
        const relative = change.at.slice(at.length);
        if (!relative.length) pending.order = true;
        else markDocumentOrder(dirtyEntry(pending, relative[0]), relative.slice(1));
      }
      continue;
    }

    if (!contains(at, change.at)) continue;
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

export const createDocumentSourceRegistry = (scheduler: Scheduler) => {
  const documents = new Map<object, DocumentConnection>();

  const connection = <S extends ObjectNode>(runtime: DocumentReadable<S>): DocumentConnection => {
    const state = accessOf(runtime);
    const cached = documents.get(state);
    if (cached) return cached;
    if (state.disposed) throw new Error('Document has been disposed.');
    const bindings = new Set<DocumentBinding>();
    const index = new impactTarget.SubscriptionIndex<DocumentBinding>(state.schema);
    const candidates = new Set<DocumentBinding>();
    const guard = (locked: boolean) => {
      state.projectionLocks = (state.projectionLocks ?? 0) + (locked ? 1 : -1);
    };
    scheduler.guards.add(guard);
    let closed = false;
    let detach: Unsubscribe = () => undefined;
    const documentConnection: DocumentConnection = {
      add(binding) {
        if (closed) throw new Error('Document projection connection is closed.');
        bindings.add(binding);
        index.add(binding.target, binding);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          bindings.delete(binding);
          index.delete(binding.target, binding);
          if (!bindings.size) documentConnection.close();
        };
      },
      close() {
        if (closed) return;
        closed = true;
        detach();
        bindings.clear();
        candidates.clear();
        index.clear();
        scheduler.guards.delete(guard);
        documents.delete(state);
      },
    };
    detach = attachProjection(runtime, {
      capture: commit => {
        candidates.clear();
        index.collect(commit.changes, binding => candidates.add(binding));
        candidates.forEach(binding => binding.capture(commit as DocumentCommit<ObjectNode>));
      },
      settle: scheduler.settle,
      flush: scheduler.flush,
      dispose: () => {
        for (const binding of bindings) binding.dispose();
        scheduler.run();
      },
    });
    documents.set(state, documentConnection);
    return documentConnection;
  };

  const materialize = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'document') throw new Error('Invalid document source.');
    const { document, selector } = definition.source;
    const state = accessOf(document);
    const schemaNode = () => nodeAt(state.schema, selector.address, state.document);
    const currentValue = () => readAddress(state.document, selector.address, state.schema);
    const disposed = () => {
      if (state.disposed) throw new Error('Document has been disposed.');
    };

    if (selector.kind === 'value') {
      const dirty = createDocumentDirty();
      const read = (previous?: unknown): unknown => {
        disposed();
        const node = schemaNode();
        const current = currentValue();
        if (selector.tree?.kind === 'root')
          return node?.kind === 'tree' && isRecord(current) && typeof current.rootId === 'string'
            ? current.rootId
            : undefined;
        if (selector.tree?.kind === 'node') {
          if (node?.kind !== 'tree' || !isRecord(current) || !isRecord(current.nodes))
            return undefined;
          const entry = Object.hasOwn(current.nodes, selector.tree.id)
            ? (current.nodes[selector.tree.id] as
                DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true>)
            : undefined;
          if (
            equalTreeNode(
              previous as
                DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true> | undefined,
              entry
            )
          )
            return previous;
          return entry ? copyTreeNode(entry) : undefined;
        }
        if (!node) return undefined;
        return previous === undefined
          ? copyValue(node, current)
          : materializeDocumentValue(node, previous, current, dirty);
      };

      const initial = read();
      let boundary!: ValueBoundary;
      boundary = createValueBoundary(
        scheduler,
        'document source',
        initial,
        Object.is,
        previous => read(previous),
        failed => {
          if (failed) markDocumentReplace(dirty, []);
          else clearDocumentDirty(dirty);
        }
      );
      const remove = connection(document).add({
        target: selector,
        capture: commit => {
          try {
            mergeValueChanges(selector, dirty, commit.changes);
            boundary.mark({
              reset: commit.changes.changes.some(change => change.kind === 'reset'),
            });
          } catch (cause) {
            boundary.fail(cause);
          }
        },
        dispose: () => boundary.fail(new Error('Document has been disposed.')),
      });
      boundary.detach(remove);
      return boundary;
    }

    const pending = createCollectionPending();
    const read = (
      active: () => boolean,
      previous: CollectionRead<string, unknown>
    ): CollectionRead<string, unknown> => {
      disposed();
      const node = schemaNode();
      const value = currentValue();
      const treeNodes = selector.tree?.kind === 'nodes';
      const entryNode = !treeNodes && node ? collectionEntryNode(node) : undefined;
      const snapshots = new Map<string, unknown>();
      const replacement = createDocumentDirty();
      if (pending.reset) markDocumentReplace(replacement, []);

      const ids = (): readonly string[] => {
        assertScope(active);
        if (treeNodes)
          return node?.kind === 'tree' && isRecord(value) && isRecord(value.nodes)
            ? Object.freeze(Object.keys(value.nodes))
            : Object.freeze([]);
        if (node?.kind === 'map' && isRecord(value)) return Object.freeze(Object.keys(value));
        if (node?.kind === 'table' && isRecord(value) && Array.isArray(value.ids))
          return Object.freeze([...(value.ids as string[])]);
        if (node?.kind === 'list' && Array.isArray(value))
          return Object.freeze(ordered.toArray(ordered.indexedKeys(value, node.keyOf)));
        return Object.freeze([]);
      };

      const has = (key: string): boolean => {
        assertScope(active);
        if (treeNodes)
          return Boolean(
            node?.kind === 'tree' &&
            isRecord(value) &&
            isRecord(value.nodes) &&
            Object.hasOwn(value.nodes, key)
          );
        if (node?.kind === 'map' && isRecord(value)) return Object.hasOwn(value, key);
        if (node?.kind === 'table' && isRecord(value) && isRecord(value.byId))
          return Object.hasOwn(value.byId, key);
        if (node?.kind === 'list' && Array.isArray(value))
          return ordered.indexedKeys(value, node.keyOf).index(key) >= 0;
        return false;
      };

      const raw = (key: string): unknown => {
        if (treeNodes) {
          if (node?.kind !== 'tree' || !isRecord(value) || !isRecord(value.nodes)) return undefined;
          return Object.hasOwn(value.nodes, key) ? value.nodes[key] : undefined;
        }
        if (node?.kind === 'map' && isRecord(value))
          return Object.hasOwn(value, key) ? value[key] : undefined;
        if (node?.kind === 'table' && isRecord(value) && isRecord(value.byId))
          return Object.hasOwn(value.byId, key) ? value.byId[key] : undefined;
        if (node?.kind === 'list' && Array.isArray(value)) {
          const index = ordered.indexedKeys(value, node.keyOf).index(key);
          return index < 0 ? undefined : value[index];
        }
        return undefined;
      };

      return Object.freeze({
        get: (key: string) => {
          assertScope(active);
          if (!snapshots.has(key)) {
            if (!has(key)) snapshots.set(key, undefined);
            else {
              const current = raw(key);
              if (treeNodes) {
                const entry = current as
                  DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true>;
                const before = previous.has(key)
                  ? (previous.get(key) as
                      DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true>)
                  : undefined;
                snapshots.set(key, equalTreeNode(before, entry) ? before : copyTreeNode(entry));
              } else if (!entryNode) snapshots.set(key, current);
              else if (!previous.has(key)) snapshots.set(key, copyValue(entryNode, current));
              else {
                const dirty = pending.entries.get(key) ?? (pending.reset ? replacement : undefined);
                snapshots.set(
                  key,
                  dirty
                    ? materializeDocumentValue(entryNode, previous.get(key), current, dirty)
                    : previous.get(key)
                );
              }
            }
          }
          return snapshots.get(key);
        },
        has,
        ids,
      });
    };

    let boundary!: CollectionBoundary;
    boundary = createCollectionBoundary(
      scheduler,
      'document collection source',
      read,
      Object.is,
      failed => {
        if (failed) resetCollectionPending(pending);
        else clearCollectionPending(pending);
      }
    );
    const remove = connection(document).add({
      target: selector,
      capture: commit => {
        try {
          mergeCollectionChanges(selector, pending, commit.changes);
          boundary.mark({
            reset: pending.reset,
            ...(pending.reset ? {} : { candidates: pending.entries.keys() }),
            orderMayChange: pending.order,
          });
        } catch (cause) {
          boundary.fail(cause);
        }
      },
      dispose: () => boundary.fail(new Error('Document has been disposed.')),
    });
    boundary.detach(remove);
    return boundary;
  };

  return {
    materialize,
    attachRoot<S extends ObjectNode>(
      runtime: DocumentReadable<S>,
      handlers: { readonly capture: () => void; readonly dispose: () => void }
    ): Unsubscribe {
      return connection(runtime).add({
        target: documentRootTarget,
        capture: handlers.capture,
        dispose: handlers.dispose,
      });
    },
    dispose() {
      documents.forEach(document => document.close());
      documents.clear();
    },
  };
};
