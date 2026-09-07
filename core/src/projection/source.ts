import { documentReader, readerFor } from '../access/reader';
import { nodeAt } from '../address';
import * as target from '../impact-target';
import { accessOf } from '../runtime/access';
import { attachProjection } from '../runtime/notification';
import type { DocumentCommit, DocumentReadable } from '../runtime/contract';
import type { DocumentSchema, ImpactTarget, CollectionSelector } from '../schema';
import type { DocumentSource, ProjectionSource, ValueInput } from './contract';
import { ProjectionError } from './contract';
import type { Readable } from './readable';
import { assertScope, projectionHandles, type Scheduler, type SourceRecord } from './scheduler';

export const createSources = (scheduler: Scheduler) => {
  const documents = new Map<object, object>();
  const readables = new Map<object, object>();
  const collections = new WeakMap<object, { source: object; target: CollectionSelector }>();
  const document = <S extends DocumentSchema>(runtime: DocumentReadable<S>): DocumentSource<S> => {
    scheduler.assertIdle();
    const state = accessOf(runtime);
    if (state.disposed) throw new Error('Document has been disposed.');
    const existing = documents.get(state);
    if (existing) return existing as DocumentSource<S>;
    const bindings: { handle: object; targets: readonly ImpactTarget[]; record: SourceRecord }[] =
      [];
    const make = (targets: readonly ImpactTarget[], collection?: CollectionSelector): object => {
      if (state.disposed) throw new Error('Document has been disposed.');
      targets.forEach(value => {
        if (!target.belongs(value, state.schema))
          throw new Error('Projection target belongs to another schema.');
      });
      const old = bindings.find(
        entry =>
          Boolean(collection) === collections.has(entry.handle) &&
          entry.targets.length === targets.length &&
          entry.targets.every((value, i) => target.same(value, targets[i]))
      );
      if (old) return old.handle;
      let commits: DocumentCommit<S>[] = [];
      const record: SourceRecord = {
        consumers: new Set(),
        disposed: false,
        fault: undefined,
        revision: runtime.revision,
        reset: () => commits.some(commit => commit.kind === 'replace'),
        clear: () => {
          commits = [];
        },
        context: active => {
          assertScope(active);
          if (state.disposed) throw new Error('Document has been disposed.');
          const read = collection
            ? readerFor(
                nodeAt(state.schema, collection.address)!,
                { root: () => state.document, active },
                collection.address
              )
            : documentReader(state.schema, () => state.document, active);
          return Object.freeze({
            read,
            target: collection,
            revision: runtime.revision(),
            commits: Object.freeze(commits.slice()),
            reset: record.reset(),
          });
        },
      };
      const handle = collection
        ? {}
        : {
            collection: (pick: Parameters<S['collection']>[0]) => {
              scheduler.assertIdle();
              const selector = state.schema.collection(pick);
              const node = nodeAt(state.schema, selector.address);
              if (node?.kind !== 'table' && node?.kind !== 'map')
                throw new TypeError('Expected a table or map collection path.');
              return make([selector], selector);
            },
            targets: (...selected: ImpactTarget[]) => {
              scheduler.assertIdle();
              if (!selected.length) throw new TypeError('Expected at least one target.');
              return make(selected);
            },
          };
      Object.freeze(handle);
      bindings.push({ handle, targets, record });
      if (collection) collections.set(handle, { source: handle, target: collection });
      scheduler.register(handle, record);
      // The attachment delivers to all local bindings without extra document subscriptions.
      receivers.set(record, commit => {
        commits.push(commit);
      });
      return handle;
    };
    const receivers = new Map<SourceRecord, (commit: DocumentCommit<S>) => void>();
    const handle = make([]) as DocumentSource<S>;
    const guard = (locked: boolean) => {
      state.projectionLocks = (state.projectionLocks ?? 0) + (locked ? 1 : -1);
    };
    scheduler.guards.add(guard);
    const unsubscribe = attachProjection(runtime, {
      capture: commit => {
        for (const binding of bindings) {
          if (!binding.targets.length || binding.targets.some(commit.impact.affects)) {
            receivers.get(binding.record)!(commit);
            scheduler.capture(binding.record);
          }
        }
      },
      settle: scheduler.settle,
      flush: scheduler.flush,
      dispose: () => {
        bindings.forEach(({ record }) => {
          record.fault = new ProjectionError(
            'source',
            'document disposed',
            [runtime.revision()],
            new Error('Document has been disposed.')
          );
          scheduler.capture(record);
        });
        scheduler.run();
      },
    });
    scheduler.cleanups.add(() => {
      unsubscribe();
      scheduler.guards.delete(guard);
    });
    documents.set(state, handle);
    return handle;
  };
  const valueSource = <T>(initial: T, equal: (a: T, b: T) => boolean) => {
    let value = initial;
    let previous = initial;
    let revision = 0;
    const handle = Object.freeze({}) as ProjectionSource<ValueInput<T>>;
    const record: SourceRecord = {
      consumers: new Set(),
      disposed: false,
      fault: undefined,
      revision: () => revision,
      reset: () => false,
      clear: () => {
        previous = value;
      },
      context: active => {
        assertScope(active);
        return Object.freeze({
          value,
          previous,
          revision,
          changed: !equal(previous, value),
          reset: false,
        });
      },
    };
    scheduler.register(handle, record);
    const accept = (next: T) => {
      scheduler.assertIdle();
      const recovering = record.fault !== undefined;
      if (equal(value, next) && !recovering) return;
      record.fault = undefined;
      value = next;
      revision++;
      scheduler.capture(record);
    };
    return {
      source: handle,
      accept,
      set(next: T) {
        accept(next);
        scheduler.run();
      },
    };
  };
  return {
    dispose: () => {
      documents.clear();
      readables.clear();
    },
    document,
    input: <T>(initial: T, options?: { readonly isEqual?: (a: T, b: T) => boolean }) => {
      const { source, set } = valueSource(initial, options?.isEqual ?? Object.is);
      return Object.freeze({ source, set });
    },
    fromReadable: <T>(
      readable: Readable<T>,
      options?: { readonly isEqual?: (a: T, b: T) => boolean }
    ): ProjectionSource<ValueInput<T>> => {
      scheduler.assertIdle();
      if (projectionHandles.has(readable))
        throw new Error('Projection nodes must be declared directly as sources.');
      const old = readables.get(readable);
      if (old) return old as ProjectionSource<ValueInput<T>>;
      const input = valueSource(readable.current(), options?.isEqual ?? Object.is);
      const receive = () => {
        if (!scheduler.active) return;
        try {
          input.accept(readable.current());
        } catch (cause) {
          const record = scheduler.source(input.source);
          record.fault = new ProjectionError(
            'source',
            'external readable',
            [readable.revision()],
            cause
          );
          scheduler.capture(record);
        }
        scheduler.run();
      };
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = readable.subscribe(receive);
        input.accept(readable.current());
      } catch (error) {
        try {
          unsubscribe?.();
        } finally {
          scheduler.unregisterSource(input.source);
        }
        throw error;
      }
      scheduler.cleanups.add(unsubscribe);
      readables.set(readable, input.source);
      scheduler.run();
      return input.source;
    },
    collectionTarget: (handle: object) => {
      scheduler.source(handle);
      const value = collections.get(handle);
      if (!value) throw new Error('map requires a document collection source.');
      return value.target;
    },
  };
};
