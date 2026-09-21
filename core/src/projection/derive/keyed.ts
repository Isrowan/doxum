import type { Synchronous } from '../../runtime/contract';
import { collectionChange, collectionHasStructuralChange } from '../collection/change';
import type { SourceContext } from '../contract';
import {
  defineProcessor,
  isProjection,
  type KeyedProjection,
  type OutputEvaluation,
  type Projection,
} from '../definition';
import { assertSynchronous } from '../graph/scheduler';
import {
  assertKeyedProjection,
  compileKeyedDependencies,
  createKeyedDependencyRuntime,
  outputKind,
  type KeyedDependencies as KeyedDeriveDependencies,
  type KeyedDependencyRecord as KeyedDeriveDependencyRecord,
  type KeyedDependencyValues,
} from '../keyed/dependency';
import { createKeyedTransform, keyedAbsent } from '../keyed/transform';
import { createKeyRelation } from '../keyed/relation';

type Equality<T> = (previous: T, next: T) => boolean;

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

function createKeyedDerive<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  select: (value: NoInfer<V>, key: NoInfer<K>) => Synchronous<T>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
function createKeyedDerive<K extends string, V, const D extends object, T>(
  source: KeyedProjection<K, V>,
  dependencies: D & KeyedDeriveDependencies<NoInfer<K>, NoInfer<V>, D>,
  select: (
    value: NoInfer<V>,
    key: NoInfer<K>,
    dependencies: KeyedDependencyValues<D>
  ) => Synchronous<T>,
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
  return createKeyedTransform({
    source,
    dependencies: dependencySpecs,
    equality,
    name: 'derive.keyed',
    evaluate: ({ value, key, dependencies }) =>
      dependencySpecs === undefined
        ? (select as (value: V, key: K) => Synchronous<T>)(value, key)
        : (
            select as (
              value: V,
              key: K,
              dependencies: Readonly<Record<string, unknown>>
            ) => Synchronous<T>
          )(value, key, dependencies),
  });
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

const createOrderedSnapshot = <K extends string, V, T>(
  source: KeyedProjection<K, V>,
  name: string,
  make: (key: K, value: V) => T
): Projection<readonly T[]> => {
  assertKeyedProjection(source, `${name} source`);
  const [projection] = defineProcessor({
    dependencies: [source],
    outputs: [{ kind: 'value', equality: Object.is }],
    create: () => {
      let indexes = new Map<string, number>();
      const rebuild = (driver: Extract<SourceContext, { kind: 'collection' }>): readonly T[] => {
        const nextIndexes = new Map<string, number>();
        const result = Object.freeze(
          driver.read.ids().map((key, index) => {
            nextIndexes.set(key, index);
            return make(key as K, driver.read.get(key) as V);
          })
        );
        indexes = nextIndexes;
        return result;
      };
      const rebuildIncremental = (
        driver: Extract<SourceContext, { kind: 'collection' }>,
        change: Extract<NonNullable<typeof driver.change>, { readonly kind: 'incremental' }>,
        previous: readonly T[]
      ): readonly T[] => {
        const changedValues = new Map<string, V>();
        for (const entry of change.added) changedValues.set(entry.key, entry.after as V);
        for (const entry of change.updated) changedValues.set(entry.key, entry.after as V);
        const nextIndexes = new Map<string, number>();
        const result = Object.freeze(
          driver.read.ids().map((key, index) => {
            nextIndexes.set(key, index);
            if (changedValues.has(key)) return make(key as K, changedValues.get(key) as V);
            const previousIndex = indexes.get(key);
            return previousIndex === undefined
              ? make(key as K, driver.read.get(key) as V)
              : previous[previousIndex];
          })
        );
        indexes = nextIndexes;
        return result;
      };
      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'value')
            throw new Error(`${name} requires collection input and value output.`);
          const change = driver.change;
          if (evaluation.reset || !change || change.kind === 'reset') {
            output.output.set(rebuild(driver));
            return;
          }
          const previous = output.previous as readonly T[] | undefined;
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
            next[index] = make(entry.key as K, entry.after as V);
          }
          output.output.set(Object.freeze(next));
        },
        release: () => indexes.clear(),
      };
    },
    name,
  });
  return projection as Projection<readonly T[]>;
};

const createKeyedValues = <K extends string, V>(
  source: KeyedProjection<K, V>
): Projection<readonly V[]> =>
  createOrderedSnapshot(source, 'derive.keyed.values', (_key, value) => value);

const createKeyedEntries = <K extends string, V>(
  source: KeyedProjection<K, V>
): Projection<readonly (readonly [K, V])[]> =>
  createOrderedSnapshot(source, 'derive.keyed.entries', (key, value) =>
    Object.freeze([key, value] as const)
  );

const createKeyedGet = <K extends string, V>(
  source: KeyedProjection<K, V>,
  key: Projection<NoInfer<K> | undefined>,
  equality: Equality<V | undefined> = Object.is
): Projection<V | undefined> => {
  assertKeyedProjection(source, 'derive.keyed.get source');
  if (outputKind(key) !== 'value')
    throw new TypeError('derive.keyed.get key must be a scalar projection.');
  const [projection] = defineProcessor({
    dependencies: [source, key],
    outputs: [{ kind: 'value', equality: equality as Equality<unknown> }],
    create: () => {
      let sourceRevision = -1;
      let keyRevision = -1;
      let selected: K | undefined;
      return {
        evaluate: evaluation => {
          const collection = evaluation.sources[0];
          const selectedKey = evaluation.sources[1];
          const output = evaluation.outputs[0];
          if (
            collection.kind !== 'collection' ||
            selectedKey.kind !== 'value' ||
            output.kind !== 'value'
          )
            throw new Error('derive.keyed.get resolved invalid input/output kinds.');
          let affected = evaluation.reset;
          if (evaluation.reset || keyRevision !== selectedKey.revision) {
            const candidate = selectedKey.value;
            if (candidate !== undefined && typeof candidate !== 'string')
              throw new TypeError('derive.keyed.get key must resolve to a string or undefined.');
            selected = candidate as K | undefined;
            affected = true;
          } else if (sourceRevision !== collection.revision) {
            const change = collection.change;
            if (!change || change.kind === 'reset') affected = true;
            else if (selected !== undefined)
              for (const changedKey of collectionChange.keys(change))
                if (changedKey === selected) {
                  affected = true;
                  break;
                }
          }
          if (affected)
            output.output.set(
              selected === undefined ? undefined : (collection.read.get(selected) as V | undefined)
            );
          sourceRevision = collection.revision;
          keyRevision = selectedKey.revision;
        },
      };
    },
    name: 'derive.keyed.get',
  });
  return projection as Projection<V | undefined>;
};

function createKeyedFilter<K extends string, V>(
  source: KeyedProjection<K, V>,
  predicate: (value: NoInfer<V>, key: NoInfer<K>) => Synchronous<boolean>
): KeyedProjection<K, V>;
function createKeyedFilter<K extends string, V, const D extends object>(
  source: KeyedProjection<K, V>,
  dependencies: D & KeyedDeriveDependencies<NoInfer<K>, NoInfer<V>, D>,
  predicate: (
    value: NoInfer<V>,
    key: NoInfer<K>,
    dependencies: KeyedDependencyValues<D>
  ) => Synchronous<boolean>
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
  return createKeyedTransform({
    source,
    dependencies: dependencySpecs,
    equality: Object.is,
    name: 'derive.keyed.filter',
    evaluate: ({ value, key, dependencies }) => {
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
      return included ? value : keyedAbsent;
    },
  });
}

function createKeyedCompact<K extends string, V, T>(
  source: KeyedProjection<K, V>,
  select: (value: NoInfer<V>, key: NoInfer<K>) => Synchronous<T | undefined>,
  equality?: Equality<T>
): KeyedProjection<K, T>;
function createKeyedCompact<K extends string, V, const D extends object, T>(
  source: KeyedProjection<K, V>,
  dependencies: D & KeyedDeriveDependencies<NoInfer<K>, NoInfer<V>, D>,
  select: (
    value: NoInfer<V>,
    key: NoInfer<K>,
    dependencies: KeyedDependencyValues<D>
  ) => Synchronous<T | undefined>,
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
  return createKeyedTransform({
    source,
    dependencies: dependencySpecs,
    equality,
    name: 'derive.keyed.compact',
    evaluate: ({ value, key, dependencies }) => {
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
      return next === undefined ? keyedAbsent : next;
    },
  });
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

const normalizeGroups = <G extends string>(value: unknown): readonly G[] => {
  const groups = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(groups))
    throw new TypeError(
      'derive.keyed.groupBy selector must return a string or an array of strings.'
    );
  const seen = new Set<string>();
  const result: G[] = [];
  for (const group of groups) {
    if (typeof group !== 'string')
      throw new TypeError('derive.keyed.groupBy selector must return only string group keys.');
    if (seen.has(group))
      throw new TypeError('derive.keyed.groupBy selector must not return duplicate group keys.');
    seen.add(group);
    result.push(group as G);
  }
  return Object.freeze(result);
};

function createKeyedGroupBy<K extends string, V, G extends string>(
  source: KeyedProjection<K, V>,
  selector: (value: NoInfer<V>, key: NoInfer<K>) => Synchronous<G | readonly G[]>
): KeyedProjection<G, readonly K[]>;
function createKeyedGroupBy<K extends string, V, const D extends object, G extends string>(
  source: KeyedProjection<K, V>,
  dependencies: D & KeyedDeriveDependencies<NoInfer<K>, NoInfer<V>, D>,
  selector: (
    value: NoInfer<V>,
    key: NoInfer<K>,
    dependencies: KeyedDependencyValues<D>
  ) => Synchronous<G | readonly G[]>
): KeyedProjection<G, readonly K[]>;
function createKeyedGroupBy<K extends string, V, G extends string>(
  source: KeyedProjection<K, V>,
  dependenciesOrSelector:
    KeyedDeriveDependencyRecord<K, V> | ((value: V, key: K) => Synchronous<G | readonly G[]>),
  maybeSelector?: (
    value: V,
    key: K,
    dependencies: Readonly<Record<string, unknown>>
  ) => Synchronous<G | readonly G[]>
): KeyedProjection<G, readonly K[]> {
  assertKeyedProjection(source, 'derive.keyed.groupBy source');
  const dependencySpecs =
    typeof dependenciesOrSelector === 'function' ? undefined : dependenciesOrSelector;
  const selector = (dependencySpecs === undefined ? dependenciesOrSelector : maybeSelector) as
    | ((value: V, key: K) => Synchronous<G | readonly G[]>)
    | ((
        value: V,
        key: K,
        dependencies: Readonly<Record<string, unknown>>
      ) => Synchronous<G | readonly G[]>)
    | undefined;
  if (typeof selector !== 'function')
    throw new TypeError('derive.keyed.groupBy requires a selector.');

  const compiled = compileKeyedDependencies(
    source,
    dependencySpecs as KeyedDeriveDependencyRecord<string, unknown> | undefined,
    'derive.keyed.groupBy'
  );
  const [projection] = defineProcessor({
    dependencies: compiled.projections,
    outputs: [
      {
        kind: 'collection',
        equality: (previous: unknown, next: unknown) => {
          const left = previous as readonly string[];
          const right = next as readonly string[];
          return left.length === right.length && left.every((key, index) => key === right[index]);
        },
      },
    ],
    create: () => {
      const dependencies = createKeyedDependencyRuntime(compiled);
      const relation = createKeyRelation();
      const orderIndex = new Map<string, number>();
      const groupRanks = new Map<G, { readonly source: number; readonly selector: number }>();

      const refreshOrderIndex = (driver: Extract<SourceContext, { kind: 'collection' }>): void => {
        orderIndex.clear();
        driver.read.ids().forEach((key, index) => orderIndex.set(key, index));
      };

      const selectGroups = (
        driver: Extract<SourceContext, { kind: 'collection' }>,
        sources: readonly SourceContext[],
        key: string,
        affected: Set<G>
      ): boolean => {
        if (!driver.read.has(key)) return false;
        const value = driver.read.get(key) as V;
        const dependencyValues = dependencies.resolve(value, key, sources);
        const selected =
          dependencySpecs === undefined
            ? (selector as (value: V, key: K) => Synchronous<G | readonly G[]>)(value, key as K)
            : (
                selector as (
                  value: V,
                  key: K,
                  dependencies: Readonly<Record<string, unknown>>
                ) => Synchronous<G | readonly G[]>
              )(value, key as K, dependencyValues);
        assertSynchronous(selected);
        const next = normalizeGroups<G>(selected);
        const previous = relation.forward(key) ?? Object.freeze([]);
        if (!relation.replace(key, next)) return false;
        for (const group of previous) affected.add(group as G);
        for (const group of next) affected.add(group);
        return true;
      };

      const updateGroup = (
        group: G,
        output: Extract<OutputEvaluation, { kind: 'collection' }>
      ): void => {
        const reverse = relation.reverse(group);
        if (!reverse?.size) {
          groupRanks.delete(group);
          output.output.remove(group);
          return;
        }
        const members = [...reverse].sort(
          (left, right) =>
            (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
        );
        const first = members[0];
        const source = orderIndex.get(first);
        const selector = relation.forward(first)?.indexOf(group) ?? -1;
        if (source === undefined || selector < 0)
          throw new Error('derive.keyed.groupBy relation is inconsistent with source order.');
        groupRanks.set(group, { source, selector });
        output.output.set(group, Object.freeze(members as K[]));
      };

      const publishGroupOrder = (
        output: Extract<OutputEvaluation, { kind: 'collection' }>
      ): void => {
        const order = [...groupRanks.entries()]
          .sort(([leftKey, left], [rightKey, right]) => {
            if (left.source !== right.source) return left.source - right.source;
            if (left.selector !== right.selector) return left.selector - right.selector;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          })
          .map(([group]) => group);
        output.output.order(order);
      };

      const rebuild = (
        driver: Extract<SourceContext, { kind: 'collection' }>,
        sources: readonly SourceContext[],
        output: Extract<OutputEvaluation, { kind: 'collection' }>
      ): void => {
        dependencies.clearBindings();
        relation.clear();
        groupRanks.clear();
        refreshOrderIndex(driver);
        const affected = new Set<G>();
        for (const key of driver.read.ids()) selectGroups(driver, sources, key, affected);
        for (const key of output.previous.ids()) affected.add(key as G);
        for (const group of affected) updateGroup(group, output);
        publishGroupOrder(output);
      };

      const publishAffected = (
        affected: ReadonlySet<G>,
        output: Extract<OutputEvaluation, { kind: 'collection' }>,
        orderDirty: boolean
      ): void => {
        for (const group of affected) updateGroup(group, output);
        if (orderDirty) publishGroupOrder(output);
      };

      const removeSourceKey = (key: string, affected: Set<G>): boolean => {
        const previous = relation.forward(key);
        if (!previous) return false;
        for (const group of previous) affected.add(group as G);
        return relation.delete(key);
      };

      const markAllGroups = (
        output: Extract<OutputEvaluation, { kind: 'collection' }>,
        affected: Set<G>
      ): void => {
        for (const group of relation.rights()) affected.add(group as G);
        for (const group of output.previous.ids()) affected.add(group as G);
      };

      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error('derive.keyed.groupBy requires collection input and output.');
          dependencies.prepare(evaluation.sources, evaluation.reset);

          if (evaluation.reset) {
            rebuild(driver, evaluation.sources, output);
            dependencies.remember(evaluation.sources);
            return;
          }

          const dirty = new Set<string>();
          const affected = new Set<G>();
          let all = false;
          let structural = false;
          let orderDirty = false;
          if (dependencies.driverChanged(driver)) {
            const change = driver.change;
            if (!change || change.kind === 'reset') {
              rebuild(driver, evaluation.sources, output);
              dependencies.remember(evaluation.sources);
              return;
            } else {
              for (const entry of change.removed) {
                orderDirty ||= removeSourceKey(entry.key, affected);
                dependencies.remove(entry.key);
                dirty.delete(entry.key);
              }
              for (const entry of change.added) dirty.add(entry.key);
              for (const entry of change.updated) dirty.add(entry.key);
              structural = Boolean(change.added.length || change.removed.length || change.order);
              orderDirty ||= structural;
              if (structural) refreshOrderIndex(driver);
            }
          }
          all ||= dependencies.collectInvalidated(evaluation.sources, dirty);
          if (all) for (const key of driver.read.ids()) dirty.add(key);
          for (const key of dirty)
            orderDirty ||= selectGroups(driver, evaluation.sources, key, affected);
          if (structural) markAllGroups(output, affected);
          publishAffected(affected, output, orderDirty);
          dependencies.remember(evaluation.sources);
        },
        release: () => {
          relation.clear();
          orderIndex.clear();
          groupRanks.clear();
          dependencies.release();
        },
      };
    },
    name: 'derive.keyed.groupBy',
  });
  return projection as KeyedProjection<G, readonly K[]>;
}

const createKeyedSingleton = <K extends string, V>(
  source: Projection<V | undefined>,
  keyOf: (value: V) => Synchronous<K>,
  equality: Equality<V> = Object.is
): KeyedProjection<K, V> => {
  if (outputKind(source) !== 'value')
    throw new TypeError('derive.keyed.singleton source must be a scalar projection.');
  if (typeof keyOf !== 'function')
    throw new TypeError('derive.keyed.singleton requires a key selector.');
  const [projection] = defineProcessor({
    dependencies: [source],
    outputs: [{ kind: 'collection', equality: equality as Equality<unknown> }],
    create: () => ({
      evaluate: evaluation => {
        const scalar = evaluation.sources[0];
        const output = evaluation.outputs[0];
        if (scalar.kind !== 'value' || output.kind !== 'collection')
          throw new Error('derive.keyed.singleton resolved invalid input/output kinds.');
        const previous = output.previous.ids();
        if (scalar.value === undefined) {
          for (const key of previous) output.output.remove(key);
          return;
        }
        const key = keyOf(scalar.value as V);
        assertSynchronous(key);
        if (typeof key !== 'string')
          throw new TypeError('derive.keyed.singleton key selector must return a string.');
        for (const previousKey of previous)
          if (previousKey !== key) output.output.remove(previousKey);
        output.output.set(key, scalar.value as V);
        if (previous.length !== 1 || previous[0] !== key) output.output.order([key]);
      },
    }),
    name: 'derive.keyed.singleton',
  });
  return projection as KeyedProjection<K, V>;
};

export const keyedDerive = Object.assign(createKeyedDerive, {
  keys: createKeyedKeys,
  values: createKeyedValues,
  entries: createKeyedEntries,
  get: createKeyedGet,
  groupBy: createKeyedGroupBy,
  singleton: createKeyedSingleton,
  subset: createKeyedSubset,
  filter: createKeyedFilter,
  compact: createKeyedCompact,
});
