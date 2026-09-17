import { read as readAddress } from '../address';
import { snapshot } from '../access/scope';
import { accessOf } from '../runtime/access';
import { compilePath } from '../schema';
import type { Unsubscribe } from '../runtime/contract';
import type {
  CollectionChange,
  CollectionRead,
  CollectionNode,
  ValueNode,
  GraphSource,
} from './contract';
import { ProjectionDisposedError } from './contract';
import type { Readable } from './readable';
import {
  definitionOf,
  derive,
  input,
  ownDefinition,
  ownerOf,
  isProjection,
  type Input,
  type Projection,
  type IncrementalGroupDefinition,
} from './definition';
import {
  incremental,
  type IncrementalGroupDefine,
  type IncrementalGroupOutputTree,
  type IncrementalGroupProcessor,
  type IncrementalCollectionProcessor,
  type IncrementalValueProcessor,
} from './advanced';
import { createProjectionGraph } from './graph';

type RuntimeNode = ValueNode<unknown> | CollectionNode<string, unknown>;
type RuntimeValue = RuntimeNode;
type KeyedDraft<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  remove(key: K): void;
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

export type ProjectionRuntime = {
  get<T>(projection: Projection<T, unknown>): T;
  readable<T>(projection: Projection<T, unknown>): Readable<T>;
  readable<T, R>(
    projection: Projection<T, unknown>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  set<T>(input: Input<T>, value: T): void;
  update<K extends string, V>(
    input: Input<ReadonlyMap<K, V>, CollectionChange<K, V>>,
    run: (draft: KeyedDraft<K, V>) => void
  ): void;
  batch<T>(run: () => T): T;
  batch<T>(options: { readonly cause?: unknown }, run: () => T): T;
  scope(): ProjectionScope;
  dispose(): void;
};

export type ProjectionScope = {
  readonly input: typeof input;
  readonly derive: typeof derive;
  readonly incremental: typeof incremental;
  get<T>(projection: Projection<T, unknown>): T;
  readable<T>(projection: Projection<T, unknown>): Readable<T>;
  readable<T, R>(
    projection: Projection<T, unknown>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  set<T>(input: Input<T>, value: T): void;
  update<K extends string, V>(
    input: Input<ReadonlyMap<K, V>, CollectionChange<K, V>>,
    run: (draft: KeyedDraft<K, V>) => void
  ): void;
  batch: ProjectionRuntime['batch'];
  dispose(): void;
};

let activeTracker: SelectionTracker | undefined;

const trackKey = (key: string): void => {
  activeTracker?.keys.add(key);
};
const trackStructure = (): void => {
  if (!activeTracker) return;
  activeTracker.structure = true;
};
const trackAll = (): void => {
  if (!activeTracker) return;
  activeTracker.all = true;
};

const mapView = <K extends string, V>(read: CollectionRead<K, V>): ReadonlyMap<K, V> => {
  const keys = read.ids();
  const source = new Map<K, V>();
  for (const key of keys) source.set(key, read.get(key) as V);
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

const lazyMapView = <K extends string, V>(read: CollectionRead<K, V>): ReadonlyMap<K, V> => {
  const ids = read.ids();
  const entries = function* (): IterableIterator<[K, V]> {
    for (const key of ids) yield [key, read.get(key) as V];
  };
  const values = function* (): IterableIterator<V> {
    for (const key of ids) yield read.get(key) as V;
  };
  const view: ReadonlyMap<K, V> = {
    get: key => {
      trackKey(key);
      return read.get(key);
    },
    has: key => {
      trackKey(key);
      return read.has(key);
    },
    get size() {
      trackStructure();
      return ids.length;
    },
    keys: () => {
      trackStructure();
      return ids[Symbol.iterator]();
    },
    values: () => {
      trackAll();
      return values();
    },
    entries: () => {
      trackAll();
      return entries();
    },
    forEach: (callback, thisArg) => {
      trackAll();
      for (const key of ids) callback.call(thisArg, read.get(key) as V, key, view);
    },
    [Symbol.iterator]: () => {
      trackAll();
      return entries();
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
): CollectionChange<string, unknown> | undefined => {
  const added: { readonly key: string; readonly after: unknown }[] = [];
  const removed: { readonly key: string; readonly before: unknown }[] = [];
  const updated: {
    readonly key: string;
    readonly before: unknown;
    readonly after: unknown;
  }[] = [];
  for (const key of previous.keys()) {
    if (!current.has(key)) removed.push({ key, before: previous.get(key) });
    else if (!Object.is(previous.get(key), current.get(key)))
      updated.push({ key, before: previous.get(key), after: current.get(key) });
  }
  for (const key of current.keys())
    if (!previous.has(key)) added.push({ key, after: current.get(key) });
  const before = [...previous.keys()].filter(key => current.has(key));
  const after = [...current.keys()].filter(key => previous.has(key));
  const orderChanged =
    before.length !== after.length || before.some((key, index) => key !== after[index]);
  if (!added.length && !removed.length && !updated.length && !orderChanged) return undefined;
  return {
    kind: 'incremental',
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    updated: Object.freeze(updated),
    ...(orderChanged
      ? {
          order: Object.freeze({
            before: Object.freeze([...previous.keys()]),
            after: Object.freeze([...current.keys()]),
          }),
        }
      : {}),
  };
};

const sameSelection = (left: Selection, right: Selection): boolean => {
  if (
    left.all !== right.all ||
    left.structure !== right.structure ||
    left.keys.size !== right.keys.size
  )
    return false;
  for (const key of left.keys) if (!right.keys.has(key)) return false;
  return true;
};

const selectionAffects = (
  selection: Selection,
  change: CollectionChange<string, unknown> | undefined
): boolean => {
  if (!change || change.kind === 'reset') return true;
  if (
    selection.all &&
    (change.added.length || change.removed.length || change.updated.length || change.order)
  )
    return true;
  if (selection.structure && (change.added.length || change.removed.length || change.order))
    return true;
  for (const key of selection.keys) {
    if (
      change.added.some(entry => entry.key === key) ||
      change.removed.some(entry => entry.key === key) ||
      change.updated.some(entry => entry.key === key)
    )
      return true;
  }
  return false;
};

const currentValue = (event: unknown): unknown => {
  if (!event || typeof event !== 'object') return event;
  if ('kind' in event && event.kind === 'value')
    return (event as unknown as { readonly value: unknown }).value;
  if ('kind' in event && event.kind === 'document')
    return snapshot((event as unknown as { readonly read: unknown }).read);
  if ('kind' in event && event.kind === 'collection')
    return mapView((event as unknown as { readonly read: CollectionRead<string, unknown> }).read);
  return event;
};

const sourceOf = (instance: RuntimeNode): GraphSource<unknown> => instance as GraphSource<unknown>;

export const createProjectionRuntime = (options?: {
  readonly onError?: (error: import('./contract').ProjectionError) => void;
}): ProjectionRuntime => {
  const runtime = createProjectionGraph({ onError: options?.onError ?? (() => undefined) });
  type MaterializedBase = {
    readonly node: RuntimeValue;
    collection?: { revision: number; value: ReadonlyMap<string, unknown> };
  };
  type CollectionWrite = {
    readonly kind: 'collection-input';
    readonly source: object;
    readonly update: (run: (draft: KeyedDraft<string, unknown>) => void) => void;
  };
  type InputWrite =
    | {
        readonly kind: 'value-input';
        readonly source: object;
        readonly set: (value: unknown) => void;
      }
    | CollectionWrite;
  type Materialized = MaterializedBase & ({ readonly kind: 'projection' } | InputWrite);
  const materialized = new WeakMap<object, Materialized>();
  type MaterializedGroup = {
    readonly definition: IncrementalGroupDefinition;
    readonly nodes: readonly RuntimeNode[];
  };
  const groups = new WeakMap<object, MaterializedGroup>();
  let disposed = false;
  type ScopeState = {
    active: boolean;
    readonly materialized: object[];
    readonly subscriptions: Set<Unsubscribe>;
  };
  const scopes = new Set<ScopeState>();

  let materialize: (
    projection: Projection<unknown, unknown>,
    requester?: ScopeState
  ) => RuntimeValue;

  const materializeGroup = (
    definition: IncrementalGroupDefinition,
    requester?: ScopeState
  ): MaterializedGroup => {
    const existing = groups.get(definition);
    if (existing) return existing;
    const owners = definition.projections
      .map(projection => ownerOf(projection))
      .filter((owner): owner is object => owner !== undefined);
    if (owners.some(owner => owner !== requester))
      throw new TypeError('Projection group belongs to another scope.');
    const sources = Object.fromEntries(
      Object.entries(definition.dependencies).map(([key, dependency]) => [
        key,
        sourceOf(materialize(dependency as never, requester)),
      ])
    );
    const nodes = runtime.group({
      sources,
      outputs: definition.outputs,
      build: definition.build as never,
    });
    const group = Object.freeze({ definition, nodes });
    groups.set(definition, group);
    for (let index = 0; index < definition.projections.length; index++)
      materialized.set(definition.projections[index], {
        kind: 'projection',
        node: nodes[index],
      });
    if (requester) requester.materialized.push(definition);
    return group;
  };

  materialize = (
    projection: Projection<unknown, unknown>,
    requester?: ScopeState
  ): RuntimeValue => {
    const owner = ownerOf(projection);
    if (owner) {
      if (owner !== requester) throw new TypeError('Projection belongs to another scope.');
      if (!requester.active) throw new ProjectionDisposedError();
    }
    const old = materialized.get(projection);
    if (old) return old.node;
    const definition = definitionOf(projection);
    if (definition.kind === 'incremental-group-output')
      return materializeGroup(definition.group, requester).nodes[definition.output];
    let instance: RuntimeValue;
    let write: InputWrite | undefined;
    switch (definition.kind) {
      case 'input': {
        const input = runtime.input(definition.initial, { isEqual: definition.isEqual });
        write = { kind: 'value-input', source: input.source, set: input.set };
        instance = runtime.value({
          sources: { input: input.source },
          build: values => ({
            value: values.input.value,
            update: next => ({ kind: 'changed', value: next.input.value }),
          }),
        });
        break;
      }
      case 'collection-input': {
        const source = runtime.collectionInput(definition.initial);
        write = {
          kind: 'collection-input',
          source: source.source,
          update: source.update as CollectionWrite['update'],
        };
        instance = runtime.map(source.source, (_key, value) => value);
        break;
      }
      case 'readable': {
        const source = runtime.fromReadable(definition.readable, { isEqual: definition.isEqual });
        instance = runtime.value({
          sources: { source },
          build: values => ({
            value: values.source.value,
            update: next => ({ kind: 'changed', value: next.source.value }),
          }),
        });
        break;
      }
      case 'source-value':
        {
          const source = runtime.fromSource(definition.source);
          instance = runtime.value({
            sources: { source },
            build: values => ({
              value: values.source.value,
              update: next => ({ kind: 'changed', value: next.source.value }),
            }),
          });
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
          instance = runtime.value({
            sources: { document },
            build: values => ({
              value: snapshot(values.document.read),
              update: next => ({ kind: 'changed', value: snapshot(next.document.read) }),
            }),
          });
          break;
        }
        const state = accessOf(definition.document);
        const selected = compilePath(state.schema, 'auto', definition.selector as never);
        if (selected.kind === 'collection') {
          const collection = document.collection(definition.selector as never);
          instance = runtime.map(collection, (_id, entry) => entry);
          break;
        }
        const target = document.targets(definition.selector as never);
        instance = runtime.value({
          sources: { selected: target },
          build: () => ({
            value: readAddress(snapshot(state.document), selected.address, state.schema),
            update: () => ({
              kind: 'changed',
              value: readAddress(snapshot(state.document), selected.address, state.schema),
            }),
          }),
        });
        break;
      }
      case 'derive': {
        const sources = Object.fromEntries(
          definition.dependencies.map((dependency, index) => [
            `d${index}`,
            sourceOf(materialize(dependency, owner as ScopeState | undefined)),
          ])
        );
        instance = runtime.value(
          {
            sources,
            build: values => ({
              value: definition.compute(...Object.values(values).map(currentValue)),
              update: next => ({
                kind: 'changed',
                value: definition.compute(...Object.values(next).map(currentValue)),
              }),
            }),
          },
          { isEqual: definition.isEqual }
        );
        break;
      }
      case 'incremental-value': {
        const sources = Object.fromEntries(
          Object.entries(definition.dependencies).map(([key, dependency]) => [
            key,
            sourceOf(materialize(dependency as never, owner as ScopeState | undefined)),
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
            sourceOf(materialize(dependency as never, owner as ScopeState | undefined)),
          ])
        );
        instance = runtime.collection({
          sources,
          build: definition.build as never,
          isEqual: definition.isEqual as never,
          name: definition.name,
        });
        break;
      }
    }
    const record: Materialized = write
      ? { node: instance, ...write }
      : { kind: 'projection', node: instance };
    materialized.set(projection, record);
    if (owner) (owner as ScopeState).materialized.push(projection);
    return instance;
  };

  const get = <T>(projection: Projection<T, unknown>, requester?: ScopeState): T => {
    const instance = materialize(projection as Projection<unknown, unknown>, requester);
    const current: unknown = instance.current();
    if (instance.kind === 'collection') {
      const record = materialized.get(projection) ?? materialized.get(instance);
      const existing = record?.collection;
      const revision = instance.revision();
      if (existing?.revision === revision) return existing.value as T;
      const value = lazyMapView(current as CollectionRead<string, unknown>);
      if (record) record.collection = { revision, value };
      return value as T;
    }
    if (isMapLike(current)) {
      const record = materialized.get(projection) ?? materialized.get(instance);
      const existing = record?.collection;
      const revision = instance.revision();
      if (existing?.revision === revision) return existing.value as T;
      const value = mapView(mapRead(current));
      if (record) record.collection = { revision, value };
      return value as T;
    }
    return current as T;
  };

  const makeReadable = <T, R>(
    projection: Projection<T, unknown>,
    selector?: (value: T) => R,
    equality: (previous: R, next: R) => boolean = Object.is,
    requester?: ScopeState
  ): Readable<T | R> => {
    if (!selector) {
      return Object.freeze({
        current: () => get(projection, requester),
        revision: () => materialize(projection, requester).revision(),
        subscribe: (listener: () => void) =>
          materialize(projection, requester).subscribe(listener as never),
      });
    }

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

    const updateCollectionSnapshot = () => {
      const current = get(projection, requester);
      previousCollection = isMapLike(current) ? current : undefined;
    };

    const evaluate = (): boolean => {
      const tracker: SelectionTracker = { keys: new Set(), all: false, structure: false };
      const previousTracker = activeTracker;
      activeTracker = tracker;
      let source: T;
      let next: R;
      try {
        source = get(projection, requester);
        next = selector(source);
      } finally {
        activeTracker = previousTracker;
      }
      const nextSelection: Selection = Object.freeze({
        keys: new Set(tracker.keys),
        all: tracker.all || (isMapLike(source) && tracker.keys.size === 0),
        structure: tracker.structure,
      });
      const changed = !initialized || !equality(value, next);
      if (changed) {
        if (initialized) selectedRevision++;
        value = next;
      }
      selection = nextSelection;
      initialized = true;
      sourceRevision = materialize(projection, requester).revision();
      updateCollectionSnapshot();
      return changed;
    };

    const ensureCurrent = (): R => {
      const revision = materialize(projection, requester).revision();
      if (!initialized || (!unsubscribeSource && sourceRevision !== revision)) evaluate();
      return value;
    };

    const onProjectionChange = (incoming?: CollectionChange<string, unknown>) => {
      let change = incoming;
      if (!change && previousCollection) {
        const current = get(projection, requester);
        if (isMapLike(current)) {
          change = mapChange(previousCollection, current);
          previousCollection = current;
          if (!change) {
            sourceRevision = materialize(projection, requester).revision();
            return;
          }
        } else previousCollection = undefined;
      }
      if (!selectionAffects(selection, change)) {
        sourceRevision = materialize(projection, requester).revision();
        updateCollectionSnapshot();
        return;
      }
      const previousSelection = selection;
      const changed = evaluate();
      if (unsubscribeSource && !sameSelection(previousSelection, selection)) {
        unsubscribeSource();
        unsubscribeSource = materialize(projection, requester).subscribe(
          onProjectionChange as never
        );
      }
      if (changed) Array.from(listeners).forEach(listener => listener());
    };

    const installSource = () => {
      if (!unsubscribeSource) {
        unsubscribeSource = materialize(projection, requester).subscribe(
          onProjectionChange as never
        );
      }
    };

    const handle: Readable<R> = {
      current: ensureCurrent,
      revision: () => {
        ensureCurrent();
        return selectedRevision;
      },
      subscribe: listener => {
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
    };
    return Object.freeze(handle);
  };

  function readable<T>(projection: Projection<T, unknown>): Readable<T>;
  function readable<T, R>(
    projection: Projection<T, unknown>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  function readable<T, R>(
    projection: Projection<T, unknown>,
    selector?: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<T | R> {
    return makeReadable(projection, selector, equality);
  }

  const setInput = <T>(target: Input<T>, value: T, requester?: ScopeState): void => {
    materialize(target as Projection<unknown, unknown>, requester);
    const record = materialized.get(target);
    if (record?.kind !== 'value-input') throw new TypeError('Projection is not a value input.');
    record.set(value);
  };

  const updateInput = <K extends string, V>(
    target: Input<ReadonlyMap<K, V>, CollectionChange<K, V>>,
    run: (draft: KeyedDraft<K, V>) => void,
    requester?: ScopeState
  ): void => {
    materialize(target as Projection<unknown, unknown>, requester);
    const record = materialized.get(target);
    if (record?.kind !== 'collection-input')
      throw new TypeError('Projection is not a collection input.');
    record.update(run as Parameters<typeof record.update>[0]);
  };

  const createScope = (): ProjectionScope => {
    runtime.assertIdle();
    const state: ScopeState = {
      active: true,
      materialized: [],
      subscriptions: new Set(),
    };
    scopes.add(state);
    const assertActive = () => {
      if (!state.active) throw new ProjectionDisposedError();
    };
    const own = <P extends Projection<unknown, unknown>>(projection: P): P => {
      assertActive();
      const definition = definitionOf(projection);
      const dependencies =
        definition.kind === 'derive'
          ? definition.dependencies
          : definition.kind === 'incremental-value' || definition.kind === 'incremental-collection'
            ? Object.values(definition.dependencies)
            : definition.kind === 'incremental-group-output'
              ? Object.values(definition.group.dependencies)
              : [];
      for (const dependency of dependencies) {
        const dependencyOwner = ownerOf(dependency as Projection<unknown, unknown>);
        if (dependencyOwner && dependencyOwner !== state)
          throw new TypeError('A scope cannot depend on another scope.');
      }
      ownDefinition(projection, state);
      return projection;
    };
    const scopedInput: typeof input = Object.assign(
      <T>(initial: T, equality?: (previous: T, next: T) => boolean) =>
        own(input(initial, equality)),
      {
        collection: <K extends string, V>(initial?: ReadonlyMap<K, V>) =>
          own(input.collection(initial)),
      }
    );
    const scopedDerive: typeof derive = (dependencies, compute, equality) =>
      own(derive(dependencies, compute, equality));
    const ownOutputTree = <T>(tree: T): T => {
      if (isProjection(tree)) return own(tree as never) as T;
      if (!tree || typeof tree !== 'object')
        throw new TypeError('Incremental group output tree must be an object.');
      for (const value of Object.values(tree as Record<string, unknown>)) ownOutputTree(value);
      return tree;
    };
    const scopedIncremental: typeof incremental = Object.assign(
      <const D extends readonly Projection<unknown, unknown>[], T>(
        dependencies: D,
        processor: IncrementalValueProcessor<D, T>
      ) => own(incremental(dependencies, processor)),
      {
        collection: <const D extends readonly Projection<unknown, unknown>[], K extends string, V>(
          dependencies: D,
          processor: IncrementalCollectionProcessor<D, K, V>
        ) => own(incremental.collection(dependencies, processor)),
        group: <
          const D extends readonly Projection<unknown, unknown>[],
          const O extends IncrementalGroupOutputTree,
        >(
          dependencies: D,
          defineOutputs: (define: IncrementalGroupDefine) => O,
          processor: IncrementalGroupProcessor<D, O>
        ) => ownOutputTree(incremental.group(dependencies, defineOutputs, processor)),
      }
    );
    function scopeReadable<T>(projection: Projection<T, unknown>): Readable<T>;
    function scopeReadable<T, R>(
      projection: Projection<T, unknown>,
      selector: (value: T) => R,
      equality?: (previous: R, next: R) => boolean
    ): Readable<R>;
    function scopeReadable<T, R>(
      projection: Projection<T, unknown>,
      selector?: (value: T) => R,
      equality?: (previous: R, next: R) => boolean
    ): Readable<T | R> {
      assertActive();
      materialize(projection, state);
      const source = makeReadable(projection, selector, equality, state);
      return Object.freeze({
        current: () => {
          assertActive();
          return source.current();
        },
        revision: () => {
          assertActive();
          return source.revision();
        },
        subscribe: (listener: () => void) => {
          assertActive();
          const stop = source.subscribe(listener);
          let subscribed = true;
          const unsubscribe = () => {
            if (!subscribed) return;
            subscribed = false;
            state.subscriptions.delete(unsubscribe);
            stop();
          };
          state.subscriptions.add(unsubscribe);
          return unsubscribe;
        },
      });
    }
    function scopeBatch<T>(run: () => T): T;
    function scopeBatch<T>(options: { readonly cause?: unknown }, run: () => T): T;
    function scopeBatch<T>(
      optionsOrCallback: { readonly cause?: unknown } | (() => T),
      maybeCallback?: () => T
    ): T {
      assertActive();
      return typeof optionsOrCallback === 'function'
        ? runtime.batch(optionsOrCallback)
        : runtime.batch(optionsOrCallback, maybeCallback!);
    }
    return Object.freeze({
      input: scopedInput,
      derive: scopedDerive,
      incremental: scopedIncremental,
      get: <T>(projection: Projection<T, unknown>) => {
        assertActive();
        return get(projection, state);
      },
      readable: scopeReadable,
      set: <T>(target: Input<T>, value: T) => {
        assertActive();
        setInput(target, value, state);
      },
      update: <K extends string, V>(
        target: Input<ReadonlyMap<K, V>, CollectionChange<K, V>>,
        run: (draft: KeyedDraft<K, V>) => void
      ) => {
        assertActive();
        updateInput(target, run, state);
      },
      batch: scopeBatch,
      dispose: () => {
        if (!state.active) return;
        runtime.assertIdle();
        state.active = false;
        state.subscriptions.forEach(unsubscribe => unsubscribe());
        for (const definition of state.materialized.reverse()) {
          const group = groups.get(definition);
          if (group) {
            runtime.releaseNode(group.nodes[0]);
            groups.delete(definition);
            group.definition.projections.forEach(projection => materialized.delete(projection));
            continue;
          }
          const record = materialized.get(definition);
          if (!record) continue;
          runtime.releaseNode(record.node);
          if (record.kind !== 'projection') runtime.releaseInput(record.source);
          materialized.delete(definition);
        }
        state.materialized.length = 0;
        scopes.delete(state);
      },
    });
  };

  const store: ProjectionRuntime = {
    get,
    readable,
    set: setInput,
    update: updateInput,
    batch: runtime.batch,
    scope: createScope,
    dispose: () => {
      if (disposed) return;
      runtime.assertIdle();
      disposed = true;
      for (const scope of scopes) {
        scope.active = false;
        scope.subscriptions.forEach(unsubscribe => unsubscribe());
        scope.subscriptions.clear();
        scope.materialized.length = 0;
      }
      scopes.clear();
      runtime.dispose();
    },
  };
  return Object.freeze(store);
};
