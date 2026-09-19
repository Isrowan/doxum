import { contains, read as readAddress, nodeAt } from '../address';
import type { ChangeSet } from '../changes';
import * as impactTarget from '../impact-target';
import * as anchor from '../mutation/anchor';
import { accessOf } from '../runtime/access';
import { attachProjection, documentReadableOwner } from '../runtime/notification';
import type { DocumentCommit, DocumentReadable, Unsubscribe } from '../runtime/contract';
import type {
  CollectionSelector,
  DocumentTreeNode,
  ImpactTarget,
  ObjectNode,
  ValueSelector,
} from '../schema';
import { collectionEntryNode } from '../schema';
import { copyTreeNode, copyValue, equalTreeNode } from '../schema-value';
import { isRecord } from '../value/ownership';
import {
  createCollectionOutput,
  mapRead,
  stageCollectionRead,
  type CollectionOutputState,
} from './collection-output';
import type {
  CollectionChange,
  CollectionRead,
  ExternalCollectionSource,
  ExternalValueSource,
} from './contract';
import { ProjectionDisposedError, ProjectionError } from './contract';
import type { SourceDefinition } from './definition';
import type { Readable } from './readable';
import {
  assertScope,
  assertSynchronous,
  type OutputRecord,
  type Scheduler,
  type SourceBoundaryRecord,
} from './scheduler';
import { createValueOutput, type ValueOutputState } from './value-output';
import {
  clearDocumentDirty,
  createDocumentDirty,
  markDocumentOrder,
  markDocumentReplace,
  markDocumentTree,
  materializeDocumentValue,
  type DocumentDirty,
} from './document-materialization';

export type KeyedInputDraft<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  remove(key: K): void;
};

export type SourceWrite =
  | { readonly kind: 'value'; set(value: unknown): void }
  | {
      readonly kind: 'collection';
      update(run: (draft: KeyedInputDraft<string, unknown>) => void): void;
    };

export type SourceMaterialization = {
  readonly producer: SourceBoundaryRecord;
  readonly output: OutputRecord;
  readonly write?: SourceWrite;
};

type SourceMark = { readonly reset?: boolean; readonly cause?: unknown };
type CollectionMark = SourceMark & {
  readonly candidates?: Iterable<string>;
  readonly fullScan?: boolean;
  readonly orderMayChange?: boolean;
};

type ValueBoundary = SourceMaterialization & {
  readonly mark: (metadata?: SourceMark) => void;
  readonly fail: (cause: unknown) => void;
  readonly detach: (cleanup: Unsubscribe) => void;
};

type CollectionBoundary = SourceMaterialization & {
  readonly mark: (metadata?: CollectionMark) => void;
  readonly fail: (cause: unknown) => void;
  readonly detach: (cleanup: Unsubscribe) => void;
};

const sourceError = (source: SourceBoundaryRecord, cause: unknown): ProjectionError =>
  new ProjectionError('source', source.name, [source.outputs[0].revision()], cause);

const createValueBoundary = (
  scheduler: Scheduler,
  name: string,
  initial: unknown,
  equality: (previous: unknown, next: unknown) => boolean,
  prepare: (previous: unknown) => unknown,
  clearSource: (failed: boolean) => void
): ValueBoundary => {
  const state: ValueOutputState<unknown> = createValueOutput();
  let boundary!: SourceBoundaryRecord;
  let pendingReset = false;
  let pendingCause: unknown;
  let contextCause: unknown;
  let recovering = false;
  let cleanup: Unsubscribe | undefined;

  const check = () => {
    if (!scheduler.active || boundary.disposed) throw new ProjectionDisposedError();
    if (boundary.fault) throw boundary.fault;
  };

  const output: OutputRecord = {
    kind: 'value',
    get owner() {
      return boundary;
    },
    consumers: new Set(),
    context: active => state.context(active, contextCause),
    current: () => state.current(check),
    revision: state.revision,
    reset: state.reset,
    subscribe: listener => {
      check();
      const wrapped = () => listener();
      state.subscribe(wrapped);
      return () => state.unsubscribe(wrapped);
    },
    emit: state.emit,
    clear: state.clear,
    release: state.release,
  };

  boundary = {
    kind: 'source',
    name,
    outputs: Object.freeze([output]) as readonly [OutputRecord],
    fault: undefined,
    disposed: false,
    pendingCause: () => pendingCause,
    recovering: () => recovering,
    prepare: cause => {
      contextCause = cause;
      let active = true;
      try {
        const evaluation = state.begin(() => active, pendingReset);
        evaluation.output.set(prepare(evaluation.previous));
        const changed = state.seal(pendingReset, equality);
        recovering = false;
        return { changed, force: pendingReset };
      } finally {
        active = false;
      }
    },
    publish: state.publish,
    clear: () => {
      const failed = boundary.fault !== undefined;
      state.clear();
      pendingReset = false;
      pendingCause = undefined;
      contextCause = undefined;
      recovering = false;
      clearSource(failed);
    },
    release: () => {
      cleanup?.();
      cleanup = undefined;
      state.release();
      output.consumers.clear();
    },
  };

  scheduler.initialize(() => {
    let active = true;
    try {
      const evaluation = state.begin(() => active, true);
      evaluation.output.set(initial);
      state.seal(true, equality);
      state.publish();
      state.clear();
    } finally {
      active = false;
    }
  });
  scheduler.addSource(boundary);

  const mark = (metadata: SourceMark = {}) => {
    scheduler.assertIdle();
    pendingReset ||= metadata.reset ?? false;
    if (metadata.cause !== undefined) pendingCause ??= metadata.cause;
    if (boundary.fault) recovering = true;
    scheduler.capture(boundary);
  };
  const fail = (cause: unknown) => {
    boundary.fault = sourceError(boundary, cause);
    recovering = false;
    scheduler.capture(boundary);
  };
  return {
    producer: boundary,
    output,
    mark,
    fail,
    detach: next => {
      cleanup = next;
    },
  };
};

const createCollectionBoundary = (
  scheduler: Scheduler,
  name: string,
  readLatest: (
    active: () => boolean,
    previous: CollectionRead<string, unknown>
  ) => CollectionRead<string, unknown>,
  equality: (previous: unknown, next: unknown) => boolean,
  clearSource: (failed: boolean) => void
): CollectionBoundary => {
  const state: CollectionOutputState<string, unknown> = createCollectionOutput();
  let boundary!: SourceBoundaryRecord;
  let pendingReset = false;
  let pendingCause: unknown;
  let contextCause: unknown;
  let recovering = false;
  let fullScan = false;
  let orderMayChange = false;
  const candidates = new Set<string>();
  let cleanup: Unsubscribe | undefined;

  const check = () => {
    if (!scheduler.active || boundary.disposed) throw new ProjectionDisposedError();
    if (boundary.fault) throw boundary.fault;
  };

  const output: OutputRecord = {
    kind: 'collection',
    get owner() {
      return boundary;
    },
    consumers: new Set(),
    context: active => state.context(active, contextCause),
    current: () => state.current(check),
    revision: state.revision,
    reset: state.reset,
    subscribe: listener => {
      check();
      const wrapped = (change: CollectionChange<string, unknown>) => listener(change);
      state.subscribe(wrapped);
      return () => state.unsubscribe(wrapped);
    },
    emit: state.emit,
    clear: state.clear,
    release: state.release,
  };

  boundary = {
    kind: 'source',
    name,
    outputs: Object.freeze([output]) as readonly [OutputRecord],
    fault: undefined,
    disposed: false,
    pendingCause: () => pendingCause,
    recovering: () => recovering,
    prepare: cause => {
      contextCause = cause;
      let active = true;
      try {
        const changed = stageCollectionRead(
          state,
          readLatest(
            () => active,
            state.current(() => undefined)
          ),
          () => active,
          {
            reset: pendingReset,
            ...(fullScan ? {} : { candidates }),
            orderMayChange,
            isEqual: equality,
          }
        );
        recovering = false;
        return { changed, force: pendingReset };
      } finally {
        active = false;
      }
    },
    publish: state.publish,
    clear: () => {
      const failed = boundary.fault !== undefined;
      state.clear();
      pendingReset = false;
      pendingCause = undefined;
      contextCause = undefined;
      recovering = false;
      fullScan = false;
      orderMayChange = false;
      candidates.clear();
      clearSource(failed);
    },
    release: () => {
      cleanup?.();
      cleanup = undefined;
      state.release();
      output.consumers.clear();
    },
  };

  scheduler.initialize(() => {
    let active = true;
    try {
      stageCollectionRead(
        state,
        readLatest(
          () => active,
          state.current(() => undefined)
        ),
        () => active,
        {
          reset: true,
          isEqual: equality,
        }
      );
      state.publish();
      state.clear();
    } finally {
      active = false;
    }
  });
  scheduler.addSource(boundary);

  const mark = (metadata: CollectionMark = {}) => {
    scheduler.assertIdle();
    pendingReset ||= metadata.reset ?? false;
    if (metadata.cause !== undefined) pendingCause ??= metadata.cause;
    fullScan ||= metadata.fullScan ?? false;
    orderMayChange ||= metadata.orderMayChange ?? false;
    if (metadata.candidates) for (const key of metadata.candidates) candidates.add(key);
    if (boundary.fault) recovering = true;
    scheduler.capture(boundary);
  };
  const fail = (cause: unknown) => {
    boundary.fault = sourceError(boundary, cause);
    recovering = false;
    scheduler.capture(boundary);
  };
  return {
    producer: boundary,
    output,
    mark,
    fail,
    detach: next => {
      cleanup = next;
    },
  };
};

type DocumentBinding = {
  readonly target: ImpactTarget;
  capture(commit: DocumentCommit<ObjectNode>): void;
  dispose(): void;
};

type DocumentConnection = {
  add(binding: DocumentBinding): Unsubscribe;
  close(): void;
};

type ValueMember = {
  readonly boundary: ValueBoundary;
  receive(value: unknown, metadata?: SourceMark): void;
};

const documentRootTarget: ImpactTarget = Object.freeze({
  kind: 'value' as const,
  at: Object.freeze([]),
});

type DocumentCollectionPending = {
  reset: boolean;
  order: boolean;
  readonly entries: Map<string, DocumentDirty>;
};

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

export const createSourceRegistry = (scheduler: Scheduler) => {
  const documents = new Map<object, DocumentConnection>();
  const readables = new Map<object, { members: Set<ValueMember>; close(): void }>();
  const externalValues = new WeakMap<object, { members: Set<ValueMember>; close(): void }>();
  const externalCollections = new WeakMap<
    object,
    { members: Set<CollectionBoundary>; close(): void }
  >();

  const documentConnection = <S extends ObjectNode>(
    runtime: DocumentReadable<S>
  ): DocumentConnection => {
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
    const connection: DocumentConnection = {
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
          if (!bindings.size) connection.close();
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
    documents.set(state, connection);
    return connection;
  };

  const valueInput = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'value-input') throw new Error('Invalid value input source.');
    const source = definition.source;
    let latest = source.initial;
    const boundary = createValueBoundary(
      scheduler,
      'projection input',
      source.initial,
      source.equality,
      () => latest,
      () => undefined
    );
    return {
      ...boundary,
      write: {
        kind: 'value',
        set(value) {
          scheduler.assertIdle();
          latest = value;
          boundary.mark();
          scheduler.run();
        },
      },
    };
  };

  const collectionInput = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'collection-input')
      throw new Error('Invalid collection input source.');
    const values = new Map(definition.source.initial);
    const boundary = createCollectionBoundary(
      scheduler,
      'projection collection input',
      () => mapRead(values),
      definition.output.equality,
      () => undefined
    );
    return {
      ...boundary,
      write: {
        kind: 'collection',
        update(run) {
          scheduler.assertIdle();
          const staged = new Map<
            string,
            { readonly present: true; readonly value: unknown } | { readonly present: false }
          >();
          const operations: (
            | { readonly kind: 'set'; readonly key: string; readonly value: unknown }
            | { readonly kind: 'remove'; readonly key: string }
          )[] = [];
          let active = true;
          const draft: KeyedInputDraft<string, unknown> = Object.freeze({
            get: key => {
              assertScope(() => active);
              const entry = staged.get(key);
              return entry ? (entry.present ? entry.value : undefined) : values.get(key);
            },
            has: key => {
              assertScope(() => active);
              const entry = staged.get(key);
              return entry ? entry.present : values.has(key);
            },
            set: (key, value) => {
              assertScope(() => active);
              if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
              staged.set(key, { present: true, value });
              operations.push({ kind: 'set', key, value });
            },
            remove: key => {
              assertScope(() => active);
              if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
              staged.set(key, { present: false });
              operations.push({ kind: 'remove', key });
            },
          });
          try {
            assertSynchronous(run(draft));
          } finally {
            active = false;
          }

          const candidates = new Set<string>();
          let structural = false;
          let changed = false;
          for (const operation of operations) {
            const present = values.has(operation.key);
            if (operation.kind === 'set') {
              if (present && Object.is(values.get(operation.key), operation.value)) continue;
              structural ||= !present;
              values.set(operation.key, operation.value);
            } else {
              if (!present) continue;
              structural = true;
              values.delete(operation.key);
            }
            candidates.add(operation.key);
            changed = true;
          }
          if (!changed) return;
          boundary.mark({ candidates, orderMayChange: structural });
          scheduler.run();
        },
      },
    };
  };

  const documentSource = (definition: SourceDefinition): SourceMaterialization => {
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
      const remove = documentConnection(document).add({
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
          return Object.freeze(anchor.toArray(anchor.indexedKeys(value, node.keyOf)));
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
          return anchor.indexedKeys(value, node.keyOf).index(key) >= 0;
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
          const index = anchor.indexedKeys(value, node.keyOf).index(key);
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
    const remove = documentConnection(document).add({
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

  const readable = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'readable') throw new Error('Invalid Readable source.');
    const { readable, equality } = definition.source;
    let latest = readable.current();
    const boundary = createValueBoundary(
      scheduler,
      'external readable',
      latest,
      equality,
      () => latest,
      () => undefined
    );
    const member: ValueMember = {
      boundary,
      receive(value, metadata) {
        latest = value;
        boundary.mark(metadata);
      },
    };
    let connection = readables.get(readable);
    if (!connection) {
      const members = new Set<ValueMember>();
      let closed = false;
      let unsubscribe: Unsubscribe | undefined;
      let detachDocument: Unsubscribe | undefined;
      const receive = (settle: boolean) => {
        if (closed || !scheduler.active) return;
        try {
          const value = readable.current();
          members.forEach(next => next.receive(value));
        } catch (cause) {
          members.forEach(next => next.boundary.fail(cause));
        }
        if (settle) scheduler.run();
      };
      const created = {
        members,
        close() {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          detachDocument?.();
          readables.delete(readable);
        },
      };
      const owner = documentReadableOwner(readable);
      if (owner) {
        detachDocument = documentConnection(owner).add({
          target: documentRootTarget,
          capture: () => receive(false),
          dispose: () => {
            members.forEach(next => next.boundary.fail(new Error('Document has been disposed.')));
          },
        });
      }
      unsubscribe = readable.subscribe(() => receive(true));
      connection = created;
      readables.set(readable, connection);
    }
    connection.members.add(member);
    boundary.detach(() => {
      connection!.members.delete(member);
      if (!connection!.members.size) connection!.close();
    });
    return boundary;
  };

  const externalValue = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'external-value')
      throw new Error('Invalid external value source.');
    const { source, equality } = definition.source;
    let latest = source.current();
    const boundary = createValueBoundary(
      scheduler,
      'external source',
      latest,
      equality,
      () => latest,
      () => undefined
    );
    const member: ValueMember = {
      boundary,
      receive(value, metadata) {
        latest = value;
        boundary.mark(metadata);
      },
    };
    let connection = externalValues.get(source);
    if (!connection) {
      const members = new Set<ValueMember>();
      let closed = false;
      let unsubscribe: Unsubscribe | undefined;
      const created = {
        members,
        close() {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          externalValues.delete(source);
        },
      };
      try {
        unsubscribe = source.subscribe(event => {
          try {
            members.forEach(next =>
              next.receive(event.value, { reset: event.reset, cause: event.cause })
            );
          } catch (cause) {
            members.forEach(next => next.boundary.fail(cause));
          }
          scheduler.run();
        });
      } catch (cause) {
        created.close();
        throw cause;
      }
      connection = created;
      externalValues.set(source, connection);
    }
    connection.members.add(member);
    boundary.detach(() => {
      connection!.members.delete(member);
      if (!connection!.members.size) connection!.close();
    });
    return boundary;
  };

  const externalCollection = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'external-collection')
      throw new Error('Invalid external collection source.');
    const source = definition.source.source as ExternalCollectionSource<string, unknown>;
    const boundary = createCollectionBoundary(
      scheduler,
      'external collection source',
      () => {
        const current = source.current();
        return Object.freeze({
          get: key => current.get(key),
          has: key => current.has(key),
          ids: () => current.ids(),
        });
      },
      definition.output.equality,
      () => undefined
    );
    let connection = externalCollections.get(source);
    if (!connection) {
      const members = new Set<CollectionBoundary>();
      let closed = false;
      let unsubscribe: Unsubscribe | undefined;
      const created = {
        members,
        close() {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          externalCollections.delete(source);
        },
      };
      try {
        unsubscribe = source.subscribe(event => {
          try {
            const impact = event.impact;
            if (impact?.kind === 'reset') {
              members.forEach(next => next.mark({ reset: true, cause: event.cause }));
            } else if (impact?.kind === 'incremental') {
              const candidates = new Set<string>([
                ...impact.added,
                ...impact.updated,
                ...impact.removed,
              ]);
              members.forEach(next =>
                next.mark({
                  candidates,
                  orderMayChange: Boolean(
                    impact.added.size || impact.removed.size || impact.orderChanged
                  ),
                  cause: event.cause,
                })
              );
            } else {
              members.forEach(next =>
                next.mark({ fullScan: true, orderMayChange: true, cause: event.cause })
              );
            }
          } catch (cause) {
            members.forEach(next => next.fail(cause));
          }
          scheduler.run();
        });
      } catch (cause) {
        created.close();
        throw cause;
      }
      connection = created;
      externalCollections.set(source, connection);
    }
    connection.members.add(boundary);
    boundary.detach(() => {
      connection!.members.delete(boundary);
      if (!connection!.members.size) connection!.close();
    });
    return boundary;
  };

  return {
    materialize(definition: SourceDefinition): SourceMaterialization {
      switch (definition.source.kind) {
        case 'value-input':
          return valueInput(definition);
        case 'collection-input':
          return collectionInput(definition);
        case 'document':
          return documentSource(definition);
        case 'readable':
          return readable(definition);
        case 'external-value':
          return externalValue(definition);
        case 'external-collection':
          return externalCollection(definition);
      }
    },
    dispose() {
      documents.forEach(connection => connection.close());
      readables.forEach(connection => connection.close());
      documents.clear();
      readables.clear();
    },
  };
};
