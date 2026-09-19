import { documentReadableOwner } from '../../runtime/notification';
import type { Unsubscribe } from '../../runtime/contract';
import type { ExternalCollectionSource } from '../contract';
import { mapRead } from '../collection/view';
import type { SourceDefinition } from '../definition';
import { createDocumentSourceRegistry } from './document';
import { assertScope, assertSynchronous, type Scheduler } from '../graph/scheduler';
import {
  createCollectionBoundary,
  createValueBoundary,
  type CollectionBoundary,
  type KeyedInputDraft,
  type SourceMark,
  type SourceMaterialization,
  type ValueBoundary,
} from './boundary';

type ValueMember = {
  readonly boundary: ValueBoundary;
  receive(value: unknown, metadata?: SourceMark): void;
};

export const createSourceRegistry = (scheduler: Scheduler) => {
  const documents = createDocumentSourceRegistry(scheduler);
  const readables = new Map<object, { members: Set<ValueMember>; close(): void }>();
  const externalValues = new WeakMap<object, { members: Set<ValueMember>; close(): void }>();
  const externalCollections = new WeakMap<
    object,
    { members: Set<CollectionBoundary>; close(): void }
  >();

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
        detachDocument = documents.attachRoot(owner, {
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
          return documents.materialize(definition);
        case 'readable':
          return readable(definition);
        case 'external-value':
          return externalValue(definition);
        case 'external-collection':
          return externalCollection(definition);
      }
    },
    dispose() {
      documents.dispose();
      readables.forEach(connection => connection.close());
      readables.clear();
    },
  };
};
