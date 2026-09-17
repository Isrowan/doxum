import type { Unsubscribe } from '../runtime/contract';
import {
  incremental,
  type IncrementalCollectionProcessor,
  type IncrementalGroupDefine,
  type IncrementalGroupOutputTree,
  type IncrementalGroupProcessor,
  type IncrementalValueProcessor,
} from './advanced';
import { collectionView, mapRead, snapshotCollectionView } from './collection-output';
import type { CollectionChange, CollectionRead } from './contract';
import { ProjectionDisposedError } from './contract';
import {
  derive,
  input,
  isProjection,
  ownProjection,
  producerOf,
  projectionRef,
  type Input,
  type ProducerDefinition,
  type Projection,
} from './definition';
import { createProcessor } from './processor';
import {
  createDirectReadable,
  createSelectorReadable,
  isMapLike,
  type ProjectionReadableSource,
} from './projection-readable';
import type { Readable } from './readable';
import { createScheduler, type OutputRecord, type ProducerRecord } from './scheduler';
import { createSourceRegistry, type KeyedInputDraft, type SourceWrite } from './source';

type KeyedDraft<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  remove(key: K): void;
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

type MaterializedProducer = {
  readonly record: ProducerRecord;
  readonly outputs: readonly OutputRecord[];
  readonly write?: SourceWrite;
};

type ScopeState = {
  active: boolean;
  readonly materialized: ProducerDefinition[];
  readonly subscriptions: Set<Unsubscribe>;
};

export const createProjectionRuntime = (options?: {
  readonly onError?: (error: import('./contract').ProjectionError) => void;
}): ProjectionRuntime => {
  const scheduler = createScheduler(options?.onError ?? (() => undefined));
  const sources = createSourceRegistry(scheduler);
  const materialized = new WeakMap<ProducerDefinition, MaterializedProducer>();
  const publicViews = new WeakMap<
    OutputRecord,
    { readonly revision: number; readonly value: ReadonlyMap<string, unknown> }
  >();
  const scopes = new Set<ScopeState>();

  const assertAccess = (definition: ProducerDefinition, requester?: ScopeState): void => {
    scheduler.assertActive();
    const owner = definition.owner;
    if (owner === undefined) return;
    if (owner !== requester) throw new TypeError('Projection belongs to another scope.');
    if (!requester?.active) throw new ProjectionDisposedError();
  };

  const rememberScoped = (
    definition: ProducerDefinition,
    requester: ScopeState | undefined
  ): void => {
    if (requester && definition.owner === requester) requester.materialized.push(definition);
  };

  const materializeProducer = (
    definition: ProducerDefinition,
    requester?: ScopeState
  ): MaterializedProducer => {
    assertAccess(definition, requester);
    const existing = materialized.get(definition);
    if (existing) return existing;

    let result: MaterializedProducer;
    if (definition.kind === 'source') {
      const source = sources.materialize(definition);
      result = Object.freeze({
        record: source.producer,
        outputs: Object.freeze([source.output]),
        ...(source.write ? { write: source.write } : {}),
      });
    } else {
      if (
        definition.owner === undefined &&
        definition.dependencies.some(dependency => producerOf(dependency).owner !== undefined)
      )
        throw new TypeError('A root projection cannot depend on a scoped projection.');
      const dependencies = definition.dependencies.map(dependency =>
        resolveOutput(dependency, requester)
      );
      const processor = createProcessor(scheduler, definition, Object.freeze(dependencies));
      result = Object.freeze({
        record: processor,
        outputs: processor.outputs,
      });
    }

    materialized.set(definition, result);
    rememberScoped(definition, requester);
    return result;
  };

  const resolveOutput = (
    projection: Projection<unknown, unknown>,
    requester?: ScopeState
  ): OutputRecord => {
    const ref = projectionRef(projection);
    const producer = materializeProducer(ref.producer, requester);
    const output = producer.outputs[ref.output];
    if (!output) throw new TypeError('Projection output does not exist.');
    return output;
  };

  const assertOutput = (output: OutputRecord): void => {
    scheduler.assertActive();
    if (output.owner.disposed) throw new ProjectionDisposedError();
    if (output.owner.fault) throw output.owner.fault;
  };

  const publicCurrent = (output: OutputRecord): unknown => {
    assertOutput(output);
    const current = output.current();
    const revision = output.revision();
    const cached = publicViews.get(output);
    if (cached?.revision === revision) return cached.value;

    if (output.kind === 'collection') {
      const value = collectionView(current as CollectionRead<string, unknown>);
      publicViews.set(output, { revision, value });
      return value;
    }
    if (isMapLike(current)) {
      const value = snapshotCollectionView(mapRead(current));
      publicViews.set(output, { revision, value });
      return value;
    }
    publicViews.delete(output);
    return current;
  };

  const get = <T>(projection: Projection<T, unknown>, requester?: ScopeState): T =>
    publicCurrent(resolveOutput(projection as Projection<unknown, unknown>, requester)) as T;

  const readableSource = <T>(
    projection: Projection<T, unknown>,
    requester?: ScopeState
  ): ProjectionReadableSource<T> => {
    const output = resolveOutput(projection as Projection<unknown, unknown>, requester);
    return Object.freeze({
      kind: output.kind,
      current: () => get(projection, requester),
      revision: () => {
        assertOutput(output);
        return output.revision();
      },
      subscribe: output.subscribe,
    });
  };

  const makeReadable = <T, R>(
    projection: Projection<T, unknown>,
    selector?: (value: T) => R,
    equality?: (previous: R, next: R) => boolean,
    requester?: ScopeState
  ): Readable<T | R> => {
    const source = readableSource(projection, requester);
    return selector
      ? createSelectorReadable(source, selector, equality)
      : createDirectReadable(source);
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

  const inputWrite = (
    target: Projection<unknown, unknown>,
    requester?: ScopeState
  ): SourceWrite => {
    const ref = projectionRef(target);
    if (ref.output !== 0 || ref.producer.kind !== 'source')
      throw new TypeError('Projection is not an input.');
    if (
      ref.producer.source.kind !== 'value-input' &&
      ref.producer.source.kind !== 'collection-input'
    )
      throw new TypeError('Projection is not an input.');
    const write = materializeProducer(ref.producer, requester).write;
    if (!write) throw new TypeError('Projection input is not writable.');
    return write;
  };

  const setInput = <T>(target: Input<T>, value: T, requester?: ScopeState): void => {
    const write = inputWrite(target as Projection<unknown, unknown>, requester);
    if (write.kind !== 'value') throw new TypeError('Projection is not a value input.');
    write.set(value);
  };

  const updateInput = <K extends string, V>(
    target: Input<ReadonlyMap<K, V>, CollectionChange<K, V>>,
    run: (draft: KeyedDraft<K, V>) => void,
    requester?: ScopeState
  ): void => {
    const write = inputWrite(target as Projection<unknown, unknown>, requester);
    if (write.kind !== 'collection') throw new TypeError('Projection is not a collection input.');
    write.update(run as (draft: KeyedInputDraft<string, unknown>) => void);
  };

  function batch<T>(run: () => T): T;
  function batch<T>(options: { readonly cause?: unknown }, run: () => T): T;
  function batch<T>(
    optionsOrCallback: { readonly cause?: unknown } | (() => T),
    maybeCallback?: () => T
  ): T {
    return typeof optionsOrCallback === 'function'
      ? scheduler.batch(optionsOrCallback)
      : scheduler.batch(optionsOrCallback, maybeCallback);
  }

  const disposeScope = (state: ScopeState): void => {
    if (!state.active) return;
    scheduler.assertIdle();
    state.active = false;
    state.subscriptions.forEach(unsubscribe => unsubscribe());
    state.subscriptions.clear();
    for (let index = state.materialized.length - 1; index >= 0; index--) {
      const definition = state.materialized[index];
      const current = materialized.get(definition);
      if (!current) continue;
      scheduler.releaseProducer(current.record);
      materialized.delete(definition);
    }
    state.materialized.length = 0;
    scopes.delete(state);
  };

  const createScope = (): ProjectionScope => {
    scheduler.assertIdle();
    const state: ScopeState = {
      active: true,
      materialized: [],
      subscriptions: new Set(),
    };
    scopes.add(state);

    const assertActive = () => {
      if (!state.active) throw new ProjectionDisposedError();
      scheduler.assertActive();
    };
    const own = <P extends Projection<unknown, unknown>>(projection: P): P => {
      assertActive();
      return ownProjection(projection, state);
    };
    const ownOutputTree = <T>(tree: T): T => {
      if (isProjection(tree)) return own(tree as Projection<unknown, unknown>) as T;
      if (!tree || typeof tree !== 'object')
        throw new TypeError('Incremental group output tree must be an object.');
      for (const value of Object.values(tree as Record<string, unknown>)) ownOutputTree(value);
      return tree;
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
        subscribe: listener => {
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
        ? batch(optionsOrCallback)
        : batch(optionsOrCallback, maybeCallback!);
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
      dispose: () => disposeScope(state),
    });
  };

  return Object.freeze({
    get,
    readable,
    set: setInput,
    update: updateInput,
    batch,
    scope: createScope,
    dispose: () => {
      if (!scheduler.active) return;
      scheduler.assertIdle();
      for (const scope of scopes) {
        scope.active = false;
        scope.subscriptions.forEach(unsubscribe => unsubscribe());
        scope.subscriptions.clear();
        scope.materialized.length = 0;
      }
      scopes.clear();
      sources.dispose();
      scheduler.dispose();
    },
  });
};
