import { createAccess, collectionAccess } from '../access/scope';
import { affectsTarget, collectionImpact } from '../impact';
import type { CollectionImpact } from '../impact';
import * as target from '../impact-target';
import { accessOf } from '../runtime/access';
import { attachProjection, documentReadableOwner } from '../runtime/notification';
import type { DocumentCommit, DocumentReadable } from '../runtime/contract';
import type { ObjectNode, ImpactTarget, CollectionSelector, PathPick } from '../schema';
import { compilePath } from '../schema';
import type {
  CollectionContext,
  CollectionRead,
  DocumentHandle,
  GraphSource,
  ExternalCollectionSource,
  ExternalValueSource,
  ValueContext,
} from './contract';
import { ProjectionError } from './contract';
import { collectionHandles } from './collection';
import type { Readable } from './readable';
import { assertScope, projectionHandles, type Scheduler, type SourceRecord } from './scheduler';

export const createSources = (scheduler: Scheduler) => {
  const documents = new Map<object, object>();
  const readables = new Map<
    object,
    Map<
      object,
      {
        readonly source: object;
        readonly accept: (value: unknown) => void;
      }
    >
  >();
  const collections = new WeakSet<object>();
  const externalSources = new WeakMap<object, object>();
  const document = <S extends ObjectNode>(runtime: DocumentReadable<S>): DocumentHandle<S> => {
    scheduler.assertIdle();
    const state = accessOf(runtime);
    if (state.disposed) throw new Error('Document has been disposed.');
    const existing = documents.get(state);
    if (existing) return existing as DocumentHandle<S>;
    const bindings: {
      handle: object;
      targets: readonly ImpactTarget[];
      record: SourceRecord;
      receive: (commit: DocumentCommit<S>) => void;
    }[] = [];
    let batch: import('./contract').BatchContext | undefined;
    const make = (
      input:
        { readonly targets: readonly ImpactTarget[] } | { readonly collection: CollectionSelector }
    ): object => {
      const collection = 'collection' in input ? input.collection : undefined;
      const targets = 'targets' in input ? input.targets : [input.collection];
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
      let reset = false;
      let orderDirty = false;
      const keys = new Set<string>();
      let candidates:
        { readonly keys: readonly string[]; readonly orderDirty: boolean } | undefined;
      const record: SourceRecord = {
        consumers: new Set(),
        disposed: false,
        fault: undefined,
        revision: runtime.revision,
        reset: () => reset,
        clear: () => {
          commits = [];
          reset = orderDirty = false;
          batch = undefined;
          keys.clear();
          candidates = undefined;
        },
        context: active => {
          assertScope(active);
          if (state.disposed) throw new Error('Document has been disposed.');
          const context = { state, active };
          const read = collection
            ? collectionAccess(context, collection.address)
            : createAccess(context);
          return Object.freeze({
            read,
            revision: runtime.revision(),
            commits: Object.freeze(commits.slice()),
            reset: record.reset(),
            batch,
            cause: batch?.cause,
            ...(collection
              ? {
                  candidates: (candidates ??= Object.freeze({
                    keys: Object.freeze([...keys]),
                    orderDirty,
                  })),
                }
              : {}),
          });
        },
      };
      const handle = collection
        ? {}
        : {
            collection: (pick: PathPick<S>) => {
              scheduler.assertIdle();
              const selector = compilePath<S['shape']>(
                state.schema,
                'collection',
                pick
              ) as CollectionSelector;
              return make({ collection: selector });
            },
            targets: (...selected: PathPick<S>[]) => {
              scheduler.assertIdle();
              if (!selected.length) throw new TypeError('Expected at least one target.');
              return make({
                targets: selected.map(pick => compilePath<S['shape']>(state.schema, 'value', pick)),
              });
            },
          };
      Object.freeze(handle);
      if (collection) collections.add(handle);
      scheduler.register(handle, record);
      // The attachment delivers to all local bindings without extra document subscriptions.
      const receive = (commit: DocumentCommit<S>) => {
        commits.push(commit);
        reset ||= commit.impact.kind === 'reset';
        if (collection) {
          const change = collectionImpact(commit.impact, collection);
          if (change.kind === 'reset') reset = true;
          else {
            change.added.forEach(key => keys.add(key));
            change.removed.forEach(key => keys.add(key));
            change.updated.forEach(key => keys.add(key));
            orderDirty ||= Boolean(change.added.size || change.removed.size || change.orderChanged);
          }
          candidates = undefined;
        }
      };
      bindings.push({ handle, targets, record, receive });
      return handle;
    };
    const handle = make({ targets: [] }) as DocumentHandle<S>;
    const guard = (locked: boolean) => {
      state.projectionLocks = (state.projectionLocks ?? 0) + (locked ? 1 : -1);
    };
    scheduler.guards.add(guard);
    const unsubscribe = attachProjection(runtime, {
      capture: commit => {
        for (const binding of bindings) {
          if (
            !binding.targets.length ||
            binding.targets.some(value => affectsTarget(commit.impact, value))
          ) {
            binding.receive(commit);
            batch = scheduler.batchContext();
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
  const valueSource = <T, D = unknown>(initial: T, equal: (a: T, b: T) => boolean) => {
    let value = initial;
    let previous = initial;
    let revision = 0;
    let detail: D | undefined;
    let cause: import('./contract').Cause | undefined;
    let batch: import('./contract').BatchContext | undefined;
    let reset = false;
    let pending = false;
    const handle = Object.freeze({}) as GraphSource<ValueContext<T, D>>;
    const record: SourceRecord = {
      consumers: new Set(),
      disposed: false,
      fault: undefined,
      revision: () => revision,
      reset: () => reset,
      clear: () => {
        previous = value;
        pending = false;
        detail = undefined;
        cause = undefined;
        batch = undefined;
        reset = false;
      },
      context: active => {
        assertScope(active);
        return Object.freeze({
          value,
          previous,
          revision,
          changed: !equal(previous, value),
          reset,
          detail,
          cause,
          batch,
        });
      },
    };
    scheduler.register(handle, record);
    const accept = (next: T, metadata?: Partial<ValueContext<T, D>>) => {
      scheduler.assertIdle();
      const recovering = record.fault !== undefined;
      const eventful =
        metadata !== undefined &&
        (metadata.reset === true ||
          (metadata.revision !== undefined && metadata.revision !== revision) ||
          metadata.detail !== undefined ||
          metadata.cause !== undefined ||
          metadata.batch !== undefined);
      if (equal(value, next) && !recovering && !eventful) return;
      record.fault = undefined;
      if (!pending) previous = value;
      value = next;
      revision = metadata?.revision ?? revision + 1;
      detail = metadata?.detail;
      cause = metadata?.cause ?? cause;
      batch = scheduler.batchContext() ?? metadata?.batch ?? batch;
      reset ||= metadata?.reset ?? false;
      scheduler.capture(record);
      pending = true;
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
  const externalValueSource = <T, D>(
    port: ExternalValueSource<T, D>,
    equal: (a: T, b: T) => boolean
  ): GraphSource<ValueContext<T, D>> => {
    scheduler.assertIdle();
    const old = externalSources.get(port);
    if (old) return old as GraphSource<ValueContext<T, D>>;
    const input = valueSource<T, D>(port.current(), equal);
    const fail = (cause: unknown) => {
      const record = scheduler.source(input.source);
      record.fault = new ProjectionError('source', 'external source', [record.revision()], cause);
      scheduler.capture(record);
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = port.subscribe(event => {
        try {
          input.accept(event.value, {
            revision: event.revision,
            reset: event.reset,
            detail: event.detail,
            cause: event.cause,
            batch: event.batch,
          });
        } catch (cause) {
          fail(cause);
        }
        scheduler.run();
      });
    } catch (cause) {
      unsubscribe?.();
      scheduler.unregisterSource(input.source);
      throw cause;
    }
    scheduler.cleanups.add(() => unsubscribe?.());
    externalSources.set(port, input.source);
    return input.source;
  };
  const externalCollectionSource = <K extends string, V, D>(
    port: ExternalCollectionSource<K, V, D>
  ): GraphSource<CollectionContext<K, V, D>> => {
    scheduler.assertIdle();
    const old = externalSources.get(port);
    if (old) return old as GraphSource<CollectionContext<K, V, D>>;
    let read = port.current();
    let previous = read;
    let revision = port.revision();
    let change: CollectionContext<K, V, D>['change'];
    let reset = false;
    let detail: D | undefined;
    let cause: import('./contract').Cause | undefined;
    let batch: import('./contract').BatchContext | undefined;
    let publishedTransitions: readonly import('./contract').CollectionEntryTransition<K, V>[] =
      Object.freeze([]);
    let transitionKeys = new Set<K>();
    let pending = false;
    const handle = Object.freeze({}) as GraphSource<CollectionContext<K, V, D>>;
    const record: SourceRecord = {
      consumers: new Set(),
      disposed: false,
      fault: undefined,
      revision: () => revision,
      reset: () => reset,
      clear: () => {
        previous = read;
        pending = false;
        change = undefined;
        reset = false;
        detail = undefined;
        cause = undefined;
        batch = undefined;
        publishedTransitions = Object.freeze([]);
        transitionKeys.clear();
      },
      context: active => {
        assertScope(active);
        const currentRead: CollectionRead<K, V> = Object.freeze({
          get: key => {
            assertScope(active);
            return read.get(key);
          },
          has: key => {
            assertScope(active);
            return read.has(key);
          },
          ids: () => {
            assertScope(active);
            return read.ids();
          },
        });
        const previousRead: CollectionRead<K, V> = Object.freeze({
          get: key => {
            assertScope(active);
            return previous.get(key);
          },
          has: key => {
            assertScope(active);
            return previous.has(key);
          },
          ids: () => {
            assertScope(active);
            return previous.ids();
          },
        });
        return Object.freeze({
          ...currentRead,
          previous: previousRead,
          change,
          revision,
          reset,
          transitions: (keys?: Iterable<K>) => {
            assertScope(active);
            const selected = keys ? new Set(keys) : undefined;
            return Object.freeze(
              publishedTransitions.filter(transition => !selected || selected.has(transition.key))
            );
          },
          detail,
          cause,
          batch,
        });
      },
    };
    scheduler.register(handle, record);
    collections.add(handle);
    const fail = (error: unknown) => {
      record.fault = new ProjectionError('source', 'external collection source', [revision], error);
      scheduler.capture(record);
    };
    const addTransitionKeys = (impact: CollectionContext<K, V>['change']) => {
      if (impact?.kind === 'incremental') {
        impact.added.forEach(key => transitionKeys.add(key));
        impact.removed.forEach(key => transitionKeys.add(key));
        impact.updated.forEach(key => transitionKeys.add(key));
      }
    };
    const recomputeTransitions = () => {
      const transitions: import('./contract').CollectionEntryTransition<K, V>[] = [];
      for (const key of transitionKeys) {
        const beforePresent = previous.has(key);
        const afterPresent = read.has(key);
        const before = beforePresent ? previous.get(key) : undefined;
        const after = afterPresent ? read.get(key) : undefined;
        if (beforePresent === afterPresent && Object.is(before, after)) continue;
        if (!beforePresent)
          transitions.push({ key, kind: 'added', before: undefined, after: after as V });
        else if (!afterPresent)
          transitions.push({ key, kind: 'removed', before: before as V, after: undefined });
        else transitions.push({ key, kind: 'updated', before: before as V, after: after as V });
      }
      publishedTransitions = Object.freeze(transitions);
    };
    const deriveChange = (): CollectionImpact<K> | undefined => {
      if (reset) return Object.freeze({ kind: 'reset' as const });
      const added = new Set<K>();
      const removed = new Set<K>();
      const updated = new Set<K>();
      publishedTransitions.forEach(transition => {
        if (transition.kind === 'added') added.add(transition.key);
        else if (transition.kind === 'removed') removed.add(transition.key);
        else updated.add(transition.key);
      });
      const beforeIds = previous.ids();
      const afterIds = read.ids();
      const beforeCommon = beforeIds.filter(key => read.has(key));
      const afterCommon = afterIds.filter(key => previous.has(key));
      const orderChanged =
        beforeCommon.length !== afterCommon.length ||
        beforeCommon.some((key, index) => afterCommon[index] !== key);
      if (!added.size && !removed.size && !updated.size && !orderChanged) return undefined;
      return Object.freeze({
        kind: 'incremental' as const,
        added,
        removed,
        updated,
        orderChanged,
      });
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = port.subscribe(event => {
        try {
          scheduler.assertIdle();
          if (!pending) previous = event.previous;
          read = port.current();
          revision = event.revision;
          addTransitionKeys(event.change);
          reset ||= event.reset || event.change?.kind === 'reset';
          detail = event.detail;
          cause = event.cause ?? cause;
          batch = scheduler.batchContext() ?? event.batch;
          recomputeTransitions();
          change = deriveChange();
          record.fault = undefined;
          scheduler.capture(record);
          pending = true;
        } catch (error) {
          fail(error);
        }
        scheduler.run();
      });
    } catch (error) {
      unsubscribe?.();
      scheduler.unregisterSource(handle);
      throw error;
    }
    scheduler.cleanups.add(() => unsubscribe?.());
    externalSources.set(port, handle);
    return handle;
  };
  return {
    dispose: () => {
      documents.clear();
      readables.clear();
    },
    document,
    fromSource: <T, D>(
      source: ExternalValueSource<T, D>,
      options?: { readonly isEqual?: (a: T, b: T) => boolean }
    ) => externalValueSource(source, options?.isEqual ?? Object.is),
    fromCollectionSource: <K extends string, V, D>(source: ExternalCollectionSource<K, V, D>) =>
      externalCollectionSource(source),
    input: <T>(initial: T, options?: { readonly isEqual?: (a: T, b: T) => boolean }) => {
      const { source, set } = valueSource(initial, options?.isEqual ?? Object.is);
      return Object.freeze({ source, set });
    },
    fromReadable: <T>(
      readable: Readable<T>,
      options?: { readonly isEqual?: (a: T, b: T) => boolean }
    ): GraphSource<ValueContext<T>> => {
      scheduler.assertIdle();
      if (projectionHandles.has(readable))
        throw new Error('Projection nodes must be declared directly as sources.');
      const equal = options?.isEqual ?? Object.is;
      let bindings = readables.get(readable);
      const old = bindings?.get(equal);
      if (old) return old.source as GraphSource<ValueContext<T>>;
      const input = valueSource(readable.current(), equal);
      if (bindings) {
        bindings.set(equal, { source: input.source, accept: value => input.accept(value as T) });
        return input.source;
      }
      bindings = new Map([
        [equal, { source: input.source, accept: (value: unknown) => input.accept(value as T) }],
      ]);
      const members = bindings;
      const receive = (settle = true) => {
        if (!scheduler.active) return;
        let value: T;
        try {
          value = readable.current();
        } catch (cause) {
          for (const member of members.values()) {
            const record = scheduler.source(member.source);
            record.fault = new ProjectionError(
              'source',
              'external readable',
              [record.revision()],
              cause
            );
            scheduler.capture(record);
          }
          if (settle) scheduler.run();
          return;
        }
        for (const member of members.values()) {
          try {
            member.accept(value);
          } catch (cause) {
            const record = scheduler.source(member.source);
            record.fault = new ProjectionError(
              'source',
              'external readable',
              [record.revision()],
              cause
            );
            scheduler.capture(record);
          }
        }
        if (settle) scheduler.run();
      };
      let unsubscribe: (() => void) | undefined;
      let detach: (() => void) | undefined;
      try {
        const owner = documentReadableOwner(readable);
        if (owner) {
          document(owner);
          detach = attachProjection(owner, {
            capture: () => receive(false),
            settle: scheduler.settle,
            flush: scheduler.flush,
            dispose: () => {
              for (const member of members.values()) {
                const record = scheduler.source(member.source);
                record.fault = new ProjectionError(
                  'source',
                  'document readable disposed',
                  [record.revision()],
                  new Error('Document has been disposed.')
                );
                scheduler.capture(record);
              }
              scheduler.run();
            },
          });
        }
        unsubscribe = readable.subscribe(() => receive());
        input.accept(readable.current());
      } catch (error) {
        try {
          unsubscribe?.();
          detach?.();
        } finally {
          scheduler.unregisterSource(input.source);
        }
        throw error;
      }
      scheduler.cleanups.add(unsubscribe);
      if (detach) scheduler.cleanups.add(detach);
      readables.set(readable, bindings);
      scheduler.run();
      return input.source;
    },
    assertCollection: (handle: object) => {
      scheduler.source(handle);
      if (!collections.has(handle) && !collectionHandles.has(handle))
        throw new Error('map requires a collection source.');
    },
  };
};
