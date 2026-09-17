import { read as readAddress, nodeAt } from '../address';
import { collectionAccess, snapshot } from '../access/scope';
import { affectsTarget, collectionImpact } from '../impact';
import { accessOf } from '../runtime/access';
import { attachProjection, documentReadableOwner } from '../runtime/notification';
import type { DocumentCommit, DocumentReadable, Unsubscribe } from '../runtime/contract';
import type { CollectionSelector, ObjectNode, ValueSelector } from '../schema';
import { collectionEntryNode } from '../schema';
import { copyValue, equalValue } from '../schema-value';
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
  readonly setLatest: (value: unknown) => void;
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
  equality: (previous: unknown, next: unknown) => boolean
): ValueBoundary => {
  const state: ValueOutputState<unknown> = createValueOutput();
  let boundary!: SourceBoundaryRecord;
  let latest = initial;
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
        evaluation.output.set(latest);
        const changed = state.seal(pendingReset, equality);
        recovering = false;
        return { changed, force: pendingReset };
      } finally {
        active = false;
      }
    },
    publish: state.publish,
    clear: () => {
      state.clear();
      pendingReset = false;
      pendingCause = undefined;
      contextCause = undefined;
      recovering = false;
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
    setLatest: value => {
      latest = value;
    },
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
  readLatest: (active: () => boolean) => CollectionRead<string, unknown>,
  equality: (previous: unknown, next: unknown) => boolean
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
          readLatest(() => active),
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
      state.clear();
      pendingReset = false;
      pendingCause = undefined;
      contextCause = undefined;
      recovering = false;
      fullScan = false;
      orderMayChange = false;
      candidates.clear();
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
        readLatest(() => active),
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
  matches(commit: DocumentCommit<ObjectNode>): boolean;
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
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          bindings.delete(binding);
          if (!bindings.size) connection.close();
        };
      },
      close() {
        if (closed) return;
        closed = true;
        detach();
        bindings.clear();
        scheduler.guards.delete(guard);
        documents.delete(state);
      },
    };
    detach = attachProjection(runtime, {
      capture: commit => {
        for (const binding of bindings)
          if (binding.matches(commit as DocumentCommit<ObjectNode>))
            binding.capture(commit as DocumentCommit<ObjectNode>);
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
    const boundary = createValueBoundary(
      scheduler,
      'projection input',
      source.initial,
      source.equality
    );
    return {
      ...boundary,
      write: {
        kind: 'value',
        set(value) {
          scheduler.assertIdle();
          boundary.setLatest(value);
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
      definition.output.equality
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

  const documentValue = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'document-value')
      throw new Error('Invalid document value source.');
    const { document, selector } = definition.source;
    const state = accessOf(document);
    const address = selector?.address ?? Object.freeze([]);
    const schemaNode = () => nodeAt(state.schema, address, state.document);
    const read = () => {
      if (state.disposed) throw new Error('Document has been disposed.');
      const node = schemaNode();
      if (!node) return undefined;
      const value = selector ? readAddress(state.document, address, state.schema) : state.document;
      return copyValue(node, value);
    };
    const initial = read();
    const boundary = createValueBoundary(scheduler, 'document source', initial, (left, right) => {
      const node = schemaNode();
      return node ? equalValue(node, left, right) : Object.is(left, right);
    });
    const remove = documentConnection(document).add({
      matches: commit => !selector || affectsTarget(commit.impact, selector),
      capture: commit => {
        try {
          boundary.setLatest(read());
          boundary.mark({ reset: commit.impact.kind === 'reset' });
        } catch (cause) {
          boundary.fail(cause);
        }
      },
      dispose: () => boundary.fail(new Error('Document has been disposed.')),
    });
    boundary.detach(remove);
    return boundary;
  };

  const documentCollection = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'document-collection')
      throw new Error('Invalid document collection source.');
    const { document, selector } = definition.source;
    const state = accessOf(document);
    const read = (active: () => boolean): CollectionRead<string, unknown> => {
      if (state.disposed) throw new Error('Document has been disposed.');
      const raw = collectionAccess({ state, active }, selector.address) as CollectionRead<
        string,
        unknown
      >;
      const snapshots = new Map<string, unknown>();
      return Object.freeze({
        get: (key: string) => {
          assertScope(active);
          if (!snapshots.has(key)) snapshots.set(key, snapshot(raw.get(key)));
          return snapshots.get(key);
        },
        has: (key: string) => {
          assertScope(active);
          return raw.has(key);
        },
        ids: () => {
          assertScope(active);
          return raw.ids();
        },
      });
    };
    const collectionNode = () => nodeAt(state.schema, selector.address, state.document);
    const boundary = createCollectionBoundary(
      scheduler,
      'document collection source',
      read,
      (left, right) => {
        const node = collectionNode();
        const entry = node && collectionEntryNode(node);
        return entry ? equalValue(entry, left, right) : Object.is(left, right);
      }
    );
    const remove = documentConnection(document).add({
      matches: commit => affectsTarget(commit.impact, selector),
      capture: commit => {
        const impact = collectionImpact(commit.impact, selector);
        if (impact.kind === 'reset') {
          boundary.mark({ reset: true });
          return;
        }
        const candidates = new Set<string>([...impact.added, ...impact.updated, ...impact.removed]);
        boundary.mark({
          candidates,
          orderMayChange: Boolean(impact.added.size || impact.removed.size || impact.orderChanged),
        });
      },
      dispose: () => boundary.fail(new Error('Document has been disposed.')),
    });
    boundary.detach(remove);
    return boundary;
  };

  const readable = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'readable') throw new Error('Invalid Readable source.');
    const { readable, equality } = definition.source;
    let initial = readable.current();
    const boundary = createValueBoundary(scheduler, 'external readable', initial, equality);
    const member: ValueMember = {
      boundary,
      receive(value, metadata) {
        initial = value;
        boundary.setLatest(value);
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
          matches: () => true,
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
    void initial;
    return boundary;
  };

  const externalValue = (definition: SourceDefinition): SourceMaterialization => {
    if (definition.source.kind !== 'external-value')
      throw new Error('Invalid external value source.');
    const { source, equality } = definition.source;
    const boundary = createValueBoundary(scheduler, 'external source', source.current(), equality);
    const member: ValueMember = {
      boundary,
      receive(value, metadata) {
        boundary.setLatest(value);
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
      definition.output.equality
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
        case 'document-value':
          return documentValue(definition);
        case 'document-collection':
          return documentCollection(definition);
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
