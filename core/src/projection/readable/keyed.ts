import type { Readable } from '../../readable';
import type { Unsubscribe } from '../../runtime/contract';
import { ProjectionDisposedError, type CollectionChange } from '../contract';
import { notifyProjectionListeners } from './listeners';
import type { ProjectionReadableSource } from './selection';

export type ProjectionItems<K extends string, V> = {
  readonly keys: Readable<readonly K[]>;
  get(key: K): Readable<V | undefined>;
};

export type ProjectionItemsController<K extends string, V> = {
  readonly items: ProjectionItems<K, V>;
  dispose(): void;
};

type ItemState<K extends string, V> = {
  readonly key: K;
  readable: Readable<V | undefined>;
  readonly listeners: Set<() => void>;
  tracked: boolean;
  ended: boolean;
  value: V | undefined;
  revision: number;
};

const sameKeys = <K extends string>(previous: readonly K[], next: readonly K[]): boolean =>
  previous.length === next.length && previous.every((key, index) => key === next[index]);

/** Runtime-owned keyed consumer family over one materialized collection output. */
export const createProjectionItems = <K extends string, V>(
  source: ProjectionReadableSource<ReadonlyMap<K, V>>,
  checkOwner: () => void
): ProjectionItemsController<K, V> => {
  if (source.kind !== 'collection')
    throw new TypeError('Projection items require a keyed collection projection.');

  let disposed = false;
  const active = new Map<K, ItemState<K, V>>();
  const followers = new Map<K, Set<ItemState<K, V>>>();
  const waiting = new Map<K, Set<ItemState<K, V>>>();
  let keysValue = Object.freeze([...source.current().keys()]) as readonly K[];
  let keysRevision = 0;
  const keyListeners = new Set<() => void>();

  const check = (): void => {
    if (disposed) throw new ProjectionDisposedError();
    checkOwner();
  };

  const notifications: Array<() => void> = [];
  const notify = (listeners: ReadonlySet<() => void>): void => {
    for (const listener of listeners) notifications.push(listener);
  };
  const flushNotifications = (): void => {
    const pending = notifications.splice(0);
    notifyProjectionListeners(pending, 'Projection item listeners failed.');
  };

  const unregisterWaiting = (state: ItemState<K, V>): void => {
    const states = waiting.get(state.key);
    states?.delete(state);
    if (states?.size === 0) waiting.delete(state.key);
  };

  const registerWaiting = (state: ItemState<K, V>): void => {
    if (state.tracked || state.ended) return;
    const states = waiting.get(state.key);
    if (states) states.add(state);
    else waiting.set(state.key, new Set([state]));
  };

  const publishState = (state: ItemState<K, V>, value: V | undefined): void => {
    if (state.ended) return;
    if (Object.is(state.value, value)) {
      state.value = value;
      return;
    }
    state.value = value;
    state.revision++;
    notify(state.listeners);
  };

  const attachActive = (state: ItemState<K, V>, value: V | undefined): void => {
    if (state.ended) return;
    unregisterWaiting(state);
    state.tracked = true;
    const canonical = active.get(state.key);
    if (!canonical) active.set(state.key, state);
    else if (canonical !== state) {
      const states = followers.get(state.key);
      if (states) states.add(state);
      else followers.set(state.key, new Set([state]));
    }
    publishState(state, value);
  };

  const terminateState = (state: ItemState<K, V>): void => {
    if (state.ended) return;
    unregisterWaiting(state);
    state.tracked = false;
    publishState(state, undefined);
    state.ended = true;
  };

  const statesFor = (key: K): readonly ItemState<K, V>[] => {
    const result: ItemState<K, V>[] = [];
    const canonical = active.get(key);
    if (canonical) result.push(canonical);
    const extra = followers.get(key);
    if (extra) result.push(...extra);
    return result;
  };

  const terminateKey = (key: K): void => {
    for (const state of statesFor(key)) terminateState(state);
    active.delete(key);
    followers.delete(key);
  };

  const activateWaiting = (key: K, value: V | undefined): void => {
    const states = waiting.get(key);
    if (!states?.size) return;
    waiting.delete(key);
    for (const state of states) attachActive(state, value);
  };

  const updateKey = (key: K, value: V | undefined): void => {
    for (const state of statesFor(key)) publishState(state, value);
  };

  const updateKeys = (current: ReadonlyMap<K, V>): void => {
    const next = Object.freeze([...current.keys()]) as readonly K[];
    if (sameKeys(keysValue, next)) return;
    keysValue = next;
    keysRevision++;
    notify(keyListeners);
  };

  const createItem = (
    key: K,
    initial?: { readonly present: true; readonly value: V }
  ): ItemState<K, V> => {
    const state = {
      key,
      listeners: new Set<() => void>(),
      tracked: initial !== undefined,
      ended: false,
      value: initial?.value,
      revision: 0,
    } as ItemState<K, V>;
    const ensureObserved = (): void => {
      if (state.ended || state.tracked) return;
      const current = source.current();
      if (current.has(key)) attachActive(state, current.get(key) as V);
    };
    state.readable = Object.freeze({
      current: () => {
        check();
        ensureObserved();
        return state.value;
      },
      revision: () => {
        check();
        ensureObserved();
        return state.revision;
      },
      subscribe: (listener: () => void): Unsubscribe => {
        check();
        ensureObserved();
        state.listeners.add(listener);
        if (!state.tracked && !state.ended) registerWaiting(state);
        return () => {
          state.listeners.delete(listener);
          if (!state.listeners.size && !state.tracked) unregisterWaiting(state);
        };
      },
    });
    return state;
  };

  const reconcile = (current: ReadonlyMap<K, V>): void => {
    for (const key of [...active.keys()]) {
      if (!current.has(key)) terminateKey(key);
      else updateKey(key, current.get(key) as V);
    }
    for (const key of [...waiting.keys()])
      if (current.has(key)) activateWaiting(key, current.get(key) as V);
    updateKeys(current);
  };

  const onChange = (change?: CollectionChange<string, unknown>): void => {
    check();
    const current = source.current();
    if (!change || change.kind === 'reset') {
      reconcile(current);
      flushNotifications();
      return;
    }
    for (const entry of change.removed) terminateKey(entry.key as K);
    for (const entry of change.added) activateWaiting(entry.key as K, entry.after as V);
    for (const entry of change.updated) updateKey(entry.key as K, entry.after as V);
    if (change.added.length || change.removed.length || change.order) updateKeys(current);
    flushNotifications();
  };

  const stop = source.subscribe(onChange);
  const keys: Readable<readonly K[]> = Object.freeze({
    current: () => {
      check();
      return keysValue;
    },
    revision: () => {
      check();
      return keysRevision;
    },
    subscribe: listener => {
      check();
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    },
  });

  const items: ProjectionItems<K, V> = Object.freeze({
    keys,
    get: (key: K) => {
      check();
      const canonical = active.get(key);
      if (canonical) return canonical.readable;
      const pending = waiting.get(key)?.values().next().value as ItemState<K, V> | undefined;
      if (pending) return pending.readable;
      const current = source.current();
      if (current.has(key)) {
        const state = createItem(key, { present: true, value: current.get(key) as V });
        active.set(key, state);
        return state.readable;
      }
      return createItem(key).readable;
    },
  });

  return {
    items,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      keyListeners.clear();
      const known = new Set<ItemState<K, V>>();
      active.forEach(state => known.add(state));
      followers.forEach(states => states.forEach(state => known.add(state)));
      waiting.forEach(states => states.forEach(state => known.add(state)));
      known.forEach(state => state.listeners.clear());
      active.clear();
      followers.clear();
      waiting.clear();
      notifications.length = 0;
    },
  };
};
