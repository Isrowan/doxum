import type { Synchronous } from '../../runtime/contract';
import { isPlainObject } from '../../value/record';
import { collectionChange, collectionHasStructuralChange } from '../collection/change';
import type { SourceContext } from '../contract';
import { snapshotDependencyValue } from '../dependency';
import {
  defineProcessor,
  isProjection,
  outputDefinitionOf,
  type KeyedProjection,
  type Projection,
} from '../definition';
import { assertSynchronous } from '../graph/scheduler';

type Equality<T> = (previous: T, next: T) => boolean;

/** A declared dynamic lookup from one driver entry to one key in another keyed projection. */
type KeyedDependency<
  DriverKey extends string,
  DriverValue,
  SourceKey extends string = string,
  SourceValue = unknown,
> = {
  readonly source: KeyedProjection<SourceKey, SourceValue>;
  readonly key: (value: DriverValue, key: DriverKey) => Synchronous<SourceKey | undefined>;
};

type KeyedDeriveDependency<K extends string, V> =
  | (Projection<unknown> & { readonly source?: never; readonly key?: never })
  | KeyedDependency<K, V, string, unknown>;

type KeyedDeriveDependencyRecord<K extends string, V> = Readonly<
  Record<string, KeyedDeriveDependency<K, V>>
>;

type KeyedDeriveDependencies<K extends string, V, D extends object> = {
  readonly [P in keyof D]: P extends string ? KeyedDeriveDependency<K, V> : never;
};

type KeyedDependencyValues<D extends Readonly<Record<string, unknown>>> = {
  readonly [P in keyof D]: D[P] extends {
    readonly source: KeyedProjection<infer _K extends string, infer V>;
  }
    ? V | undefined
    : D[P] extends Projection<infer T>
      ? T
      : never;
};

type RuntimeKeyedDependency = {
  readonly source: Projection<unknown>;
  readonly key: (value: unknown, key: string) => unknown;
};

type BindingIndex = {
  readonly forward: Map<string, string>;
  readonly reverse: Map<string, Set<string>>;
};

const outputKind = (projection: Projection<unknown>): 'value' | 'collection' => {
  return outputDefinitionOf(projection).kind;
};

const assertKeyedProjection = (projection: Projection<unknown>, role: string): void => {
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

const unbindKey = (indexes: readonly (BindingIndex | undefined)[], outputKey: string): void => {
  for (const index of indexes) if (index) bindKey(index, outputKey, undefined);
};

const createBindingIndex = (): BindingIndex => ({ forward: new Map(), reverse: new Map() });
const emptyKeyedDependencies: Readonly<Record<string, unknown>> = Object.freeze(
  Object.create(null) as Record<string, unknown>
);

const absent = Symbol('keyed-transform-absent');
type KeyedTransformResult<T> = T | typeof absent;

const compileOrderedKeys = <K extends string>(
  value: unknown,
  role: string
): { readonly keys: readonly K[]; readonly requested: ReadonlySet<K> } => {
  if (!Array.isArray(value)) throw new TypeError(`${role} must be an array of string keys.`);
  const seen = new Set<K>();
  for (const key of value) {
    if (typeof key !== 'string') throw new TypeError(`${role} must contain only string keys.`);
    if (seen.has(key as K)) throw new TypeError(`${role} must not contain duplicate keys.`);
    seen.add(key as K);
  }
  return { keys: value as readonly K[], requested: seen };
};

const createKeyedTransform = <K extends string, V, T>(
  source: KeyedProjection<K, V>,
  dependencySpecs: KeyedDeriveDependencyRecord<K, V> | undefined,
  select: (
    value: V,
    key: K,
    dependencies: Readonly<Record<string, unknown>>
  ) => Synchronous<KeyedTransformResult<T>>,
  equality: Equality<T> | undefined,
  name: string
): KeyedProjection<K, T> => {
  assertKeyedProjection(source, 'Keyed derive source');

  const dependencies: Projection<unknown>[] = [source];
  const dependencyNames: string[] = [];
  const keyed: Array<RuntimeKeyedDependency | undefined> = [];
  if (dependencySpecs !== undefined) {
    if (!isPlainObject(dependencySpecs) || isProjection(dependencySpecs))
      throw new TypeError('Keyed derive dependencies must be a plain object.');
    for (const name of Reflect.ownKeys(dependencySpecs)) {
      if (typeof name !== 'string')
        throw new TypeError('Keyed derive dependency names must be strings.');
      const descriptor = Object.getOwnPropertyDescriptor(dependencySpecs, name);
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError('Keyed derive dependencies must be enumerable data properties.');
      const dependency = descriptor.value as KeyedDeriveDependency<K, V>;
      dependencyNames.push(name);
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
  }

  const [projection] = defineProcessor({
    dependencies,
    outputs: [{ kind: 'collection', equality: (equality ?? Object.is) as Equality<unknown> }],
    create: () => {
      const bindings = keyed.map(dependency => (dependency ? createBindingIndex() : undefined));
      const globalValues: unknown[] = keyed.map(() => undefined);
      const revisions: number[] = [];

      const clearBindings = (): void => {
        for (const index of bindings) {
          index?.forward.clear();
          index?.reverse.clear();
        }
      };
      const rememberRevisions = (sources: readonly SourceContext[]): void => {
        revisions.length = sources.length;
        for (let index = 0; index < sources.length; index++)
          revisions[index] = sources[index].revision;
      };

      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error('Keyed derive requires collection input and output.');
          for (let index = 0; index < keyed.length; index++) {
            if (keyed[index]) continue;
            const dependencySource = evaluation.sources[index + 1];
            if (evaluation.reset || revisions[index + 1] !== dependencySource.revision)
              globalValues[index] = snapshotDependencyValue(dependencySource);
          }

          const project = (key: string): void => {
            if (!driver.read.has(key)) return;
            const value = driver.read.get(key) as V;
            let dependencyValues = emptyKeyedDependencies;
            if (keyed.length) {
              const values = Object.create(null) as Record<string, unknown>;
              for (let index = 0; index < keyed.length; index++) {
                const dependency = keyed[index];
                if (!dependency) {
                  values[dependencyNames[index]] = globalValues[index];
                  continue;
                }
                const sourceContext = evaluation.sources[index + 1];
                if (sourceContext.kind !== 'collection')
                  throw new TypeError(
                    'Dynamic keyed dependency resolved to a non-collection source.'
                  );
                const selectedKey = dependency.key(value, key);
                assertSynchronous(selectedKey);
                if (selectedKey !== undefined && typeof selectedKey !== 'string')
                  throw new TypeError(
                    'Dynamic keyed dependency keys must be strings or undefined.'
                  );
                bindKey(bindings[index]!, key, selectedKey);
                values[dependencyNames[index]] =
                  selectedKey === undefined ? undefined : sourceContext.read.get(selectedKey);
              }
              dependencyValues = Object.freeze(values);
            }
            const next = select(value, key as K, dependencyValues);
            assertSynchronous(next);
            if (next === absent) output.output.remove(key);
            else output.output.set(key, next);
          };

          if (evaluation.reset) {
            clearBindings();
            const ids = driver.read.ids();
            for (const key of ids) project(key);
            output.output.order(ids.filter(key => output.next.has(key)));
            rememberRevisions(evaluation.sources);
            return;
          }

          const dirty = new Set<string>();
          let all = false;
          let updateOrder = false;
          let membershipChanged = false;
          const driverChanged = revisions[0] !== driver.revision;
          if (driverChanged) {
            const change = driver.change;
            if (!change || change.kind === 'reset') {
              all = true;
              updateOrder = true;
            } else {
              for (const entry of change.removed) {
                membershipChanged ||= output.previous.has(entry.key);
                output.output.remove(entry.key);
                unbindKey(bindings, entry.key);
                dirty.delete(entry.key);
              }
              for (const entry of change.added) dirty.add(entry.key);
              for (const entry of change.updated) dirty.add(entry.key);
              updateOrder = Boolean(change.order);
            }
          }

          for (let index = 0; index < keyed.length; index++) {
            const sourceContext = evaluation.sources[index + 1];
            if (revisions[index + 1] === sourceContext.revision) continue;
            const dependency = keyed[index];
            if (!dependency) {
              all = true;
              continue;
            }
            if (sourceContext.kind !== 'collection' || !sourceContext.change) {
              all = true;
              continue;
            }
            if (sourceContext.change.kind === 'reset') {
              all = true;
              continue;
            }
            const reverse = bindings[index]!.reverse;
            for (const sourceKey of collectionChange.keys(sourceContext.change))
              for (const outputKey of reverse.get(sourceKey) ?? []) dirty.add(outputKey);
          }

          if (all) for (const key of driver.read.ids()) dirty.add(key);
          for (const key of dirty) {
            if (!driver.read.has(key)) continue;
            const beforePresent = output.previous.has(key);
            project(key);
            membershipChanged ||= beforePresent !== output.next.has(key);
          }
          if (updateOrder || membershipChanged)
            output.output.order(driver.read.ids().filter(key => output.next.has(key)));
          rememberRevisions(evaluation.sources);
        },
        release: () => {
          clearBindings();
          revisions.length = 0;
        },
      };
    },
    name,
  });
  return projection as KeyedProjection<K, T>;
};

function createKeyedDerive<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  select: (value: V, key: K) => Synchronous<T>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
function createKeyedDerive<
  K extends string,
  V,
  const D extends object & KeyedDeriveDependencies<K, V, D>,
  T,
>(
  source: KeyedProjection<K, V>,
  dependencies: D,
  select: (value: V, key: K, dependencies: KeyedDependencyValues<D>) => Synchronous<T>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
function createKeyedDerive<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  dependenciesOrSelect: KeyedDeriveDependencyRecord<K, V> | ((value: V, key: K) => Synchronous<T>),
  selectOrEquality?:
    | ((value: V, key: K, dependencies: Readonly<Record<string, unknown>>) => Synchronous<T>)
    | Equality<T>,
  maybeEquality?: Equality<T>
): KeyedProjection<K, T> {
  const dependencySpecs =
    typeof dependenciesOrSelect === 'function' ? undefined : dependenciesOrSelect;
  const select = (dependencySpecs === undefined ? dependenciesOrSelect : selectOrEquality) as
    | ((value: V, key: K) => Synchronous<T>)
    | ((value: V, key: K, dependencies: Readonly<Record<string, unknown>>) => Synchronous<T>)
    | undefined;
  const equality = (dependencySpecs === undefined ? selectOrEquality : maybeEquality) as
    Equality<T> | undefined;
  if (typeof select !== 'function') throw new TypeError('Keyed derive requires a selector.');
  return createKeyedTransform(
    source,
    dependencySpecs,
    (value, key, dependencies) =>
      dependencySpecs === undefined
        ? (select as (value: V, key: K) => Synchronous<T>)(value, key)
        : (
            select as (
              value: V,
              key: K,
              dependencies: Readonly<Record<string, unknown>>
            ) => Synchronous<T>
          )(value, key, dependencies),
    equality,
    'derive.keyed'
  );
}

const createKeyedKeys = <K extends string, V>(
  source: KeyedProjection<K, V>
): Projection<readonly K[]> => {
  assertKeyedProjection(source, 'Keyed keys source');
  const [projection] = defineProcessor({
    dependencies: [source],
    outputs: [{ kind: 'value', equality: Object.is }],
    create: () => ({
      evaluate: evaluation => {
        const driver = evaluation.sources[0];
        const output = evaluation.outputs[0];
        if (driver.kind !== 'collection' || output.kind !== 'value')
          throw new Error('derive.keyed.keys requires collection input and value output.');
        if (evaluation.reset || !driver.change || collectionHasStructuralChange(driver.change))
          output.output.set(driver.read.ids());
      },
    }),
    name: 'derive.keyed.keys',
  });
  return projection as Projection<readonly K[]>;
};

const createKeyedValues = <K extends string, V>(
  source: KeyedProjection<K, V>
): Projection<readonly V[]> => {
  assertKeyedProjection(source, 'Keyed values source');
  const [projection] = defineProcessor({
    dependencies: [source],
    outputs: [{ kind: 'value', equality: Object.is }],
    create: () => {
      let indexes = new Map<string, number>();
      const rebuild = (driver: Extract<SourceContext, { kind: 'collection' }>): readonly V[] => {
        const nextIndexes = new Map<string, number>();
        const ids = driver.read.ids();
        const values = Object.freeze(
          ids.map((key, index) => {
            nextIndexes.set(key, index);
            return driver.read.get(key) as V;
          })
        );
        indexes = nextIndexes;
        return values;
      };
      const rebuildIncremental = (
        driver: Extract<SourceContext, { kind: 'collection' }>,
        change: Extract<NonNullable<typeof driver.change>, { readonly kind: 'incremental' }>,
        previous: readonly V[]
      ): readonly V[] => {
        const changedValues = new Map<string, V>();
        for (const entry of change.added) changedValues.set(entry.key, entry.after as V);
        for (const entry of change.updated) changedValues.set(entry.key, entry.after as V);
        const nextIndexes = new Map<string, number>();
        const values = Object.freeze(
          driver.read.ids().map((key, index) => {
            nextIndexes.set(key, index);
            if (changedValues.has(key)) return changedValues.get(key) as V;
            const previousIndex = indexes.get(key);
            return previousIndex === undefined
              ? (driver.read.get(key) as V)
              : previous[previousIndex];
          })
        );
        indexes = nextIndexes;
        return values;
      };
      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'value')
            throw new Error('derive.keyed.values requires collection input and value output.');
          const change = driver.change;
          if (evaluation.reset || !change || change.kind === 'reset') {
            output.output.set(rebuild(driver));
            return;
          }
          const previous = output.previous as readonly V[] | undefined;
          if (!previous) {
            output.output.set(rebuild(driver));
            return;
          }
          if (collectionHasStructuralChange(change)) {
            output.output.set(rebuildIncremental(driver, change, previous));
            return;
          }
          if (!change.updated.length) return;
          const next = [...previous];
          for (const entry of change.updated) {
            const index = indexes.get(entry.key);
            if (index === undefined) {
              output.output.set(rebuild(driver));
              return;
            }
            next[index] = entry.after as V;
          }
          output.output.set(Object.freeze(next));
        },
        release: () => indexes.clear(),
      };
    },
    name: 'derive.keyed.values',
  });
  return projection as Projection<readonly V[]>;
};

function createKeyedFilter<K extends string, V>(
  source: KeyedProjection<K, V>,
  predicate: (value: V, key: K) => Synchronous<boolean>
): KeyedProjection<K, V>;
function createKeyedFilter<
  K extends string,
  V,
  const D extends object & KeyedDeriveDependencies<K, V, D>,
>(
  source: KeyedProjection<K, V>,
  dependencies: D,
  predicate: (value: V, key: K, dependencies: KeyedDependencyValues<D>) => Synchronous<boolean>
): KeyedProjection<K, V>;
function createKeyedFilter<K extends string, V>(
  source: KeyedProjection<K, V>,
  dependenciesOrPredicate:
    KeyedDeriveDependencyRecord<K, V> | ((value: V, key: K) => Synchronous<boolean>),
  maybePredicate?: (
    value: V,
    key: K,
    dependencies: Readonly<Record<string, unknown>>
  ) => Synchronous<boolean>
): KeyedProjection<K, V> {
  const dependencySpecs =
    typeof dependenciesOrPredicate === 'function' ? undefined : dependenciesOrPredicate;
  const predicate = (dependencySpecs === undefined ? dependenciesOrPredicate : maybePredicate) as
    | ((value: V, key: K) => Synchronous<boolean>)
    | ((value: V, key: K, dependencies: Readonly<Record<string, unknown>>) => Synchronous<boolean>)
    | undefined;
  if (typeof predicate !== 'function') throw new TypeError('Keyed filter requires a predicate.');
  return createKeyedTransform(
    source,
    dependencySpecs,
    (value, key, dependencies) => {
      const included =
        dependencySpecs === undefined
          ? (predicate as (value: V, key: K) => Synchronous<boolean>)(value, key)
          : (
              predicate as (
                value: V,
                key: K,
                dependencies: Readonly<Record<string, unknown>>
              ) => Synchronous<boolean>
            )(value, key, dependencies);
      assertSynchronous(included);
      if (typeof included !== 'boolean')
        throw new TypeError('Keyed filter predicate must return boolean.');
      return included ? value : absent;
    },
    Object.is,
    'derive.keyed.filter'
  );
}

function createKeyedCompact<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  select: (value: V, key: K) => Synchronous<T | undefined>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
function createKeyedCompact<
  K extends string,
  V,
  const D extends object & KeyedDeriveDependencies<K, V, D>,
  T,
>(
  source: KeyedProjection<K, V>,
  dependencies: D,
  select: (value: V, key: K, dependencies: KeyedDependencyValues<D>) => Synchronous<T | undefined>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
function createKeyedCompact<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  dependenciesOrSelect:
    KeyedDeriveDependencyRecord<K, V> | ((value: V, key: K) => Synchronous<T | undefined>),
  selectOrEquality?:
    | ((
        value: V,
        key: K,
        dependencies: Readonly<Record<string, unknown>>
      ) => Synchronous<T | undefined>)
    | Equality<T>,
  maybeEquality?: Equality<T>
): KeyedProjection<K, T> {
  const dependencySpecs =
    typeof dependenciesOrSelect === 'function' ? undefined : dependenciesOrSelect;
  const select = (dependencySpecs === undefined ? dependenciesOrSelect : selectOrEquality) as
    | ((value: V, key: K) => Synchronous<T | undefined>)
    | ((
        value: V,
        key: K,
        dependencies: Readonly<Record<string, unknown>>
      ) => Synchronous<T | undefined>)
    | undefined;
  const equality = (dependencySpecs === undefined ? selectOrEquality : maybeEquality) as
    Equality<T> | undefined;
  if (typeof select !== 'function') throw new TypeError('Keyed compact requires a selector.');
  return createKeyedTransform(
    source,
    dependencySpecs,
    (value, key, dependencies) => {
      const next =
        dependencySpecs === undefined
          ? (select as (value: V, key: K) => Synchronous<T | undefined>)(value, key)
          : (
              select as (
                value: V,
                key: K,
                dependencies: Readonly<Record<string, unknown>>
              ) => Synchronous<T | undefined>
            )(value, key, dependencies);
      assertSynchronous(next);
      return next === undefined ? absent : next;
    },
    equality,
    'derive.keyed.compact'
  );
}

const createKeyedSubset = <K extends string, V>(
  source: KeyedProjection<K, V>,
  orderedKeys: Projection<readonly K[]> | readonly K[]
): KeyedProjection<K, V> => {
  assertKeyedProjection(source, 'Keyed subset source');
  const keyProjection = isProjection(orderedKeys) ? orderedKeys : undefined;
  if (keyProjection && outputKind(keyProjection) !== 'value')
    throw new TypeError('Keyed subset ordered keys must be a value projection.');
  const staticSelection = keyProjection
    ? undefined
    : (() => {
        const compiled = compileOrderedKeys<K>(orderedKeys, 'Keyed subset ordered keys');
        return {
          keys: Object.freeze([...compiled.keys]),
          requested: compiled.requested,
        };
      })();
  const dependencies: Projection<unknown>[] = keyProjection ? [source, keyProjection] : [source];
  const [projection] = defineProcessor({
    dependencies,
    outputs: [{ kind: 'collection', equality: Object.is }],
    create: () => {
      let keys: readonly K[] | undefined = staticSelection?.keys;
      let requested: ReadonlySet<K> | undefined = staticSelection?.requested;
      let keyRevision = -1;
      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error('derive.keyed.subset requires collection input and output.');
          let keysChanged = false;
          if (keyProjection) {
            const sourceContext = evaluation.sources[1];
            if (sourceContext?.kind !== 'value')
              throw new TypeError('Keyed subset ordered keys resolved to a collection.');
            if (
              keys === undefined ||
              sourceContext.reset ||
              keyRevision !== sourceContext.revision
            ) {
              const compiled = compileOrderedKeys<K>(
                sourceContext.value,
                'Keyed subset ordered keys'
              );
              keys = compiled.keys;
              requested = compiled.requested;
              keyRevision = sourceContext.revision;
              keysChanged = true;
            }
          }
          if (!keys || !requested) throw new Error('Keyed subset keys were not initialized.');
          const activeKeys = keys;
          const activeRequested = requested;

          const orderedPresentKeys = (): readonly K[] =>
            activeKeys.filter(key => driver.read.has(key));
          const rebuild = (): void => {
            const nextKeys = orderedPresentKeys();
            for (const key of nextKeys) output.output.set(key, driver.read.get(key) as V);
            output.output.order(nextKeys);
          };
          const reconcileKeys = (): void => {
            const nextKeys = orderedPresentKeys();
            for (const key of output.previous.ids())
              if (!activeRequested.has(key as K) || !driver.read.has(key))
                output.output.remove(key);
            for (const key of nextKeys)
              if (!output.previous.has(key)) output.output.set(key, driver.read.get(key) as V);
            output.output.order(nextKeys);
          };

          const change = driver.change;
          if (evaluation.reset || change?.kind === 'reset') rebuild();
          else if (keysChanged) {
            reconcileKeys();
            if (change)
              for (const entry of change.updated) {
                const key = entry.key as K;
                if (activeRequested.has(key) && output.previous.has(key))
                  output.output.set(key, entry.after as V);
              }
          } else if (change) {
            let updateOrder = false;
            for (const entry of change.removed) {
              const key = entry.key as K;
              if (!activeRequested.has(key)) continue;
              output.output.remove(key);
              updateOrder = true;
            }
            for (const entry of change.added) {
              const key = entry.key as K;
              if (!activeRequested.has(key)) continue;
              output.output.set(key, entry.after as V);
              updateOrder = true;
            }
            for (const entry of change.updated) {
              const key = entry.key as K;
              if (activeRequested.has(key)) output.output.set(key, entry.after as V);
            }
            if (updateOrder) output.output.order(orderedPresentKeys());
          }
        },
        release: () => {
          if (keyProjection) {
            keys = undefined;
            requested = undefined;
            keyRevision = -1;
          }
        },
      };
    },
    name: 'derive.keyed.subset',
  });
  return projection as KeyedProjection<K, V>;
};

export const keyedDerive = Object.assign(createKeyedDerive, {
  keys: createKeyedKeys,
  values: createKeyedValues,
  subset: createKeyedSubset,
  filter: createKeyedFilter,
  compact: createKeyedCompact,
});
