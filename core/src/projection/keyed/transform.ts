import type { CollectionRead, SourceContext } from '../contract';
import { defineProcessor, type KeyedProjection } from '../definition';
import { assertSynchronous } from '../graph/scheduler';
import {
  assertKeyedProjection,
  compileKeyedDependencies,
  createKeyedDependencyRuntime,
  type KeyedDependencyRecord,
} from './dependency';

export const keyedAbsent = Symbol('keyed-transform-absent');
export type KeyedTransformResult<T> = T | typeof keyedAbsent;

export type KeyedTransformContext<K extends string, V, State> = {
  readonly key: K;
  readonly value: V;
  readonly dependencies: Readonly<Record<string, unknown>>;
  readonly state: State;
  readonly reset: boolean;
  readonly cause: unknown;
};

export type KeyedTransformDefinition<K extends string, V, T, State> = {
  readonly source: KeyedProjection<K, V>;
  readonly dependencies?: KeyedDependencyRecord<K, V>;
  readonly equality?: (previous: T, next: T) => boolean;
  readonly name: string;
  readonly state?: (value: V, key: K) => State;
  readonly evaluate: (context: KeyedTransformContext<K, V, State>) => KeyedTransformResult<T>;
};

/** Shared driver-keyed lifecycle for pure and retained keyed transforms. */
export const createKeyedTransform = <K extends string, V, T, State = undefined>(
  definition: KeyedTransformDefinition<K, V, T, State>
): KeyedProjection<K, T> => {
  assertKeyedProjection(definition.source, `${definition.name} source`);
  const compiled = compileKeyedDependencies(
    definition.source,
    definition.dependencies as KeyedDependencyRecord<string, unknown> | undefined,
    definition.name
  );
  const [projection] = defineProcessor({
    dependencies: compiled.projections,
    outputs: [
      {
        kind: 'collection',
        equality: (definition.equality ?? Object.is) as (
          previous: unknown,
          next: unknown
        ) => boolean,
      },
    ],
    create: () => {
      const dependencies = createKeyedDependencyRuntime(compiled);
      const states = new Map<string, State>();

      const dropState = (key: string): void => {
        states.delete(key);
        dependencies.remove(key);
      };

      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error(`${definition.name} requires collection input and output.`);
          dependencies.prepare(evaluation.sources, evaluation.reset);

          const stateFor = (key: string, value: V): State => {
            if (states.has(key)) return states.get(key) as State;
            const state = definition.state
              ? definition.state(value, key as K)
              : (undefined as State);
            assertSynchronous(state);
            if (definition.state) states.set(key, state);
            return state;
          };

          const project = (key: string): boolean => {
            if (!driver.read.has(key)) return false;
            const value = driver.read.get(key) as V;
            const beforePresent = output.previous.has(key);
            const next = definition.evaluate({
              key: key as K,
              value,
              dependencies: dependencies.resolve(value, key, evaluation.sources),
              state: stateFor(key, value),
              reset: evaluation.reset,
              cause: evaluation.cause,
            });
            assertSynchronous(next);
            if (next === keyedAbsent) output.output.remove(key);
            else output.output.set(key, next);
            return beforePresent !== output.next.has(key);
          };

          if (evaluation.reset) {
            dependencies.clearBindings();
            const ids = driver.read.ids();
            const present = new Set(ids);
            for (const key of [...states.keys()]) if (!present.has(key)) states.delete(key);
            for (const key of ids) project(key);
            output.output.order(ids.filter(key => output.next.has(key)));
            dependencies.remember(evaluation.sources);
            return;
          }

          const dirty = new Set<string>();
          let all = false;
          let updateOrder = false;
          let membershipChanged = false;
          if (dependencies.driverChanged(driver)) {
            const change = driver.change;
            if (!change || change.kind === 'reset') {
              all = true;
              updateOrder = true;
              for (const key of output.previous.ids()) {
                if (driver.read.has(key)) continue;
                output.output.remove(key);
                dropState(key);
                membershipChanged = true;
              }
            } else {
              for (const entry of change.removed) {
                membershipChanged ||= output.previous.has(entry.key);
                output.output.remove(entry.key);
                dropState(entry.key);
                dirty.delete(entry.key);
              }
              for (const entry of change.added) dirty.add(entry.key);
              for (const entry of change.updated) dirty.add(entry.key);
              updateOrder = Boolean(change.order);
            }
          }

          all ||= dependencies.collectInvalidated(evaluation.sources, dirty);
          if (all) for (const key of driver.read.ids()) dirty.add(key);
          for (const key of dirty) {
            const changedMembership = project(key);
            membershipChanged ||= changedMembership;
          }
          if (updateOrder || membershipChanged)
            output.output.order(driver.read.ids().filter(key => output.next.has(key)));
          dependencies.remember(evaluation.sources);
        },
        release: () => {
          states.clear();
          dependencies.release();
        },
      };
    },
    name: definition.name,
  });
  return projection as KeyedProjection<K, T>;
};
