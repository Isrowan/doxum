import type { Synchronous } from '@/runtime/contract';
import type { SourceContext } from '@/projection/contract';
import { collectionChangeTouchesKey } from '@/projection/collection/change';
import {
  compileProjectionDependencies,
  snapshotProjectionValues,
  type ProjectionDependencies,
  type ProjectionValues,
} from '@/projection/dependency';
import {
  defineProcessor,
  isProjection,
  type KeyedProjection,
  type Projection,
} from '@/projection/definition';
import { assertSynchronous } from '@/projection/graph/scheduler';
import { sameArray, snapshotArray } from '@/value/array';
import { assertKeyedProjection, outputKind } from './dependency';

type Equality<T> = (previous: T, next: T) => boolean;

/** Compiles selection inputs; runtime instances retain only the request and its dependency revisions.
 * Source slot zero belongs to the collection being queried, not to the selection expression.
 */
const compileSelection = <T>(
  input: unknown,
  named: boolean,
  select: unknown,
  normalize: (value: unknown, previous?: T) => T,
  name: string
) => {
  let projections: readonly Projection<unknown>[];
  let compute: ((sources: readonly SourceContext[]) => unknown) | undefined;
  let initial: T | undefined;
  if (named) {
    const compiled = compileProjectionDependencies(input, name);
    if (typeof select !== 'function') throw new TypeError(`${name} requires a selection callback.`);
    projections = compiled.projections;
    const selectValues = select as (values: ProjectionValues<ProjectionDependencies>) => unknown;
    compute = sources => selectValues(snapshotProjectionValues(compiled.names, sources, 1));
  } else if (isProjection(input)) {
    if (outputKind(input) !== 'value')
      throw new TypeError(`${name} selection must be a scalar projection.`);
    projections = [input];
    compute = sources => {
      const source = sources[1];
      if (source?.kind !== 'value') throw new Error(`${name} resolved a non-scalar selection.`);
      return source.value;
    };
  } else {
    projections = [];
    initial = normalize(input);
  }

  return {
    projections,
    create: () => {
      let initialized = compute === undefined;
      let current = initial;
      const revisions = new Array<number>(projections.length).fill(-1);
      return {
        get value(): T {
          if (!initialized) throw new Error(`${name} selection was not initialized.`);
          return current as T;
        },
        refresh(sources: readonly SourceContext[]): boolean {
          if (!compute) return false;
          let dirty = !initialized;
          for (let index = 0; index < revisions.length; index++) {
            const source = sources[index + 1];
            if (source.reset || source.revision !== revisions[index]) dirty = true;
          }
          if (!dirty) return false;
          const candidate = compute(sources);
          assertSynchronous(candidate);
          const next = normalize(candidate, current);
          const changed = !initialized || !Object.is(current, next);
          current = next;
          initialized = true;
          for (let index = 0; index < revisions.length; index++)
            revisions[index] = sources[index + 1].revision;
          return changed;
        },
      };
    },
  };
};

const normalizeKey = <K extends string>(value: unknown): K | undefined => {
  if (value !== undefined && typeof value !== 'string')
    throw new TypeError('derive.keyed.get key must be a string or undefined.');
  return value as K | undefined;
};

type OrderedSelection<K extends string> = {
  readonly keys: readonly K[];
  readonly requested: ReadonlySet<K>;
};

const normalizeOrderedKeys = <K extends string>(
  value: unknown,
  previous?: OrderedSelection<K>
): OrderedSelection<K> => {
  if (!Array.isArray(value))
    throw new TypeError('derive.keyed.subset ordered keys must be an array.');
  if (previous && sameArray(previous.keys, value)) return previous;
  const requested = new Set<K>();
  for (const key of value) {
    if (typeof key !== 'string') throw new TypeError('derive.keyed.subset keys must be strings.');
    if (requested.has(key as K))
      throw new TypeError('derive.keyed.subset keys must not contain duplicate keys.');
    requested.add(key as K);
  }
  return { keys: snapshotArray(value as K[]), requested };
};

function createKeyedGet<K extends string, V>(
  source: KeyedProjection<K, V>,
  key: NoInfer<K> | undefined | Projection<NoInfer<K> | undefined>,
  equality?: Equality<NoInfer<V> | undefined>
): Projection<V | undefined>;
function createKeyedGet<K extends string, V, const D extends ProjectionDependencies>(
  source: KeyedProjection<K, V>,
  dependencies: D,
  selectKey: (values: ProjectionValues<D>) => Synchronous<NoInfer<K> | undefined>,
  equality?: Equality<NoInfer<V> | undefined>
): Projection<V | undefined>;
function createKeyedGet<K extends string, V>(
  source: KeyedProjection<K, V>,
  input: unknown,
  selectOrEquality?: unknown,
  maybeEquality?: Equality<V | undefined>
): Projection<V | undefined> {
  const name = 'derive.keyed.get';
  assertKeyedProjection(source, `${name} source`);
  const named = !isProjection(input) && typeof input !== 'string' && input !== undefined;
  const selection = compileSelection(
    input,
    named,
    named ? selectOrEquality : undefined,
    normalizeKey<K>,
    name
  );
  const equality = named ? maybeEquality : selectOrEquality;
  if (equality !== undefined && typeof equality !== 'function')
    throw new TypeError(`${name} equality must be a function.`);
  const [projection] = defineProcessor({
    dependencies: [source, ...selection.projections],
    outputs: [{ kind: 'value', equality: (equality ?? Object.is) as Equality<unknown> }],
    name,
    create: () => {
      const selected = selection.create();
      return {
        evaluate: evaluation => {
          const collection = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (collection.kind !== 'collection' || output.kind !== 'value')
            throw new Error(`${name} resolved invalid input/output kinds.`);
          const keyChanged = selected.refresh(evaluation.sources);
          const key = selected.value;
          const change = collection.change;
          if (
            evaluation.reset ||
            keyChanged ||
            change?.kind === 'reset' ||
            (key !== undefined && change && collectionChangeTouchesKey(change, key))
          )
            output.output.set(key === undefined ? undefined : collection.read.get(key));
        },
      };
    },
  });
  return projection as Projection<V | undefined>;
}

function createKeyedSubset<K extends string, V>(
  source: KeyedProjection<K, V>,
  orderedKeys: Projection<readonly NoInfer<K>[]> | readonly NoInfer<K>[]
): KeyedProjection<K, V>;
function createKeyedSubset<K extends string, V, const D extends ProjectionDependencies>(
  source: KeyedProjection<K, V>,
  dependencies: D,
  selectOrderedKeys: (values: ProjectionValues<D>) => Synchronous<readonly NoInfer<K>[]>
): KeyedProjection<K, V>;
function createKeyedSubset<K extends string, V>(
  source: KeyedProjection<K, V>,
  input: unknown,
  selectOrderedKeys?: unknown
): KeyedProjection<K, V> {
  const name = 'derive.keyed.subset';
  assertKeyedProjection(source, `${name} source`);
  const named = !isProjection(input) && !Array.isArray(input);
  const selection = compileSelection(
    input,
    named,
    selectOrderedKeys,
    normalizeOrderedKeys<K>,
    name
  );
  const [projection] = defineProcessor({
    dependencies: [source, ...selection.projections],
    outputs: [{ kind: 'collection', equality: Object.is }],
    name,
    create: () => {
      const selected = selection.create();
      return {
        evaluate: evaluation => {
          const driver = evaluation.sources[0];
          const output = evaluation.outputs[0];
          if (driver.kind !== 'collection' || output.kind !== 'collection')
            throw new Error(`${name} requires collection input and output.`);
          const keysChanged = selected.refresh(evaluation.sources);
          const { keys, requested } = selected.value;
          const change = driver.change;
          if (evaluation.reset || change?.kind === 'reset') {
            const present = keys.filter(key => driver.read.has(key));
            for (const key of present) output.output.set(key, driver.read.get(key));
            output.output.order(present);
            return;
          }

          let orderChanged = keysChanged;
          if (keysChanged) {
            for (const key of output.previous.ids())
              if (!requested.has(key as K) || !driver.read.has(key)) output.output.remove(key);
            for (const key of keys)
              if (!output.previous.has(key) && driver.read.has(key))
                output.output.set(key, driver.read.get(key));
          } else if (change) {
            for (const entry of change.removed) {
              if (!requested.has(entry.key as K)) continue;
              output.output.remove(entry.key);
              orderChanged = true;
            }
            for (const entry of change.added) {
              if (!requested.has(entry.key as K)) continue;
              output.output.set(entry.key, entry.after);
              orderChanged = true;
            }
          }
          // Source values may change in the same evaluation as the requested keys.
          if (change)
            for (const entry of change.updated)
              if (requested.has(entry.key as K) && (!keysChanged || output.previous.has(entry.key)))
                output.output.set(entry.key, entry.after);
          if (orderChanged) output.output.order(keys.filter(key => driver.read.has(key)));
        },
      };
    },
  });
  return projection as KeyedProjection<K, V>;
}

export { createKeyedGet, createKeyedSubset };
