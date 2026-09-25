import type { Synchronous } from '@/runtime/contract';
import { defineProcessor, type KeyedProjection } from '@/projection/definition';
import { assertSynchronous } from '@/projection/graph/scheduler';
import { sameArray } from '@/value/array';
import { profile } from '@/profile';
import {
  assertKeyedProjection,
  compileKeyedDependencies,
  createKeyedDependencyRuntime,
  type KeyedDependencies,
  type KeyedDependencyRecord,
  type KeyedDependencyValues,
} from './dependency';
import { collectKeyedInvalidation } from './invalidation';
import { assertKeyedEntry, type KeyedEntries } from './entries';

type Equality<V> = (previous: V, next: V) => boolean;

export function createKeyedFlatMap<K extends string, V, O extends string, T>(
  source: KeyedProjection<K, V>,
  select: (value: NoInfer<V>, key: NoInfer<K>) => Synchronous<KeyedEntries<O, T>>,
  equality?: Equality<T>
): KeyedProjection<O, T>;
export function createKeyedFlatMap<
  K extends string,
  V,
  const D extends object,
  O extends string,
  T,
>(
  source: KeyedProjection<K, V>,
  dependencies: D & KeyedDependencies<NoInfer<K>, NoInfer<V>, D>,
  select: (
    value: NoInfer<V>,
    key: NoInfer<K>,
    dependencies: KeyedDependencyValues<D>
  ) => Synchronous<KeyedEntries<O, T>>,
  equality?: Equality<T>
): KeyedProjection<O, T>;
export function createKeyedFlatMap<K extends string, V, O extends string, T>(
  source: KeyedProjection<K, V>,
  dependenciesOrSelect: KeyedDependencyRecord<K, V> | ((value: V, key: K) => KeyedEntries<O, T>),
  selectOrEquality?:
    | ((value: V, key: K, dependencies: Readonly<Record<string, unknown>>) => KeyedEntries<O, T>)
    | Equality<T>,
  maybeEquality?: Equality<T>
): KeyedProjection<O, T> {
  const name = 'derive.keyed.flatMap';
  assertKeyedProjection(source, `${name} source`);
  const specs = typeof dependenciesOrSelect === 'function' ? undefined : dependenciesOrSelect;
  const select = (specs === undefined ? dependenciesOrSelect : selectOrEquality) as
    | ((value: V, key: K, dependencies: Readonly<Record<string, unknown>>) => KeyedEntries<O, T>)
    | undefined;
  const equality = (specs === undefined ? selectOrEquality : maybeEquality) as
    Equality<T> | undefined;
  if (typeof select !== 'function') throw new TypeError(`${name} requires a selector.`);
  if (equality !== undefined && typeof equality !== 'function')
    throw new TypeError(`${name} equality must be a function.`);
  const compiled = compileKeyedDependencies(
    source,
    specs as KeyedDependencyRecord<string, unknown> | undefined,
    name
  );
  const [projection] = defineProcessor({
    dependencies: compiled.projections,
    outputs: [{ kind: 'collection', equality: (equality ?? Object.is) as Equality<unknown> }],
    name,
    create: () => {
      const dependencies = createKeyedDependencyRuntime(compiled);
      const childrenByParent = new Map<string, readonly string[]>();
      const ownerByOutput = new Map<string, string>();
      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error(`${name} requires collection input and output.`);
          const plan = collectKeyedInvalidation(
            driver,
            evaluation.sources,
            dependencies,
            evaluation.reset
          );
          dependencies.prepare(evaluation.sources, plan.rebuild);
          if (plan.rebuild) {
            dependencies.clearBindings();
            childrenByParent.clear();
            ownerByOutput.clear();
          }
          const replaced = new Set(plan.keys);
          for (const entry of plan.removed) replaced.add(entry.key);
          const proposals = new Map<string, { readonly parent: string; readonly value: T }>();
          const segments = new Map<string, readonly string[]>();
          let orderDirty = plan.structural;
          for (const parent of replaced) {
            if (!driver.read.has(parent)) continue;
            const value = driver.read.get(parent) as V;
            const entries = select(
              value,
              parent as K,
              dependencies.resolve(value, parent, evaluation.sources)
            );
            assertSynchronous(entries);
            if (!Array.isArray(entries))
              throw new TypeError(`${name} selector must return an array of entries.`);
            const keys: string[] = [];
            for (const entry of entries) {
              assertKeyedEntry(entry, name);
              const [key, child] = entry;
              const owner = ownerByOutput.get(key);
              if (proposals.has(key) || (owner !== undefined && !replaced.has(owner)))
                throw new TypeError(`${name} duplicate key ${JSON.stringify(key)}.`);
              proposals.set(key, { parent, value: child });
              keys.push(key);
            }
            const previous = childrenByParent.get(parent);
            const unchanged = previous ? sameArray(previous, keys) : keys.length === 0;
            if (!unchanged) orderDirty = true;
            if (keys.length)
              segments.set(parent, unchanged && previous ? previous : Object.freeze(keys));
          }
          if (plan.rebuild) {
            if (!evaluation.reset)
              for (const key of output.previous.ids())
                if (!proposals.has(key)) output.output.remove(key);
          } else {
            for (const parent of replaced) {
              const previous = childrenByParent.get(parent);
              if (previous)
                for (const key of previous) {
                  if (!proposals.has(key)) output.output.remove(key);
                  ownerByOutput.delete(key);
                }
              childrenByParent.delete(parent);
            }
          }
          for (const entry of plan.removed) dependencies.remove(entry.key);
          for (const [parent, keys] of segments) childrenByParent.set(parent, keys);
          for (const [key, entry] of proposals) {
            ownerByOutput.set(key, entry.parent);
            output.output.set(key, entry.value);
          }
          if (orderDirty) {
            const order: string[] = [];
            const parents = driver.read.ids();
            for (const parent of parents) {
              const keys = childrenByParent.get(parent);
              if (keys) for (const key of keys) order.push(key);
            }
            profile.collectionView.idsScanned(parents.length + order.length);
            output.output.order(order);
          }
          dependencies.remember(evaluation.sources);
        },
        release: () => {
          childrenByParent.clear();
          ownerByOutput.clear();
          dependencies.release();
        },
      };
    },
  });
  return projection as KeyedProjection<O, T>;
}
