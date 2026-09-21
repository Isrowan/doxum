import type { Readable } from '@/readable';
import { contextOf } from '@/runtime/context';
import type { Unsubscribe } from '@/runtime/contract';
import type { ExternalCollectionSource } from '@/projection/contract';
import type { SourceDefinition } from '@/projection/definition';
import type { Scheduler } from '@/projection/graph/scheduler';
import {
  createCollectionBoundary,
  createValueBoundary,
  type CollectionBoundary,
  type SourceMark,
  type SourceMaterialization,
  type ValueBoundary,
} from './boundary';
import type { createDocumentSourceRegistry } from './document';

type ValueMember = {
  readonly boundary: ValueBoundary;
  receive(value: unknown, metadata?: SourceMark): void;
};

type DocumentSources = ReturnType<typeof createDocumentSourceRegistry>;

export const createExternalSourceRegistry = (scheduler: Scheduler, documents: DocumentSources) => {
  const readables = new Map<Readable<unknown>, { members: Set<ValueMember>; close(): void }>();
  const externalValues = new Map<object, { members: Set<ValueMember>; close(): void }>();
  const externalCollections = new Map<
    object,
    { members: Set<CollectionBoundary>; close(): void }
  >();

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
          const stopReadable = unsubscribe;
          unsubscribe = undefined;
          const stopDocument = detachDocument;
          detachDocument = undefined;
          readables.delete(readable);
          members.clear();
          const failures: unknown[] = [];
          try {
            stopReadable?.();
          } catch (error) {
            failures.push(error);
          }
          try {
            stopDocument?.();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length) throw failures[0];
        },
      };
      try {
        const owner = contextOf(readable, false)?.owner;
        if (owner) {
          detachDocument = documents.attachRoot(owner, {
            capture: () => receive(false),
            dispose: () => {
              members.forEach(next => next.boundary.fail(new Error('Document has been disposed.')));
            },
          });
        }
        unsubscribe = readable.subscribe(() => receive(true));
      } catch (error) {
        try {
          created.close();
        } catch {
          /* Connection initialization failure retains priority. */
        }
        try {
          scheduler.releaseProducer(boundary.producer);
        } catch {
          /* Connection initialization failure retains priority. */
        }
        throw error;
      }
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
          const stop = unsubscribe;
          unsubscribe = undefined;
          externalValues.delete(source);
          members.clear();
          stop?.();
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
      } catch (error) {
        try {
          created.close();
        } catch {
          /* Connection initialization failure retains priority. */
        }
        try {
          scheduler.releaseProducer(boundary.producer);
        } catch {
          /* Connection initialization failure retains priority. */
        }
        throw error;
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
          const stop = unsubscribe;
          unsubscribe = undefined;
          externalCollections.delete(source);
          members.clear();
          stop?.();
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
      } catch (error) {
        try {
          created.close();
        } catch {
          /* Connection initialization failure retains priority. */
        }
        try {
          scheduler.releaseProducer(boundary.producer);
        } catch {
          /* Connection initialization failure retains priority. */
        }
        throw error;
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
        case 'readable':
          return readable(definition);
        case 'external-value':
          return externalValue(definition);
        case 'external-collection':
          return externalCollection(definition);
        default:
          throw new Error('Invalid external projection source.');
      }
    },
    dispose() {
      const failures: unknown[] = [];
      const connections = new Set([
        ...readables.values(),
        ...externalValues.values(),
        ...externalCollections.values(),
      ]);
      for (const connection of connections) {
        try {
          connection.close();
        } catch (error) {
          failures.push(error);
        }
      }
      readables.clear();
      externalValues.clear();
      externalCollections.clear();
      if (failures.length) throw failures[0];
    },
  };
};
