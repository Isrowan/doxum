import type { CollectionImpact } from '../impact';
import { profile } from '../profile';
import type {
  CollectionInput,
  CollectionRead,
  CollectionSpec,
  ProjectionCollectionWriter,
  ProjectionCollection,
  ProjectionSources,
} from './contract';
import type { Readable } from './readable';
import { createNode } from './node';
import { assertScope, assertSynchronous, projectionHandles, type Scheduler } from './scheduler';

export const collectionHandles = new WeakSet<object>();

const readonlySet = <T>(values: Iterable<T>): ReadonlySet<T> => {
  const set = new Set(values);
  const view: ReadonlySet<T> = Object.freeze({
    get size() {
      return set.size;
    },
    has: (value: T) => set.has(value),
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    [Symbol.iterator]: () => set.values(),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) =>
      set.forEach(value => callback.call(thisArg, value, value, view)),
  });
  return view;
};
type Entry<V> = { present: true; value: V } | { present: false };
export const createCollection = <S extends ProjectionSources, K extends string, V>(
  scheduler: Scheduler,
  spec: CollectionSpec<S, K, V>
): ProjectionCollection<K, V> => {
  const values = new Map<K, V>();
  let ids: readonly K[] = Object.freeze([]);
  let staged = new Map<K, Entry<V>>();
  let nextIds = ids;
  let change: CollectionImpact<K> | undefined;
  let instance: ReturnType<typeof spec.build> | undefined;
  let initialized = false;
  let reset = false;
  let revision = 0;
  let idsRevision = 0;
  let all: readonly V[] | undefined;
  type Item = { readable: Readable<V | undefined>; revision: number; listeners?: Set<() => void> };
  const items = new Map<K, Item>();
  const subscribedItems = new Set<Item>();
  const idsListeners = new Set<() => void>();
  const allListeners = new Set<() => void>();
  const listeners = new Set<(change: CollectionImpact<K>) => void>();
  const changedKeys = new Set<K>();
  let orderChanged = false;
  const hasNext = (key: K) => (staged.has(key) ? staged.get(key)!.present : values.has(key));
  const getNext = (key: K) => {
    const entry = staged.get(key);
    return entry ? (entry.present ? entry.value : undefined) : values.get(key);
  };
  const owner = createNode(scheduler, spec, {
    evaluate: (sources, build, active) => {
      staged = new Map();
      nextIds = ids;
      change = undefined;
      changedKeys.clear();
      let explicitOrder: readonly K[] | undefined;
      let cleared = false;
      const nextHas = (key: K) =>
        staged.has(key) ? staged.get(key)!.present : !cleared && values.has(key);
      const nextGet = (key: K) => {
        const entry = staged.get(key);
        return entry
          ? entry.present
            ? entry.value
            : undefined
          : cleared
            ? undefined
            : values.get(key);
      };
      const deriveIds = () => {
        const result = cleared ? [] : ids.filter(nextHas);
        for (const [key, entry] of staged)
          if (entry.present && (cleared || !values.has(key))) result.push(key);
        return result;
      };
      const read = (next: boolean): CollectionRead<K, V> => ({
        get: key => {
          assertScope(active);
          return next ? nextGet(key) : values.get(key);
        },
        has: key => {
          assertScope(active);
          return next ? nextHas(key) : values.has(key);
        },
        ids: () => {
          assertScope(active);
          return next ? Object.freeze(explicitOrder ? explicitOrder.slice() : deriveIds()) : ids;
        },
      });
      const writer: ProjectionCollectionWriter<K, V> = {
        set: (key, value) => {
          assertScope(active);
          if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
          staged.set(key, { present: true, value });
        },
        remove: key => {
          assertScope(active);
          staged.set(key, { present: false });
        },
        order: order => {
          assertScope(active);
          explicitOrder = order.slice();
        },
        replace: entries => {
          assertScope(active);
          staged.clear();
          cleared = true;
          const order: K[] = [];
          for (const [key, value] of entries) {
            if (staged.has(key)) throw new TypeError('Duplicate projection key.');
            writer.set(key, value);
            order.push(key);
          }
          explicitOrder = order;
        },
      };
      const input = { sources, previous: read(false), next: read(true), writer };
      if (build || !instance) {
        profile.materialized.rebuilt();
        instance = undefined;
        cleared = true;
        const built = spec.build(input);
        assertSynchronous(built);
        instance = built;
      } else {
        profile.materialized.updated();
        const result = instance.update(input);
        assertSynchronous(result);
        if (result?.kind === 'rebuild') {
          staged.clear();
          cleared = true;
          explicitOrder = undefined;
          instance = undefined;
          const built = spec.build(input);
          assertSynchronous(built);
          instance = built;
          build = true;
        }
      }
      if (cleared)
        for (const key of values.keys()) if (!staged.has(key)) staged.set(key, { present: false });
      const added = new Set<K>();
      const removed = new Set<K>();
      const updated = new Set<K>();
      profile.projection('touchedKeys', staged.size);
      for (const [key, entry] of staged) {
        const existed = values.has(key);
        if (entry.present) {
          if (!existed) added.add(key);
          else if (!(spec.isEqual ?? Object.is)(values.get(key) as V, entry.value))
            updated.add(key);
          else staged.delete(key);
        } else if (existed) removed.add(key);
        else staged.delete(key);
      }
      if (explicitOrder || added.size || removed.size) {
        const order = explicitOrder ?? [...ids.filter(key => !removed.has(key)), ...added];
        const seen = new Set(order);
        if (
          seen.size !== order.length ||
          order.length !== values.size + added.size - removed.size ||
          order.some(key => !hasNext(key))
        )
          throw new TypeError('Projection order must contain every key exactly once.');
        nextIds =
          ids.length === order.length && ids.every((key, i) => key === order[i])
            ? ids
            : Object.freeze(order.slice());
      }
      orderChanged = nextIds !== ids;
      if (added.size || removed.size || updated.size || orderChanged) {
        let commonOrderChanged = false;
        if (orderChanged) {
          const before = ids.filter(key => !removed.has(key));
          const after = nextIds.filter(key => !added.has(key));
          commonOrderChanged = before.some((key, i) => after[i] !== key);
        }
        change = Object.freeze({
          kind: 'incremental',
          added: readonlySet(added),
          removed: readonlySet(removed),
          updated: readonlySet(updated),
          orderChanged: commonOrderChanged,
        });
        [...added, ...removed, ...updated].forEach(key => changedKeys.add(key));
        profile.projection('changedKeys', changedKeys.size);
      }
      reset = build;
      return change !== undefined;
    },
    context: active => {
      const input: CollectionInput<K, V> = {
        get: key => {
          assertScope(active);
          return getNext(key);
        },
        has: key => {
          assertScope(active);
          return hasNext(key);
        },
        ids: () => {
          assertScope(active);
          return nextIds;
        },
        change,
        revision: revision + (change ? 1 : 0),
        reset,
      };
      return Object.freeze(input);
    },
    revision: () => revision,
    reset: () => reset,
    publish: () => {
      for (const [key, entry] of staged) {
        if (entry.present) values.set(key, entry.value);
        else values.delete(key);
      }
      if (change) {
        if (initialized) revision++;
        if (orderChanged && initialized) idsRevision++;
        all = undefined;
        changedKeys.forEach(key => {
          const item = items.get(key);
          if (item && initialized) item.revision++;
        });
      }
      ids = nextIds;
      initialized = true;
    },
    emit: call => {
      profile.materialized.notification();
      const fault = owner.node.fault !== undefined;
      const resetEvent = Object.freeze({ kind: 'reset' as const });
      Array.from(listeners).forEach(listener => call(() => listener(change ?? resetEvent)));
      if (orderChanged || !change || fault || owner.node.statusChanged)
        Array.from(idsListeners).forEach(listener => call(listener));
      Array.from(allListeners).forEach(listener => call(listener));
      if (!change || fault || owner.node.statusChanged) {
        for (const item of subscribedItems)
          Array.from(item.listeners ?? []).forEach(listener => call(listener));
      } else {
        for (const key of changedKeys)
          Array.from(items.get(key)?.listeners ?? []).forEach(listener => call(listener));
      }
    },
    clear: () => {
      staged.clear();
      nextIds = ids;
      change = undefined;
      reset = false;
      changedKeys.clear();
      orderChanged = false;
    },
    release: () => {
      values.clear();
      staged.clear();
      items.clear();
      subscribedItems.clear();
      idsListeners.clear();
      allListeners.clear();
      listeners.clear();
      ids = nextIds = Object.freeze([]);
      all = undefined;
      instance = undefined;
    },
  });
  const handle = {
    ids: {
      current: () => {
        owner.check();
        return ids;
      },
      revision: () => {
        owner.check();
        return idsRevision;
      },
      subscribe: (listener: () => void) => {
        owner.check();
        idsListeners.add(listener);
        return () => {
          idsListeners.delete(listener);
        };
      },
    },
    all: {
      current: () => {
        owner.check();
        if (!all) {
          profile.collectionView.arrayCopied();
          all = Object.freeze(ids.map(key => values.get(key) as V));
        }
        return all;
      },
      revision: () => {
        owner.check();
        return revision;
      },
      subscribe: (listener: () => void) => {
        owner.check();
        allListeners.add(listener);
        return () => {
          allListeners.delete(listener);
        };
      },
    },
    item: (key: K) => {
      owner.check();
      const old = items.get(key);
      if (old) return old.readable;
      const readable: Readable<V | undefined> = Object.freeze({
        current: () => {
          owner.check();
          return values.get(key);
        },
        revision: () => {
          owner.check();
          return item.revision;
        },
        subscribe: (listener: () => void) => {
          owner.check();
          const set = (item.listeners ??= new Set());
          set.add(listener);
          subscribedItems.add(item);
          return () => {
            set.delete(listener);
            if (!set.size) subscribedItems.delete(item);
          };
        },
      });
      const item: Item = { readable, revision: 0 };
      projectionHandles.add(readable);
      items.set(key, item);
      return readable;
    },
    revision: () => {
      owner.check();
      return revision;
    },
    subscribe: (listener: (change: CollectionImpact<K>) => void) => {
      owner.check();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rebuild: owner.rebuild,
    dispose: owner.dispose,
  } as ProjectionCollection<K, V>;
  projectionHandles.add(handle.ids);
  projectionHandles.add(handle.all);
  collectionHandles.add(handle);
  owner.install(handle);
  return Object.freeze(handle);
};
