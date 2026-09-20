import type { Unsubscribe } from '../../runtime/contract';
import {
  collectionChange,
  collectionHasStructuralChange,
  diffCollection,
} from '../collection/change';
import type { CollectionChange } from '../contract';
import type { Readable } from '../../readable';

export type ProjectionReadableSource<T> = {
  readonly kind: 'value' | 'collection';
  current(): T;
  revision(): number;
  subscribe(listener: (change?: CollectionChange<string, unknown>) => void): Unsubscribe;
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
  for (const key of collectionChange.keys(change)) if (selection.keys.has(key)) return true;
  return false;
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
  let sourceRevision = -1;
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
      keys: new Set(tracker.keys),
      all: tracker.all || (isMapLike(current) && tracker.keys.size === 0 && !tracker.structure),
      structure: tracker.structure,
    });
    const changed = !initialized || !equality(value, next);
    if (changed) {
      if (initialized) selectedRevision++;
      value = next;
    }
    selection = nextSelection;
    initialized = true;
    sourceRevision = source.revision();
    updateCollectionSnapshot(current);
    return changed;
  };

  const ensureCurrent = (): R => {
    const revision = source.revision();
    if (!initialized || (!unsubscribeSource && sourceRevision !== revision)) evaluate();
    return value;
  };

  const onProjectionChange = (incoming?: CollectionChange<string, unknown>) => {
    let change = incoming;
    if (!change && previousCollection) {
      const current = source.current();
      if (isMapLike(current)) {
        change = diffCollection(previousCollection, current);
        previousCollection = current;
        if (!change) {
          sourceRevision = source.revision();
          return;
        }
      } else previousCollection = undefined;
    }
    if (!selectionAffects(selection, change)) {
      sourceRevision = source.revision();
      updateCollectionSnapshot();
      return;
    }
    if (evaluate()) Array.from(listeners).forEach(listener => listener());
  };

  const installSource = () => {
    if (!unsubscribeSource) unsubscribeSource = source.subscribe(onProjectionChange);
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
