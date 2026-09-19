import type { Synchronous } from '../runtime/contract';
import { snapshotCollectionView } from './collection/view';
import type { CollectionChange, SourceContext } from './contract';
import {
  defineProcessor,
  isProjection,
  projectionRef,
  type Projection,
  type ProducerDefinition,
} from './definition';
import { assertSynchronous } from './graph/scheduler';

type ProjectionValues<D extends readonly Projection<unknown, unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Projection<infer T, unknown> ? T : never;
};

type Equality<T> = (previous: T, next: T) => boolean;
type KeyedProjection<K extends string, V> = Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>;

/** A declared dynamic lookup from one driver entry to one key in another keyed projection. */
export type KeyedDependency<
  DriverKey extends string,
  DriverValue,
  SourceKey extends string = string,
  SourceValue = unknown,
> = {
  readonly source: KeyedProjection<SourceKey, SourceValue>;
  readonly key: (value: DriverValue, key: DriverKey) => Synchronous<SourceKey | undefined>;
};

type KeyedDeriveDependency<K extends string, V> =
  Projection<unknown, unknown> | KeyedDependency<K, V, string, unknown>;

type KeyedDependencyValues<D extends readonly unknown[]> = {
  readonly [I in keyof D]: D[I] extends {
    readonly source: Projection<
      ReadonlyMap<infer _K extends string, infer V>,
      CollectionChange<infer _K extends string, infer V>
    >;
  }
    ? V | undefined
    : D[I] extends Projection<infer T, unknown>
      ? T
      : never;
};

type RuntimeKeyedDependency = {
  readonly source: Projection<unknown, unknown>;
  readonly key: (value: unknown, key: string) => unknown;
};

type BindingIndex = {
  readonly forward: Map<string, string>;
  readonly reverse: Map<string, Set<string>>;
};

const sourceValue = (source: SourceContext): unknown =>
  source.kind === 'value' ? source.value : snapshotCollectionView(source.read);

const outputKind = (projection: Projection<unknown, unknown>): 'value' | 'collection' => {
  const ref = projectionRef(projection);
  const definition: ProducerDefinition = ref.producer;
  const output = definition.kind === 'source' ? definition.output : definition.outputs[ref.output];
  if (!output) throw new TypeError('Projection output does not exist.');
  return output.kind;
};

const assertKeyedProjection = (projection: Projection<unknown, unknown>, role: string): void => {
  if (outputKind(projection) !== 'collection')
    throw new TypeError(`${role} must be a keyed collection projection.`);
};

const isKeyedDependency = (value: unknown): value is RuntimeKeyedDependency => {
  if (!value || typeof value !== 'object' || isProjection(value)) return false;
  const candidate = value as { readonly source?: unknown; readonly key?: unknown };
  return isProjection(candidate.source) && typeof candidate.key === 'function';
};

const bindKey = (index: BindingIndex, outputKey: string, sourceKey: string | undefined): void => {
  const previous = index.forward.get(outputKey);
  if (previous === sourceKey) return;
  if (previous !== undefined) {
    const dependents = index.reverse.get(previous);
    dependents?.delete(outputKey);
    if (dependents?.size === 0) index.reverse.delete(previous);
    index.forward.delete(outputKey);
  }
  if (sourceKey === undefined) return;
  index.forward.set(outputKey, sourceKey);
  const dependents = index.reverse.get(sourceKey);
  if (dependents) dependents.add(outputKey);
  else index.reverse.set(sourceKey, new Set([outputKey]));
};

const unbindKey = (indexes: readonly BindingIndex[], outputKey: string): void => {
  for (const index of indexes) bindKey(index, outputKey, undefined);
};

const createBindingIndex = (): BindingIndex => ({ forward: new Map(), reverse: new Map() });

function createValueDerive<const D extends readonly Projection<unknown, unknown>[], T>(
  dependencies: D,
  compute: (...values: ProjectionValues<D>) => Synchronous<T>,
  equality: Equality<T> = Object.is
): Projection<T> {
  const [projection] = defineProcessor({
    dependencies,
    outputs: [{ kind: 'value', equality: equality as Equality<unknown> }],
    create: () => ({
      evaluate: evaluation => {
        const output = evaluation.outputs[0];
        if (output.kind !== 'value') throw new Error('derive requires a value output.');
        const next = compute(...(evaluation.sources.map(sourceValue) as ProjectionValues<D>));
        assertSynchronous(next);
        output.output.set(next);
      },
    }),
  });
  return projection as Projection<T>;
}

export function createKeyedDerive<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  select: (value: V, key: K) => Synchronous<T>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
export function createKeyedDerive<
  K extends string,
  V,
  const D extends readonly KeyedDeriveDependency<K, V>[],
  T,
>(
  source: KeyedProjection<K, V>,
  dependencies: D,
  select: (value: V, key: K, ...dependencies: KeyedDependencyValues<D>) => Synchronous<T>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
export function createKeyedDerive<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  dependenciesOrSelect:
    readonly KeyedDeriveDependency<K, V>[] | ((value: V, key: K) => Synchronous<T>),
  selectOrEquality?:
    ((value: V, key: K, ...dependencies: readonly unknown[]) => Synchronous<T>) | Equality<T>,
  maybeEquality?: Equality<T>
): KeyedProjection<K, T> {
  assertKeyedProjection(source, 'Keyed derive source');
  const dependencySpecs = Array.isArray(dependenciesOrSelect) ? dependenciesOrSelect : [];
  const select = (
    Array.isArray(dependenciesOrSelect) ? selectOrEquality : dependenciesOrSelect
  ) as (value: V, key: K, ...dependencies: readonly unknown[]) => Synchronous<T>;
  const equality = (Array.isArray(dependenciesOrSelect) ? maybeEquality : selectOrEquality) as
    Equality<T> | undefined;
  if (typeof select !== 'function') throw new TypeError('Keyed derive requires a selector.');

  const dependencies: Projection<unknown, unknown>[] = [source];
  const keyed: Array<RuntimeKeyedDependency | undefined> = [];
  for (const dependency of dependencySpecs) {
    if (isProjection(dependency)) {
      dependencies.push(dependency);
      keyed.push(undefined);
      continue;
    }
    if (!isKeyedDependency(dependency))
      throw new TypeError('Keyed derive dependencies must be projections or keyed lookups.');
    assertKeyedProjection(dependency.source, 'Dynamic keyed dependency source');
    dependencies.push(dependency.source);
    keyed.push(dependency);
  }

  const [projection] = defineProcessor({
    dependencies,
    outputs: [{ kind: 'collection', equality: (equality ?? Object.is) as Equality<unknown> }],
    create: () => {
      const bindings = keyed.map(dependency => (dependency ? createBindingIndex() : undefined));
      const bindingIndexes = bindings.filter((index): index is BindingIndex => index !== undefined);
      const globalValues: unknown[] = keyed.map(() => undefined);
      let revisions: readonly number[] = Object.freeze([]);

      const clearBindings = (): void => {
        for (const index of bindings) {
          index?.forward.clear();
          index?.reverse.clear();
        }
      };

      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error('Keyed derive requires collection input and output.');
          const currentRevisions = evaluation.sources.map(current => current.revision);
          for (let index = 0; index < keyed.length; index++) {
            if (keyed[index]) continue;
            if (evaluation.reset || revisions[index + 1] !== currentRevisions[index + 1])
              globalValues[index] = sourceValue(evaluation.sources[index + 1]);
          }

          const project = (key: string): void => {
            if (!driver.read.has(key)) return;
            const value = driver.read.get(key) as V;
            const dependencyValues = keyed.map((dependency, index) => {
              if (!dependency) return globalValues[index];
              const sourceContext = evaluation.sources[index + 1];
              if (sourceContext.kind !== 'collection')
                throw new TypeError(
                  'Dynamic keyed dependency resolved to a non-collection source.'
                );
              const selectedKey = dependency.key(value, key);
              assertSynchronous(selectedKey);
              if (selectedKey !== undefined && typeof selectedKey !== 'string')
                throw new TypeError('Dynamic keyed dependency keys must be strings or undefined.');
              bindKey(bindings[index]!, key, selectedKey);
              return selectedKey === undefined ? undefined : sourceContext.read.get(selectedKey);
            });
            const next = select(value, key as K, ...dependencyValues);
            assertSynchronous(next);
            output.output.set(key, next);
          };

          if (evaluation.reset) {
            clearBindings();
            const ids = driver.read.ids();
            for (const key of ids) project(key);
            output.output.order(ids);
            revisions = Object.freeze(currentRevisions);
            return;
          }

          const dirty = new Set<string>();
          let all = false;
          let updateOrder = false;
          const driverChanged = revisions[0] !== currentRevisions[0];
          if (driverChanged) {
            const change = driver.change;
            if (!change || change.kind === 'reset') {
              all = true;
              updateOrder = true;
            } else {
              for (const entry of change.removed) {
                output.output.remove(entry.key);
                unbindKey(bindingIndexes, entry.key);
                dirty.delete(entry.key);
              }
              for (const entry of change.added) dirty.add(entry.key);
              for (const entry of change.updated) dirty.add(entry.key);
              updateOrder = Boolean(change.added.length || change.removed.length || change.order);
            }
          }

          for (let index = 0; index < keyed.length; index++) {
            if (revisions[index + 1] === currentRevisions[index + 1]) continue;
            const dependency = keyed[index];
            if (!dependency) {
              all = true;
              continue;
            }
            const sourceContext = evaluation.sources[index + 1];
            if (sourceContext.kind !== 'collection' || !sourceContext.change) {
              all = true;
              continue;
            }
            if (sourceContext.change.kind === 'reset') {
              all = true;
              continue;
            }
            const reverse = bindings[index]!.reverse;
            for (const transition of sourceContext.change.added) {
              for (const outputKey of reverse.get(transition.key) ?? []) dirty.add(outputKey);
            }
            for (const transition of sourceContext.change.updated) {
              for (const outputKey of reverse.get(transition.key) ?? []) dirty.add(outputKey);
            }
            for (const transition of sourceContext.change.removed) {
              for (const outputKey of reverse.get(transition.key) ?? []) dirty.add(outputKey);
            }
          }

          if (all) for (const key of driver.read.ids()) dirty.add(key);
          for (const key of dirty) if (driver.read.has(key)) project(key);
          if (updateOrder) output.output.order(driver.read.ids());
          revisions = Object.freeze(currentRevisions);
        },
        release: () => {
          clearBindings();
          revisions = Object.freeze([]);
        },
      };
    },
    name: 'derive.keyed',
  });
  return projection as KeyedProjection<K, T>;
}

export const derive = Object.assign(createValueDerive, { keyed: createKeyedDerive });
