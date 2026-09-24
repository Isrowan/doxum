import { iterableMatchesArray } from '@/value/array';
import type { Unsubscribe } from '@/runtime/contract';
import {
  collectionChangeIntersects,
  collectionHasStructuralChange,
} from '@/projection/collection/change';
import type { CollectionChange } from '@/projection/contract';
import type { Readable } from '@/readable';
import { notifyProjectionListeners } from './listeners';

export type ProjectionReadableSource<T> = {
  readonly kind: 'value' | 'collection';
  current(): T;
  revision(): number;
  subscribe(listener: (change?: CollectionChange<string, unknown>) => void): Unsubscribe;
  observe(listener: (change?: CollectionChange<string, unknown>) => void): Unsubscribe;
};

type SelectionTracker = {
  readonly keys: Set<string>;
  all: boolean;
  structure: boolean;
};

type Selection = {
  readonly keys: ReadonlySet<string>;
  readonly all: boolean;
  readonly structure: boolean;
};

let activeTracker: SelectionTracker | undefined;

const trackKey = (key: string): void => {
  activeTracker?.keys.add(key);
};

const trackStructure = (): void => {
  if (activeTracker) activeTracker.structure = true;
};

const trackAll = (): void => {
  if (activeTracker) activeTracker.all = true;
};

export const isMapLike = (value: unknown): value is ReadonlyMap<string, unknown> =>
  value instanceof Map ||
  (value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { keys?: unknown }).keys === 'function' &&
    typeof (value as { entries?: unknown }).entries === 'function');

const trackedMap = <K extends string, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> => {
  const view: ReadonlyMap<K, V> = {
    get: key => {
      trackKey(key);
      return source.get(key);
    },
    has: key => {
      trackKey(key);
      return source.has(key);
    },
    get size() {
      trackStructure();
      return source.size;
    },
    keys: () => {
      trackStructure();
      return source.keys();
    },
    values: () => {
      trackAll();
      return source.values();
    },
    entries: () => {
      trackAll();
      return source.entries();
    },
    forEach: (callback, thisArg) => {
      trackAll();
      source.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: () => {
      trackAll();
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
};

const selectionAffects = (
  selection: Selection,
  change: CollectionChange<string, unknown> | undefined
): boolean => {
  if (!change || change.kind === 'reset') return true;
  if (selection.all) return true;
  if (selection.structure && collectionHasStructuralChange(change)) return true;
  return collectionChangeIntersects(change, selection.keys);
};

export const createDirectReadable = <T>(source: ProjectionReadableSource<T>): Readable<T> =>
  Object.freeze({
    current: source.current,
    revision: source.revision,
    subscribe: (listener: () => void) => source.subscribe(() => listener()),
  });

/** Consumer-side selector tracking; it never mutates processor dependencies. */
export const createSelectorReadable = <T, R>(
  source: ProjectionReadableSource<T>,
  selector: (value: T) => R,
  equality: (previous: R, next: R) => boolean = Object.is
): Readable<R> => {
  let initialized = false;
  let value!: R;
  let selectedRevision = 0;
  let notified!: R;
  let sourceRevision = -1;
  let notificationRevision = -1;
  let selection: Selection = Object.freeze({
    keys: new Set<string>(),
    all: true,
    structure: false,
  });
  let previousCollection: ReadonlyMap<string, unknown> | undefined;
  let unsubscribeSource: Unsubscribe | undefined;
  const listeners = new Set<() => void>();

  const updateCollectionSnapshot = (current?: T) => {
    const candidate = current ?? source.current();
    previousCollection = isMapLike(candidate) ? candidate : undefined;
  };

  const evaluate = (): boolean => {
    const tracker: SelectionTracker = { keys: new Set(), all: false, structure: false };
    const previousTracker = activeTracker;
    activeTracker = tracker;
    let current!: T;
    let next!: R;
    try {
      current = source.current();
      const selectedSource = isMapLike(current) ? (trackedMap(current) as unknown as T) : current;
      next = selector(selectedSource);
    } finally {
      activeTracker = previousTracker;
    }
    const nextSelection: Selection = Object.freeze({
      keys: tracker.keys,
      all: tracker.all || (isMapLike(current) && tracker.keys.size === 0 && !tracker.structure),
      structure: tracker.structure,
    });
    const changed = !initialized || !equality(value, next);
    if (changed) {
      const candidate = unsubscribeSource && equality(notified, next) ? notified : next;
      if (initialized) selectedRevision++;
      value = candidate;
    }
    selection = nextSelection;
    initialized = true;
    sourceRevision = source.revision();
    updateCollectionSnapshot(current);
    return changed;
  };

  const ensureCurrent = (): R => {
    const revision = source.revision();
    if (!initialized) evaluate();
    else if (sourceRevision !== revision) {
      const current = source.current();
      let affected = true;
      if (previousCollection && isMapLike(current) && !selection.all) {
        affected =
          selection.structure &&
          !iterableMatchesArray(current.keys(), [...previousCollection.keys()]);
        if (!affected)
          for (const key of selection.keys)
            if (
              previousCollection.has(key) !== current.has(key) ||
              !Object.is(previousCollection.get(key), current.get(key))
            ) {
              affected = true;
              break;
            }
      }
      if (affected) evaluate();
      else {
        sourceRevision = revision;
        updateCollectionSnapshot(current);
      }
    }
    return value;
  };

  const onProjectionChange = (incoming?: CollectionChange<string, unknown>) => {
    if (
      sourceRevision === notificationRevision &&
      sourceRevision !== source.revision() &&
      incoming &&
      !selectionAffects(selection, incoming)
    ) {
      sourceRevision = source.revision();
      updateCollectionSnapshot();
    } else ensureCurrent();
    notificationRevision = sourceRevision;
    if (!equality(notified, value)) {
      notified = value;
      notifyProjectionListeners(listeners, 'Projection selector listeners failed.');
    }
  };

  const installSource = () => {
    if (!unsubscribeSource) {
      notified = value;
      notificationRevision = sourceRevision;
      unsubscribeSource = source.observe(onProjectionChange);
    }
  };

  return Object.freeze({
    current: ensureCurrent,
    revision: () => {
      ensureCurrent();
      return selectedRevision;
    },
    subscribe: (listener: () => void) => {
      ensureCurrent();
      listeners.add(listener);
      installSource();
      return () => {
        listeners.delete(listener);
        if (!listeners.size && unsubscribeSource) {
          unsubscribeSource();
          unsubscribeSource = undefined;
        }
      };
    },
  });
};
