import * as address from '../../address/resolve';
import * as impactTarget from '../../impact/target';
import * as sequence from '../../order/sequence';
import { contextOf } from '../../runtime/context';
import type { ReadonlyDocument, Unsubscribe } from '../../runtime/contract';
import { collectionEntryNode } from '../../schema/model';
import type { DocumentTreeNode, ObjectSchema } from '../../schema/model';
import type { ImpactTarget } from '../../schema/path';
import type { ChangeSet } from '../../changes';
import * as schemaValue from '../../schema/value';
import { isRecord } from '../../value/record';
import type { CollectionRead } from '../contract';
import type { SourceDefinition } from '../definition';
import { materializeDocumentValue } from './materialization';
import {
  clearCollectionPending,
  clearDocumentDirty,
  createCollectionPending,
  createDocumentDirty,
  markDocumentReplace,
  mergeCollectionChanges,
  mergeValueChanges,
  resetCollectionPending,
} from './dirty';
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
  capture(commit: { readonly changes: ChangeSet }): void;
  dispose(): void;
};

type DocumentConnection = {
  add(binding: DocumentBinding): Unsubscribe;
  close(): void;
};

const documentRootTarget: ImpactTarget = Object.freeze({
  kind: 'value' as const,
  at: Object.freeze([]),
});

export const createDocumentSourceRegistry = (scheduler: Scheduler) => {
  const documents = new Map<object, DocumentConnection>();

  const connection = <S extends ObjectSchema<object>>(
    runtime: ReadonlyDocument<S>
  ): DocumentConnection => {
    const context = contextOf<S>(runtime);
    const state = context.state;
    const cached = documents.get(state);
    if (cached) return cached;
    if (state.disposed) throw new Error('Document has been disposed.');
    const bindings = new Set<DocumentBinding>();
    const index = new impactTarget.SubscriptionIndex<DocumentBinding>(state.schema);
    const candidates = new Set<DocumentBinding>();
    const guard = (locked: boolean) => {
      state.projectionLocks += locked ? 1 : -1;
    };
    let unregisterGuard = scheduler.registerGuard(guard);
    let closed = false;
    let detach: Unsubscribe | undefined;
    const documentConnection: DocumentConnection = {
      add(binding) {
        if (closed) throw new Error('Document projection connection is closed.');
        bindings.add(binding);
        try {
          index.add(binding.target, binding);
        } catch (error) {
          bindings.delete(binding);
          throw error;
        }
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
        const stopNotifications = detach;
        detach = undefined;
        const stopGuard = unregisterGuard;
        unregisterGuard = () => undefined;
        bindings.clear();
        candidates.clear();
        index.clear();
        documents.delete(state);
        const failures: unknown[] = [];
        try {
          stopNotifications?.();
        } catch (error) {
          failures.push(error);
        }
        try {
          stopGuard();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw failures[0];
      },
    };
    try {
      detach = context.notifications.attachProjection({
        capture: commit => {
          candidates.clear();
          index.collect(commit.changes, binding => candidates.add(binding));
          candidates.forEach(binding => binding.capture(commit));
        },
        settle: scheduler.settle,
        flush: scheduler.flush,
        dispose: () => {
          const failures: unknown[] = [];
          for (const binding of [...bindings]) {
            try {
              binding.dispose();
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            scheduler.run();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) throw failures[0];
        },
      });
    } catch (error) {
      try {
        documentConnection.close();
      } catch {
        /* Connection initialization failure retains priority. */
      }
      throw error;
    }
    documents.set(state, documentConnection);
    return documentConnection;
  };

  const materialize = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'document') throw new Error('Invalid document source.');
    const { document, selector } = definition.source;
    const state = contextOf(document).state;
    const current = () => address.resolveValue(state.schema, state.document, selector.address);
    const disposed = () => {
      if (state.disposed) throw new Error('Document has been disposed.');
    };

    if (selector.kind === 'value') {
      const dirty = createDocumentDirty();
      const read = (previous?: unknown): unknown => {
        disposed();
        const resolved = current();
        const node = resolved?.node;
        const value = resolved?.value;
        if (selector.tree?.kind === 'root')
          return node?.kind === 'tree' && isRecord(value) && typeof value.rootId === 'string'
            ? value.rootId
            : undefined;
        if (selector.tree?.kind === 'node') {
          if (node?.kind !== 'tree' || !isRecord(value) || !isRecord(value.nodes)) return undefined;
          const entry = Object.hasOwn(value.nodes, selector.tree.id)
            ? (value.nodes[selector.tree.id] as
                DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true>)
            : undefined;
          if (
            schemaValue.equalTreeNode(
              previous as
                DocumentTreeNode<unknown, false> | DocumentTreeNode<unknown, true> | undefined,
              entry
            )
          )
            return previous;
          return entry ? schemaValue.copyTreeNode(entry) : undefined;
        }
        if (!node) return undefined;
        return previous === undefined
          ? schemaValue.copyValue(node, value)
          : materializeDocumentValue(node, previous, value, dirty);
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
      let remove: Unsubscribe;
      try {
        remove = connection(document).add({
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
      } catch (error) {
        try {
          scheduler.releaseProducer(boundary.producer);
        } catch {
          /* Connection initialization failure retains priority. */
        }
        throw error;
      }
      boundary.detach(remove);
      return boundary;
    }

    const pending = createCollectionPending();
    const read = (
      active: () => boolean,
      previous: CollectionRead<string, unknown>
    ): CollectionRead<string, unknown> => {
      disposed();
      const resolved = current();
      const node = resolved?.node;
      const value = resolved?.value;
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
          return Object.freeze(sequence.toArray(sequence.indexedKeys(value, node.keyOf)));
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
          return sequence.indexedKeys(value, node.keyOf).index(key) >= 0;
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
          const index = sequence.indexedKeys(value, node.keyOf).index(key);
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
                snapshots.set(
                  key,
                  schemaValue.equalTreeNode(before, entry)
                    ? before
                    : schemaValue.copyTreeNode(entry)
                );
              } else if (!entryNode) snapshots.set(key, current);
              else if (!previous.has(key))
                snapshots.set(key, schemaValue.copyValue(entryNode, current));
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
    let remove: Unsubscribe;
    try {
      remove = connection(document).add({
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
    } catch (error) {
      try {
        scheduler.releaseProducer(boundary.producer);
      } catch {
        /* Connection initialization failure retains priority. */
      }
      throw error;
    }
    boundary.detach(remove);
    return boundary;
  };

  return {
    materialize,
    attachRoot<S extends ObjectSchema<object>>(
      runtime: ReadonlyDocument<S>,
      handlers: { readonly capture: () => void; readonly dispose: () => void }
    ): Unsubscribe {
      return connection(runtime).add({
        target: documentRootTarget,
        capture: handlers.capture,
        dispose: handlers.dispose,
      });
    },
    dispose() {
      const failures: unknown[] = [];
      for (const document of [...documents.values()]) {
        try {
          document.close();
        } catch (error) {
          failures.push(error);
        }
      }
      documents.clear();
      if (failures.length) throw failures[0];
    },
  };
};
