import { read as readAddress } from '../address';
import { snapshot } from '../access/scope';
import { accessOf } from '../runtime/access';
import { compilePath } from '../schema';
import type { Unsubscribe } from '../runtime/contract';
import type { CollectionImpact } from '../impact';
import type {
  CollectionRead,
  CollectionNode,
  RuntimeExecutor,
  BatchOptions,
  ValueNode,
  GraphSource,
} from './contract';
import type { Readable } from './readable';
import { definitionOf, type Input, type Projection, type PublicCollection } from './definition';
import { createRuntimeExecutor } from './runtime';

type RuntimeNode = ValueNode<unknown> | CollectionNode<string, unknown>;
type RuntimeValue = RuntimeNode;
type SelectionTracker = {
  readonly keys: Set<string>;
  all: boolean;
  structure: boolean;
};
type RuntimeState = {
  readonly materialize: (projection: Projection<unknown>) => RuntimeValue;
  readonly get: <T>(projection: Projection<T>) => T;
};

export type ProjectionRuntime = {
  get<T>(projection: Projection<T>): T;
  subscribe<T>(projection: Projection<T>, listener: () => void): Unsubscribe;
  set<T>(input: Input<T>, value: T): void;
  batch<T>(run: () => T): T;
  batch<T>(options: BatchOptions, run: () => T): T;
  dispose(): void;
};

const runtimeStates = new WeakMap<object, RuntimeState>();
let activeTracker: SelectionTracker | undefined;

const trackKey = (key: string): void => {
  activeTracker?.keys.add(key);
};
const trackAll = (structure = false): void => {
  if (!activeTracker) return;
  activeTracker.all = true;
  activeTracker.structure ||= structure;
};

const mapView = <K extends string, V>(read: CollectionRead<K, V>): PublicCollection<K, V> => {
  const keys = read.ids();
  const source = new Map<K, V>();
  for (const key of keys) source.set(key, read.get(key) as V);
  const view: PublicCollection<K, V> = {
    get: key => {
      trackKey(key);
      return source.get(key);
    },
    has: key => {
      trackKey(key);
      return source.has(key);
    },
    get size() {
      trackAll(true);
      return source.size;
    },
    keys: () => {
      trackAll(true);
      return source.keys();
    },
    values: () => {
      trackAll(true);
      return source.values();
    },
    entries: () => {
      trackAll(true);
      return source.entries();
    },
    forEach: (callback, thisArg) => {
      trackAll(true);
      source.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: () => {
      trackAll(true);
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
};

const isMapLike = (value: unknown): value is ReadonlyMap<string, unknown> =>
  value instanceof Map ||
  (value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { keys?: unknown }).keys === 'function' &&
    typeof (value as { entries?: unknown }).entries === 'function');

const mapRead = (value: ReadonlyMap<string, unknown>): CollectionRead<string, unknown> => ({
  get: key => value.get(key),
  has: key => value.has(key),
  ids: () => Object.freeze([...value.keys()]),
});

const mapChange = (
  previous: ReadonlyMap<string, unknown>,
  current: ReadonlyMap<string, unknown>
): CollectionImpact<string> | undefined => {
  const added = new Set<string>();
  const removed = new Set<string>();
  const updated = new Set<string>();
  for (const key of previous.keys()) {
    if (!current.has(key)) removed.add(key);
    else if (!Object.is(previous.get(key), current.get(key))) updated.add(key);
  }
  for (const key of current.keys()) if (!previous.has(key)) added.add(key);
  const before = [...previous.keys()].filter(key => current.has(key));
  const after = [...current.keys()].filter(key => previous.has(key));
  const orderChanged =
    before.length !== after.length || before.some((key, index) => key !== after[index]);
  if (!added.size && !removed.size && !updated.size && !orderChanged) return undefined;
  return { kind: 'incremental', added, removed, updated, orderChanged };
};

const currentValue = (event: unknown): unknown => {
  if (!event || typeof event !== 'object') return event;
  if ('value' in event) return (event as { readonly value: unknown }).value;
  if ('read' in event) return snapshot((event as { readonly read: unknown }).read);
  if ('ids' in event && typeof (event as { ids?: unknown }).ids === 'function')
    return mapView(event as CollectionRead<string, unknown>);
  return event;
};

const sourceOf = (instance: RuntimeNode): GraphSource<unknown> => instance as GraphSource<unknown>;

export const createProjectionRuntime = (options?: {
  readonly onError?: (error: import('./contract').ProjectionError) => void;
}): ProjectionRuntime => {
  const runtime = createRuntimeExecutor({ onError: options?.onError ?? (() => undefined) });
  const instances = new WeakMap<object, RuntimeValue>();
  const inputs = new WeakMap<object, { readonly source: object; set(value: unknown): void }>();
  const collections = new WeakMap<
    object,
    { revision: number; value: PublicCollection<string, unknown> }
  >();

  const materialize = (projection: Projection<unknown>): RuntimeValue => {
    const old = instances.get(projection);
    if (old) return old;
    const definition = definitionOf(projection);
    let instance: RuntimeValue;
    switch (definition.kind) {
      case 'input': {
        const input = runtime.input(definition.initial, { isEqual: definition.isEqual });
        inputs.set(projection, input);
        instance = runtime.value({ input: input.source }, ({ input }) => input.value);
        break;
      }
      case 'readable': {
        const source = runtime.fromReadable(definition.readable, { isEqual: definition.isEqual });
        instance = runtime.value({ source }, ({ source }) => source.value);
        break;
      }
      case 'source-value':
        {
          const source = runtime.fromSource(definition.source);
          instance = runtime.value({ source }, ({ source }) => source.value);
        }
        break;
      case 'source-collection': {
        const source = runtime.fromCollectionSource(definition.source);
        instance = runtime.map(source as never, (_key, value) => value);
        break;
      }
      case 'document': {
        const document = runtime.document(definition.document);
        if (!definition.selector) {
          instance = runtime.value({ document }, ({ document }) => snapshot(document.read));
          break;
        }
        const state = accessOf(definition.document);
        try {
          const collection = document.collection(definition.selector as never);
          instance = runtime.map(collection, (_id, entry) => snapshot(entry));
          break;
        } catch {
          const selected = document.targets(definition.selector as never);
          const address = compilePath(state.schema, 'value', definition.selector as never).address;
          instance = runtime.value({ selected }, () => {
            const root = snapshot(state.document);
            return readAddress(root, address, state.schema);
          });
        }
        break;
      }
      case 'derive': {
        const sources = Object.fromEntries(
          definition.dependencies.map((dependency, index) => [
            `d${index}`,
            sourceOf(materialize(dependency)),
          ])
        );
        instance = runtime.value(
          sources,
          values => definition.compute(...Object.values(values).map(currentValue)),
          { isEqual: definition.isEqual }
        );
        break;
      }
      case 'incremental-value': {
        const sources = Object.fromEntries(
          Object.entries(definition.dependencies).map(([key, dependency]) => [
            key,
            sourceOf(materialize(dependency as never)),
          ])
        );
        instance = runtime.value(
          { sources, build: definition.build as never },
          { isEqual: definition.isEqual as never }
        );
        break;
      }
      case 'incremental-collection': {
        const sources = Object.fromEntries(
          Object.entries(definition.dependencies).map(([key, dependency]) => [
            key,
            sourceOf(materialize(dependency as never)),
          ])
        );
        instance = runtime.collection<unknown>()({
          sources,
          build: definition.build as never,
          isEqual: definition.isEqual as never,
          name: definition.name,
        });
        break;
      }
    }
    instances.set(projection, instance);
    return instance;
  };

  const get = <T>(projection: Projection<T>): T => {
    const instance = materialize(projection as Projection<unknown>);
    const current: unknown = instance.current();
    if (
      current &&
      typeof current === 'object' &&
      'ids' in current &&
      typeof (current as { ids?: unknown }).ids === 'function'
    ) {
      const existing = collections.get(instance);
      const revision = instance.revision();
      if (existing?.revision === revision) return existing.value as T;
      const value = mapView(current as CollectionRead<string, unknown>);
      collections.set(instance, { revision, value });
      return value as T;
    }
    if (isMapLike(current)) {
      const existing = collections.get(instance);
      const revision = instance.revision();
      if (existing?.revision === revision) return existing.value as T;
      const value = mapView(mapRead(current));
      collections.set(instance, { revision, value });
      return value as T;
    }
    return current as T;
  };

  const store: ProjectionRuntime = {
    get,
    subscribe: ((projection: Projection<unknown>, listener: () => void) => {
      const instance = materialize(projection);
      return instance.subscribe(listener as never);
    }) as ProjectionRuntime['subscribe'],
    set: ((input: Input<unknown>, value: unknown) => {
      materialize(input);
      const target = inputs.get(input);
      if (!target) throw new TypeError('Projection is not an input.');
      target.set(value);
    }) as ProjectionRuntime['set'],
    batch: runtime.batch,
    dispose: runtime.dispose,
  };
  runtimeStates.set(store, { materialize, get });
  return Object.freeze(store);
};

export type ProjectionSelection = {
  readonly keys: ReadonlySet<string>;
  readonly all: boolean;
  readonly structure: boolean;
};

export const trackProjection = <T, R>(
  owner: ProjectionRuntime,
  projection: Projection<T>,
  selector: (value: T) => R
): { readonly value: R; readonly selection: ProjectionSelection } => {
  const state = runtimeStates.get(owner);
  if (!state) throw new TypeError('Unknown projection runtime.');
  const tracker: SelectionTracker = { keys: new Set(), all: false, structure: false };
  const previous = activeTracker;
  activeTracker = tracker;
  try {
    const value = selector(state.get(projection));
    return {
      value,
      selection: Object.freeze({
        keys: new Set(tracker.keys),
        all: tracker.all,
        structure: tracker.structure,
      }),
    };
  } finally {
    activeTracker = previous;
  }
};

export const subscribeProjection = (
  owner: ProjectionRuntime,
  projection: Projection<unknown>,
  selection: ProjectionSelection,
  listener: () => void
): Unsubscribe => {
  const state = runtimeStates.get(owner);
  if (!state) throw new TypeError('Unknown projection runtime.');
  const instance = state.materialize(projection);
  let previousCollection: PublicCollection<string, unknown> | undefined;
  const initialValue = state.get(projection);
  if (isMapLike(initialValue)) previousCollection = initialValue;
  return instance.subscribe(((change: CollectionImpact<string> | undefined) => {
    if (!change && previousCollection) {
      const current = state.get(projection);
      if (isMapLike(current)) {
        change = mapChange(previousCollection, current);
        previousCollection = current;
        if (!change) return;
      } else previousCollection = undefined;
    }
    if (!change || change.kind === 'reset') {
      listener();
      return;
    }
    if (
      selection.all &&
      (selection.structure || change.added.size || change.removed.size || change.updated.size)
    ) {
      listener();
      return;
    }
    for (const key of selection.keys) {
      if (change.added.has(key) || change.removed.has(key) || change.updated.has(key)) {
        listener();
        return;
      }
    }
  }) as never);
};
