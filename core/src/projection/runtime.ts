import type { Unsubscribe } from '../runtime/contract';
import { collectionView, mapRead, snapshotCollectionView } from './collection/view';
import type { CollectionRead } from './contract';
import { ProjectionDisposedError } from './contract';
import {
  isProjection,
  ownProjections,
  producerOf,
  projectionRef,
  type CollectionInput,
  type CollectionInputDraft,
  type Input,
  type ProducerDefinition,
  type Projection,
} from './definition';
import { isPlainObject } from '../value/record';
import { createProcessor } from './graph/processor';
import {
  createDirectReadable,
  createSelectorReadable,
  isMapLike,
  type ProjectionReadableSource,
} from './readable/selection';
import type { Readable } from '../readable';
import { createScheduler, type OutputRecord, type ProducerRecord } from './graph/scheduler';
import { createSourceRegistry } from './source/registry';
import type { SourceWrite } from './source/boundary';

export type ProjectionRuntime = {
  read<T>(projection: Projection<T>): T;
  select<T>(projection: Projection<T>): Readable<T>;
  select<T, R>(
    projection: Projection<T>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  update<T>(input: Input<T>, value: T): void;
  update<K extends string, V>(
    input: CollectionInput<K, V>,
    run: (draft: CollectionInputDraft<K, V>) => void
  ): void;
  batch<T>(run: () => T, options?: { readonly cause?: unknown }): T;
  scope(): ProjectionScope;
  dispose(): void;
};

type ProjectionOwnershipTree = {
  readonly [name: string]: Projection<unknown> | ProjectionOwnershipTree;
};

export type ProjectionScope = {
  own<P extends Projection<unknown>>(projection: P): P;
  own<T extends ProjectionOwnershipTree>(tree: T): T;
  read<T>(projection: Projection<T>): T;
  select<T>(projection: Projection<T>): Readable<T>;
  select<T, R>(
    projection: Projection<T>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  update<T>(input: Input<T>, value: T): void;
  update<K extends string, V>(
    input: CollectionInput<K, V>,
    run: (draft: CollectionInputDraft<K, V>) => void
  ): void;
  batch<T>(run: () => T, options?: { readonly cause?: unknown }): T;
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

    definition.materialized = true;
    materialized.set(definition, result);
    rememberScoped(definition, requester);
    return result;
  };

  const resolveOutput = (projection: Projection<unknown>, requester?: ScopeState): OutputRecord => {
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

  const readProjection = <T>(projection: Projection<T>, requester?: ScopeState): T =>
    publicCurrent(resolveOutput(projection as Projection<unknown>, requester)) as T;

  const readableSource = <T>(
    projection: Projection<T>,
    requester?: ScopeState
  ): ProjectionReadableSource<T> => {
    const output = resolveOutput(projection as Projection<unknown>, requester);
    return Object.freeze({
      kind: output.kind,
      current: () => readProjection(projection, requester),
      revision: () => {
        assertOutput(output);
        return output.revision();
      },
      subscribe: output.subscribe,
    });
  };

  const makeReadable = <T, R>(
    projection: Projection<T>,
    selector?: (value: T) => R,
    equality?: (previous: R, next: R) => boolean,
    requester?: ScopeState
  ): Readable<T | R> => {
    const source = readableSource(projection, requester);
    return selector
      ? createSelectorReadable(source, selector, equality)
      : createDirectReadable(source);
  };

  function selectProjection<T>(projection: Projection<T>): Readable<T>;
  function selectProjection<T, R>(
    projection: Projection<T>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  function selectProjection<T, R>(
    projection: Projection<T>,
    selector?: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<T | R> {
    return makeReadable(projection, selector, equality);
  }

  const inputWrite = (target: Projection<unknown>, requester?: ScopeState): SourceWrite => {
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

  const updateInput = (
    target: Projection<unknown>,
    valueOrRun: unknown,
    requester?: ScopeState
  ): void => {
    const write = inputWrite(target, requester);
    if (write.kind === 'value') {
      write.set(valueOrRun);
      return;
    }
    if (typeof valueOrRun !== 'function')
      throw new TypeError('Collection input update requires a draft callback.');
    write.update(valueOrRun as (draft: CollectionInputDraft<string, unknown>) => void);
  };

  function update<T>(target: Input<T>, value: T): void;
  function update<K extends string, V>(
    target: CollectionInput<K, V>,
    run: (draft: CollectionInputDraft<K, V>) => void
  ): void;
  function update(target: Projection<unknown>, valueOrRun: unknown): void {
    updateInput(target, valueOrRun);
  }

  const batch = <T>(run: () => T, options?: { readonly cause?: unknown }): T =>
    scheduler.batch(run, options);

  const disposeScope = (state: ScopeState): void => {
    if (!state.active) return;
    scheduler.assertIdle();
    state.active = false;
    const failures: unknown[] = [];
    const subscriptions = [...state.subscriptions];
    state.subscriptions.clear();
    for (const unsubscribe of subscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        failures.push(error);
      }
    }
    for (let index = state.materialized.length - 1; index >= 0; index--) {
      const definition = state.materialized[index];
      const current = materialized.get(definition);
      if (!current) continue;
      try {
        scheduler.releaseProducer(current.record);
      } catch (error) {
        failures.push(error);
      } finally {
        materialized.delete(definition);
      }
    }
    state.materialized.length = 0;
    scopes.delete(state);
    if (failures.length) throw failures[0];
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
    function own<P extends Projection<unknown>>(projection: P): P;
    function own<T extends ProjectionOwnershipTree>(tree: T): T;
    function own<T extends Projection<unknown> | ProjectionOwnershipTree>(target: T): T {
      assertActive();
      const projections: Projection<unknown>[] = [];
      const collect = (value: Projection<unknown> | ProjectionOwnershipTree): void => {
        if (isProjection(value)) {
          projections.push(value);
          return;
        }
        if (!isPlainObject(value))
          throw new TypeError('Projection ownership tree must be a plain object.');
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string')
            throw new TypeError('Projection ownership tree keys must be strings.');
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor?.enumerable || !('value' in descriptor))
            throw new TypeError('Projection ownership tree must use enumerable data properties.');
          const child = descriptor.value;
          if (!isProjection(child) && !isPlainObject(child))
            throw new TypeError('Projection ownership tree leaves must be projections.');
          collect(child as Projection<unknown> | ProjectionOwnershipTree);
        }
      };
      collect(target);
      if (!projections.length)
        throw new TypeError('Projection ownership tree must contain a projection.');
      ownProjections(projections, state);
      return target;
    }

    function scopeSelect<T>(projection: Projection<T>): Readable<T>;
    function scopeSelect<T, R>(
      projection: Projection<T>,
      selector: (value: T) => R,
      equality?: (previous: R, next: R) => boolean
    ): Readable<R>;
    function scopeSelect<T, R>(
      projection: Projection<T>,
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

    function scopeUpdate<T>(target: Input<T>, value: T): void;
    function scopeUpdate<K extends string, V>(
      target: CollectionInput<K, V>,
      run: (draft: CollectionInputDraft<K, V>) => void
    ): void;
    function scopeUpdate(target: Projection<unknown>, valueOrRun: unknown): void {
      assertActive();
      updateInput(target, valueOrRun, state);
    }

    function scopeBatch<T>(run: () => T, options?: { readonly cause?: unknown }): T {
      assertActive();
      return batch(run, options);
    }

    return Object.freeze({
      own,
      read: <T>(projection: Projection<T>) => {
        assertActive();
        return readProjection(projection, state);
      },
      select: scopeSelect,
      update: scopeUpdate,
      batch: scopeBatch,
      dispose: () => disposeScope(state),
    });
  };

  return Object.freeze({
    read: readProjection,
    select: selectProjection,
    update,
    batch,
    scope: createScope,
    dispose: () => {
      if (!scheduler.active) return;
      scheduler.assertIdle();
      const failures: unknown[] = [];
      for (const scope of scopes) {
        scope.active = false;
        const subscriptions = [...scope.subscriptions];
        scope.subscriptions.clear();
        for (const unsubscribe of subscriptions) {
          try {
            unsubscribe();
          } catch (error) {
            failures.push(error);
          }
        }
        scope.materialized.length = 0;
      }
      scopes.clear();
      try {
        sources.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        scheduler.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Projection cleanup failed.');
    },
  });
};
