import { createAccess, collectionAccess, snapshot } from '../access/scope';
import { affectsTarget, collectionImpact } from '../impact';
import * as target from '../impact-target';
import { nodeAt } from '../address';
import { accessOf } from '../runtime/access';
import { attachProjection, documentReadableOwner } from '../runtime/notification';
import type { DocumentCommit, DocumentReadable } from '../runtime/contract';
import type { ObjectNode, ImpactTarget, CollectionSelector, PathPick } from '../schema';
import { collectionEntryNode, compilePath } from '../schema';
import { equalValue } from '../schema-value';
import type {
  CollectionContext,
  CollectionChange,
  CollectionRead,
  DocumentHandle,
  GraphSource,
  ExternalCollectionSource,
  ExternalValueSource,
  ValueContext,
} from './contract';
import { ProjectionError } from './contract';
import type { Readable } from './readable';
import {
  assertScope,
  assertSynchronous,
  projectionHandles,
  type Scheduler,
  type SourceRecord,
} from './scheduler';

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
  const externalSources = new WeakMap<object, object>();
  const isCollectionSource = (value: object): boolean =>
    (value as { readonly kind?: unknown }).kind === 'collection';
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
          Boolean(collection) === isCollectionSource(entry.handle) &&
          entry.targets.length === targets.length &&
          entry.targets.every((value, i) => target.same(value, targets[i]))
      );
      if (old) return old.handle;
      let reset = false;
      let orderChanged = false;
      const keys = new Set<string>();
      let baseline: Map<string, unknown> | undefined;
      let baselineIds: readonly string[] = Object.freeze([]);
      let nextBaseline: Map<string, unknown> | undefined;
      let nextBaselineIds: readonly string[] = Object.freeze([]);
      const collectionNode = collection
        ? nodeAt(state.schema, collection.address, state.document)
        : undefined;
      const entryNode = collectionNode ? collectionEntryNode(collectionNode) : undefined;
      const sameEntry = (left: unknown, right: unknown): boolean =>
        entryNode ? equalValue(entryNode, left, right) : Object.is(left, right);
      const record: SourceRecord = {
        consumers: new Set(),
        disposed: false,
        fault: undefined,
        revision: runtime.revision,
        reset: () => reset,
        clear: () => {
          if (collection && nextBaseline) {
            baseline = nextBaseline;
            baselineIds = nextBaselineIds;
          }
          reset = false;
          orderChanged = false;
          batch = undefined;
          keys.clear();
          nextBaseline = undefined;
          nextBaselineIds = Object.freeze([]);
        },
        context: active => {
          assertScope(active);
          if (state.disposed) throw new Error('Document has been disposed.');
          const context = { state, active };
          const rawRead = collection
            ? (collectionAccess(context, collection.address) as CollectionRead<string, unknown>)
            : undefined;
          const snapshots = collection ? new Map<string, unknown>() : undefined;
          const read = collection
            ? Object.freeze({
                get: (key: string) => {
                  assertScope(active);
                  if (!snapshots!.has(key)) snapshots!.set(key, snapshot(rawRead!.get(key)));
                  return snapshots!.get(key);
                },
                has: (key: string) => {
                  assertScope(active);
                  return rawRead!.has(key);
                },
                ids: () => {
                  assertScope(active);
                  return rawRead!.ids();
                },
              })
            : createAccess(context);
          if (!collection)
            return Object.freeze({
              kind: 'document' as const,
              read,
              revision: runtime.revision(),
              reset: record.reset(),
              cause: batch?.cause,
            });

          if (!baseline) {
            const collectionRead = read as CollectionRead<string, unknown>;
            baseline = new Map<string, unknown>();
            baselineIds = Object.freeze(
              collectionAccess(context, collection.address).ids().slice()
            );
            for (const key of baselineIds) {
              const value = collectionRead.get(key);
              baseline.set(key, value);
            }
          }
          const changed = [...keys];
          const added: { readonly key: string; readonly after: unknown }[] = [];
          const updated: {
            readonly key: string;
            readonly before: unknown;
            readonly after: unknown;
          }[] = [];
          const removed: {
            readonly key: string;
            readonly before: unknown;
          }[] = [];
          const next = new Map(baseline);
          const collectionRead = read as CollectionRead<string, unknown>;
          for (const key of changed) {
            const beforePresent = baseline.has(key);
            const afterPresent = collectionRead.has(key);
            const afterValue = afterPresent ? collectionRead.get(key) : undefined;
            if (!beforePresent && afterPresent) {
              added.push({ key, after: afterValue });
              next.set(key, afterValue);
            } else if (beforePresent && !afterPresent) {
              removed.push({ key, before: baseline.get(key) });
              next.delete(key);
            } else if (beforePresent && afterPresent) {
              const beforeValue = baseline.get(key);
              if (!sameEntry(beforeValue, afterValue))
                updated.push({ key, before: beforeValue, after: afterValue });
              next.set(key, afterValue);
            }
          }
          const ids =
            record.reset() || orderChanged ? Object.freeze([...collectionRead.ids()]) : baselineIds;
          if (record.reset()) {
            next.clear();
            for (const key of ids) {
              const value = collectionRead.get(key);
              next.set(key, value);
            }
          }
          let order:
            { readonly before: readonly string[]; readonly after: readonly string[] } | undefined;
          if (orderChanged) {
            const beforeKeys = new Set(baselineIds);
            const afterKeys = new Set(ids);
            const beforeCommon = baselineIds.filter(key => afterKeys.has(key));
            const afterCommon = ids.filter(key => beforeKeys.has(key));
            if (beforeCommon.some((key, index) => afterCommon[index] !== key))
              order = { before: Object.freeze([...baselineIds]), after: ids };
          }
          const change = record.reset()
            ? Object.freeze({ kind: 'reset' as const })
            : added.length || updated.length || removed.length || order
              ? Object.freeze({
                  kind: 'incremental' as const,
                  added: Object.freeze(added),
                  updated: Object.freeze(updated),
                  removed: Object.freeze(removed),
                  ...(order ? { order: Object.freeze(order) } : {}),
                })
              : undefined;
          nextBaseline = next;
          nextBaselineIds = ids;
          return Object.freeze({
            kind: 'collection' as const,
            read,
            change,
            revision: runtime.revision(),
            cause: batch?.cause,
          });
        },
      };
      const handle = collection
        ? { kind: 'collection' as const }
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
      scheduler.register(handle, record);
      // The attachment delivers to all local bindings without extra document subscriptions.
      const receive = (commit: DocumentCommit<S>) => {
        reset ||= commit.impact.kind === 'reset';
        if (collection) {
          const change = collectionImpact(commit.impact, collection);
          if (change.kind === 'reset') reset = true;
          else {
            change.added.forEach(key => keys.add(key));
            change.removed.forEach(key => keys.add(key));
            change.updated.forEach(key => keys.add(key));
            orderChanged ||= Boolean(
              change.added.size || change.removed.size || change.orderChanged
            );
          }
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
  const valueSource = <T>(initial: T, equal: (a: T, b: T) => boolean) => {
    let value = initial;
    let revision = 0;
    let cause: unknown;
    let reset = false;
    const handle = Object.freeze({}) as GraphSource<ValueContext<T>>;
    const record: SourceRecord = {
      consumers: new Set(),
      disposed: false,
      fault: undefined,
      revision: () => revision,
      reset: () => reset,
      clear: () => {
        cause = undefined;
        reset = false;
      },
      context: active => {
        assertScope(active);
        return Object.freeze({
          kind: 'value' as const,
          value,
          revision,
          reset,
          cause,
        });
      },
    };
    scheduler.register(handle, record);
    const accept = (next: T, metadata?: Pick<ValueContext<T>, 'revision' | 'reset' | 'cause'>) => {
      scheduler.assertIdle();
      const recovering = record.fault !== undefined;
      const eventful =
        metadata !== undefined &&
        (metadata.reset === true ||
          (metadata.revision !== undefined && metadata.revision !== revision) ||
          metadata.cause !== undefined);
      if (equal(value, next) && !recovering && !eventful) return;
      record.fault = undefined;
      value = next;
      revision = metadata?.revision ?? revision + 1;
      cause = metadata?.cause ?? scheduler.batchContext()?.cause ?? cause;
      reset ||= metadata?.reset ?? false;
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
  const collectionInput = <K extends string, V>(initial: ReadonlyMap<K, V>) => {
    const values = new Map(initial);
    const touched = new Map<K, { readonly present: boolean; readonly value?: V }>();
    let beforeIds: readonly K[] | undefined;
    let revision = 0;
    let cause: unknown;
    const handle = Object.freeze({ kind: 'collection' as const }) as unknown as GraphSource<
      CollectionContext<K, V>
    >;
    const change = (): CollectionChange<K, V> | undefined => {
      const added: { readonly key: K; readonly after: V }[] = [];
      const updated: { readonly key: K; readonly before: V; readonly after: V }[] = [];
      const removed: { readonly key: K; readonly before: V }[] = [];
      for (const [key, before] of touched) {
        const afterPresent = values.has(key);
        if (!before.present && afterPresent) added.push({ key, after: values.get(key) as V });
        else if (before.present && !afterPresent) removed.push({ key, before: before.value as V });
        else if (before.present && afterPresent && !Object.is(before.value, values.get(key)))
          updated.push({ key, before: before.value as V, after: values.get(key) as V });
      }
      let order: { readonly before: readonly K[]; readonly after: readonly K[] } | undefined;
      if (beforeIds) {
        const afterIds = [...values.keys()];
        const beforeKeys = new Set(beforeIds);
        const afterKeys = new Set(afterIds);
        const beforeCommon = beforeIds.filter(key => afterKeys.has(key));
        const afterCommon = afterIds.filter(key => beforeKeys.has(key));
        if (beforeCommon.some((key, index) => key !== afterCommon[index]))
          order = Object.freeze({
            before: beforeIds,
            after: Object.freeze(afterIds),
          });
      }
      if (!added.length && !updated.length && !removed.length && !order) return undefined;
      return Object.freeze({
        kind: 'incremental' as const,
        added: Object.freeze(added),
        updated: Object.freeze(updated),
        removed: Object.freeze(removed),
        ...(order ? { order } : {}),
      });
    };
    const record: SourceRecord = {
      consumers: new Set(),
      disposed: false,
      fault: undefined,
      revision: () => revision,
      reset: () => false,
      shouldSettle: () => change() !== undefined,
      clear: () => {
        touched.clear();
        beforeIds = undefined;
        cause = undefined;
      },
      context: active => {
        assertScope(active);
        const read: CollectionRead<K, V> = Object.freeze({
          get: (key: K) => {
            assertScope(active);
            return values.get(key);
          },
          has: (key: K) => {
            assertScope(active);
            return values.has(key);
          },
          ids: () => {
            assertScope(active);
            return Object.freeze([...values.keys()]);
          },
        });
        return Object.freeze({
          kind: 'collection' as const,
          read,
          change: change(),
          revision,
          cause,
        });
      },
    };
    scheduler.register(handle, record);
    return {
      source: handle,
      update(
        run: (draft: {
          get(key: K): V | undefined;
          has(key: K): boolean;
          set(key: K, value: V): void;
          remove(key: K): void;
        }) => void
      ) {
        scheduler.assertIdle();
        const staged = new Map<
          K,
          { readonly present: true; readonly value: V } | { readonly present: false }
        >();
        let active = true;
        const draft = Object.freeze({
          get: (key: K) => {
            assertScope(() => active);
            const entry = staged.get(key);
            return entry ? (entry.present ? entry.value : undefined) : values.get(key);
          },
          has: (key: K) => {
            assertScope(() => active);
            const entry = staged.get(key);
            return entry ? entry.present : values.has(key);
          },
          set: (key: K, value: V) => {
            assertScope(() => active);
            if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
            staged.set(key, { present: true, value });
          },
          remove: (key: K) => {
            assertScope(() => active);
            if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
            staged.set(key, { present: false });
          },
        });
        try {
          assertSynchronous(run(draft));
        } finally {
          active = false;
        }
        let changed = false;
        for (const [key, entry] of staged) {
          const present = values.has(key);
          if (entry.present ? present && Object.is(values.get(key), entry.value) : !present)
            continue;
          if (!touched.has(key)) touched.set(key, { present, value: values.get(key) });
          if (!beforeIds && present !== entry.present)
            beforeIds = Object.freeze([...values.keys()]);
          if (entry.present) values.set(key, entry.value);
          else values.delete(key);
          changed = true;
        }
        if (!changed) return;
        revision++;
        cause = scheduler.batchContext()?.cause ?? cause;
        scheduler.capture(record);
        scheduler.run();
      },
    };
  };
  const externalValueSource = <T>(
    port: ExternalValueSource<T>,
    equal: (a: T, b: T) => boolean
  ): GraphSource<ValueContext<T>> => {
    scheduler.assertIdle();
    const old = externalSources.get(port);
    if (old) return old as GraphSource<ValueContext<T>>;
    const input = valueSource<T>(port.current(), equal);
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
            reset: event.reset ?? false,
            cause: event.cause,
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
  const externalCollectionSource = <K extends string, V>(
    port: ExternalCollectionSource<K, V>
  ): GraphSource<CollectionContext<K, V>> => {
    scheduler.assertIdle();
    const old = externalSources.get(port);
    if (old) return old as GraphSource<CollectionContext<K, V>>;
    let read = port.current();
    let previous = read;
    let revision = port.revision();
    let change: CollectionContext<K, V>['change'];
    let reset = false;
    let orderChanged = false;
    let cause: unknown;
    let transitionKeys = new Set<K>();
    let pending = false;
    const handle = Object.freeze({ kind: 'collection' as const }) as unknown as GraphSource<
      CollectionContext<K, V>
    >;
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
        orderChanged = false;
        cause = undefined;
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
        return Object.freeze({
          kind: 'collection' as const,
          read: currentRead,
          change,
          revision,
          cause,
        });
      },
    };
    scheduler.register(handle, record);
    const fail = (error: unknown) => {
      record.fault = new ProjectionError('source', 'external collection source', [revision], error);
      scheduler.capture(record);
    };
    const deriveChange = (): CollectionContext<K, V>['change'] => {
      if (reset) return Object.freeze({ kind: 'reset' as const });
      const added: { readonly key: K; readonly after: V }[] = [];
      const updated: {
        readonly key: K;
        readonly before: V;
        readonly after: V;
      }[] = [];
      const removed: { readonly key: K; readonly before: V }[] = [];
      for (const key of transitionKeys) {
        const beforePresent = previous.has(key);
        const afterPresent = read.has(key);
        const before = beforePresent ? previous.get(key) : undefined;
        const after = afterPresent ? read.get(key) : undefined;
        if (beforePresent === afterPresent && Object.is(before, after)) continue;
        if (!beforePresent && afterPresent) added.push({ key, after: after as V });
        else if (beforePresent && !afterPresent) removed.push({ key, before: before as V });
        else if (beforePresent && afterPresent)
          updated.push({ key, before: before as V, after: after as V });
      }
      let order: { readonly before: readonly K[]; readonly after: readonly K[] } | undefined;
      if (orderChanged) {
        const beforeIds = previous.ids();
        const afterIds = read.ids();
        const beforeKeys = new Set(beforeIds);
        const afterKeys = new Set(afterIds);
        const beforeCommon = beforeIds.filter(key => afterKeys.has(key));
        const afterCommon = afterIds.filter(key => beforeKeys.has(key));
        if (beforeCommon.some((key, index) => afterCommon[index] !== key))
          order = Object.freeze({
            before: Object.freeze([...beforeIds]),
            after: Object.freeze([...afterIds]),
          });
      }
      if (!added.length && !removed.length && !updated.length && !order) return undefined;
      return Object.freeze({
        kind: 'incremental' as const,
        added: Object.freeze(added),
        updated: Object.freeze(updated),
        removed: Object.freeze(removed),
        ...(order ? { order } : {}),
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
          if (event.impact?.kind === 'incremental') {
            event.impact.added.forEach(key => transitionKeys.add(key));
            event.impact.removed.forEach(key => transitionKeys.add(key));
            event.impact.updated.forEach(key => transitionKeys.add(key));
            orderChanged ||= Boolean(
              event.impact.added.size || event.impact.removed.size || event.impact.orderChanged
            );
          } else if (!event.impact) {
            previous.ids().forEach(key => transitionKeys.add(key));
            read.ids().forEach(key => transitionKeys.add(key));
            orderChanged = true;
          }
          reset ||= event.impact?.kind === 'reset';
          cause = event.cause ?? scheduler.batchContext()?.cause ?? cause;
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
    fromSource: <T>(
      source: ExternalValueSource<T>,
      options?: { readonly isEqual?: (a: T, b: T) => boolean }
    ) => externalValueSource(source, options?.isEqual ?? Object.is),
    fromCollectionSource: <K extends string, V>(source: ExternalCollectionSource<K, V>) =>
      externalCollectionSource(source),
    input: <T>(initial: T, options?: { readonly isEqual?: (a: T, b: T) => boolean }) => {
      const { source, set } = valueSource(initial, options?.isEqual ?? Object.is);
      return Object.freeze({ source, set });
    },
    collectionInput,
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
      if (!isCollectionSource(handle)) throw new Error('map requires a collection source.');
    },
  };
};
