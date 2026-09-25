import type { Synchronous } from '@/runtime/contract';
import { profile } from '@/profile';
import type { CollectionDraft, SourceContext } from '@/projection/contract';
import {
  defineProcessor,
  isProjection,
  type CollectionOutputEvaluation,
  type KeyedProjection,
  type Projection,
} from '@/projection/definition';
import { assertSynchronous } from '@/projection/graph/scheduler';
import { assertKeyedProjection, outputKind } from './dependency';
import { snapshotArray } from '@/value/array';
import {
  compileProjectionDependencies,
  snapshotProjectionValues,
  type ProjectionDependencies,
  type ProjectionValues,
} from '@/projection/dependency';
import { assertKeyedEntry, type KeyedEntries } from './entries';

type Equality<T> = (previous: T, next: T) => boolean;

type MergeContribution<V> = {
  readonly sourceIndex: number;
  readonly value: V;
};

type MergeOptions<K extends string, V> =
  | {
      readonly conflict: 'error' | 'first' | 'last';
      readonly equality?: Equality<V>;
      readonly resolve?: never;
    }
  | {
      readonly conflict: 'resolve';
      readonly resolve: (
        contributions: readonly MergeContribution<V>[],
        key: NoInfer<K>
      ) => Synchronous<V>;
      readonly equality?: Equality<V>;
    };

type CompiledMergeOptions<K extends string, V> = {
  readonly conflict: MergeOptions<K, V>['conflict'];
  readonly equality: Equality<V>;
  readonly resolve?: (
    contributions: readonly MergeContribution<V>[],
    key: NoInfer<K>
  ) => Synchronous<V>;
};

const assertEquality = <T>(equality: Equality<T> | undefined, role: string): Equality<T> => {
  if (equality !== undefined && typeof equality !== 'function')
    throw new TypeError(`${role} equality must be a function.`);
  return equality ?? Object.is;
};

const compileMergeOptions = <K extends string, V>(
  options: MergeOptions<K, V>
): CompiledMergeOptions<K, V> => {
  if (options === null || typeof options !== 'object')
    throw new TypeError('derive.keyed.merge requires conflict options.');
  const equality = assertEquality(options.equality, 'derive.keyed.merge');
  switch (options.conflict) {
    case 'error':
    case 'first':
    case 'last':
      if ('resolve' in options && options.resolve !== undefined)
        throw new TypeError('derive.keyed.merge resolve is only valid when conflict is "resolve".');
      return Object.freeze({ conflict: options.conflict, equality });
    case 'resolve':
      if (typeof options.resolve !== 'function')
        throw new TypeError('derive.keyed.merge requires a resolver when conflict is "resolve".');
      return Object.freeze({ conflict: options.conflict, equality, resolve: options.resolve });
    default:
      throw new TypeError(
        'derive.keyed.merge conflict must be "error", "first", "last", or "resolve".'
      );
  }
};

const assertCollectionSources = (sources: readonly SourceContext[], expected: number): void => {
  if (sources.length !== expected)
    throw new Error('derive.keyed.merge resolved an invalid dependency count.');
  for (const source of sources)
    if (source.kind !== 'collection')
      throw new Error('derive.keyed.merge requires collection inputs.');
};

/** Complete ordered result reconciliation, without retaining a second member/value cache. */
const stageKeyedSnapshot = <T>(
  values: readonly T[],
  output: CollectionOutputEvaluation,
  keyOf: (value: T) => Synchronous<string>,
  valueOf: (value: T) => unknown,
  name: string
): void => {
  const seen = new Set<string>();
  const order = new Array<string>(values.length);
  const previous = output.previous.ids();
  profile.collectionView.idsScanned(values.length + previous.length);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const key = keyOf(value);
    assertSynchronous(key);
    if (typeof key !== 'string') throw new TypeError(`${name} key selector must return a string.`);
    if (seen.has(key)) throw new TypeError(`${name} duplicate key ${JSON.stringify(key)}.`);
    seen.add(key);
    order[index] = key;
    output.output.set(key, valueOf(value));
  }
  for (const key of previous) if (!seen.has(key)) output.output.remove(key);
  output.output.order(order);
};

function createKeyedFrom<K extends string, V>(
  source: Projection<readonly V[]>,
  keyOf: (value: NoInfer<V>) => Synchronous<K>,
  equality?: Equality<V>
): KeyedProjection<K, V>;
function createKeyedFrom<K extends string, V>(
  source: readonly V[],
  keyOf: (value: NoInfer<V>) => Synchronous<K>,
  equality?: Equality<V>
): KeyedProjection<K, V>;
function createKeyedFrom<K extends string, V>(
  source: Projection<readonly V[]> | readonly V[],
  keyOf: (value: NoInfer<V>) => Synchronous<K>,
  equality?: Equality<V>
): KeyedProjection<K, V> {
  if (typeof keyOf !== 'function')
    throw new TypeError('derive.keyed.from requires a key selector.');
  const outputEquality = assertEquality(equality, 'derive.keyed.from');
  let dependency: Projection<readonly V[]> | undefined;
  let staticValues: readonly V[] | undefined;
  if (isProjection(source)) {
    if (outputKind(source) !== 'value')
      throw new TypeError('derive.keyed.from source projection must be scalar.');
    dependency = source as Projection<readonly V[]>;
  } else {
    if (!Array.isArray(source))
      throw new TypeError(
        'derive.keyed.from source must be a scalar projection or readonly array.'
      );
    staticValues = snapshotArray(source as readonly V[]);
  }

  const [projection] = defineProcessor({
    dependencies: dependency ? [dependency] : [],
    outputs: [{ kind: 'collection', equality: outputEquality as Equality<unknown> }],
    create: () => ({
      evaluate: evaluation => {
        const output = evaluation.outputs[0];
        if (output.kind !== 'collection')
          throw new Error('derive.keyed.from requires a collection output.');
        let values = staticValues;
        if (dependency) {
          const scalar = evaluation.sources[0];
          if (scalar?.kind !== 'value')
            throw new Error('derive.keyed.from resolved a non-scalar input.');
          if (!Array.isArray(scalar.value))
            throw new TypeError('derive.keyed.from source value must be an array.');
          values = scalar.value as readonly V[];
        }
        if (!values) throw new Error('derive.keyed.from has no source values.');

        stageKeyedSnapshot(values, output, keyOf, value => value, 'derive.keyed.from');
      },
    }),
    name: 'derive.keyed.from',
  });
  return projection as KeyedProjection<K, V>;
}

function createKeyedFromEntries<const D extends ProjectionDependencies, K extends string, V>(
  dependencies: D,
  compute: (values: ProjectionValues<D>) => Synchronous<KeyedEntries<K, V>>,
  equality?: Equality<V>
): KeyedProjection<K, V> {
  const name = 'derive.keyed.fromEntries';
  const compiled = compileProjectionDependencies(dependencies, name);
  if (typeof compute !== 'function') throw new TypeError(`${name} requires a compute callback.`);
  const outputEquality = assertEquality(equality, name);
  const [projection] = defineProcessor({
    dependencies: compiled.projections,
    outputs: [{ kind: 'collection', equality: outputEquality as Equality<unknown> }],
    name,
    create: () => ({
      evaluate: evaluation => {
        const output = evaluation.outputs[0];
        if (output.kind !== 'collection') throw new Error(`${name} requires a collection output.`);
        const entries = compute(snapshotProjectionValues<D>(compiled.names, evaluation.sources));
        assertSynchronous(entries);
        if (!Array.isArray(entries))
          throw new TypeError(`${name} compute must return an array of entries.`);
        stageKeyedSnapshot(
          entries,
          output,
          entry => {
            assertKeyedEntry(entry, name);
            return entry[0];
          },
          entry => entry[1],
          name
        );
      },
    }),
  });
  return projection as KeyedProjection<K, V>;
}

function createKeyedMerge<K extends string, V>(
  sources: readonly KeyedProjection<K, V>[],
  options:
    | {
        readonly conflict: 'error' | 'first' | 'last';
        readonly equality?: Equality<V>;
        readonly resolve?: never;
      }
    | {
        readonly conflict: 'resolve';
        readonly resolve: (
          contributions: readonly {
            readonly sourceIndex: number;
            readonly value: V;
          }[],
          key: NoInfer<K>
        ) => Synchronous<V>;
        readonly equality?: Equality<V>;
      }
): KeyedProjection<K, V>;
function createKeyedMerge<K extends string, V>(
  sources: readonly KeyedProjection<K, V>[],
  options: MergeOptions<K, V>
): KeyedProjection<K, V> {
  if (!Array.isArray(sources))
    throw new TypeError('derive.keyed.merge sources must be an array of keyed projections.');
  const capturedSources = snapshotArray(sources);
  for (let index = 0; index < capturedSources.length; index++)
    assertKeyedProjection(capturedSources[index], `derive.keyed.merge source ${index}`);
  const compiled = compileMergeOptions(options);

  const [projection] = defineProcessor({
    dependencies: capturedSources,
    outputs: [{ kind: 'collection', equality: compiled.equality as Equality<unknown> }],
    create: () => {
      const revisions = new Array<number>(capturedSources.length).fill(-1);

      const remember = (sources: readonly SourceContext[]): void => {
        for (let index = 0; index < revisions.length; index++)
          revisions[index] = sources[index].revision;
      };

      const writeEffective = (
        sources: readonly SourceContext[],
        output: CollectionDraft<string, unknown>,
        key: string
      ): void => {
        if (compiled.conflict === 'first') {
          for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
            const source = sources[sourceIndex];
            if (source.kind !== 'collection')
              throw new Error('derive.keyed.merge requires collection inputs.');
            if (!source.read.has(key)) continue;
            output.set(key, source.read.get(key));
            return;
          }
          output.remove(key);
          return;
        }

        let present = false;
        let selected: unknown;
        let firstSourceIndex = -1;
        let contributions: MergeContribution<V>[] | undefined;
        for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          const source = sources[sourceIndex];
          if (source.kind !== 'collection')
            throw new Error('derive.keyed.merge requires collection inputs.');
          if (!source.read.has(key)) continue;
          const value = source.read.get(key) as V;
          if (!present) {
            present = true;
            selected = value;
            firstSourceIndex = sourceIndex;
            continue;
          }
          if (compiled.conflict === 'error')
            throw new TypeError(`derive.keyed.merge duplicate key ${JSON.stringify(key)}.`);
          if (compiled.conflict === 'last') {
            selected = value;
            continue;
          }
          if (!contributions) {
            contributions = [
              Object.freeze({ sourceIndex: firstSourceIndex, value: selected as V }),
              Object.freeze({ sourceIndex, value }),
            ];
          } else contributions.push(Object.freeze({ sourceIndex, value }));
        }

        if (!present) {
          output.remove(key);
          return;
        }
        if (compiled.conflict === 'resolve' && contributions) {
          const resolved = compiled.resolve!(Object.freeze(contributions), key as K);
          assertSynchronous(resolved);
          output.set(key, resolved);
          return;
        }
        output.set(key, selected);
      };

      const rebuild = (
        sources: readonly SourceContext[],
        output: CollectionDraft<string, unknown>,
        previousIds: readonly string[],
        reset: boolean
      ): void => {
        const seen = new Set<string>();
        const order: string[] = [];
        const conflicts = compiled.conflict === 'resolve' ? new Set<string>() : undefined;

        for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          const source = sources[sourceIndex];
          if (source.kind !== 'collection')
            throw new Error('derive.keyed.merge requires collection inputs.');
          for (const key of source.read.ids()) {
            const duplicate = seen.has(key);
            if (!duplicate) {
              seen.add(key);
              order.push(key);
            }
            if (compiled.conflict === 'error') {
              if (duplicate)
                throw new TypeError(`derive.keyed.merge duplicate key ${JSON.stringify(key)}.`);
              output.set(key, source.read.get(key));
              continue;
            }
            if (compiled.conflict === 'first') {
              if (!duplicate) output.set(key, source.read.get(key));
              continue;
            }
            if (compiled.conflict === 'last') {
              output.set(key, source.read.get(key));
              continue;
            }
            if (!duplicate) output.set(key, source.read.get(key));
            else conflicts!.add(key);
          }
        }

        if (conflicts) for (const key of conflicts) writeEffective(sources, output, key);
        if (!reset)
          for (const previousKey of previousIds)
            if (!seen.has(previousKey)) output.remove(previousKey);
        output.order(order);
      };

      const rebuildOrder = (
        sources: readonly SourceContext[],
        output: CollectionDraft<string, unknown>
      ): void => {
        const seen = new Set<string>();
        const order: string[] = [];
        for (const source of sources) {
          if (source.kind !== 'collection')
            throw new Error('derive.keyed.merge requires collection inputs.');
          for (const key of source.read.ids()) {
            if (seen.has(key)) continue;
            seen.add(key);
            order.push(key);
          }
        }
        output.order(order);
      };

      return {
        evaluate: evaluation => {
          const output = evaluation.outputs[0];
          if (output.kind !== 'collection')
            throw new Error('derive.keyed.merge requires a collection output.');
          assertCollectionSources(evaluation.sources, capturedSources.length);

          if (evaluation.reset) {
            rebuild(evaluation.sources, output.output, output.previous.ids(), true);
            remember(evaluation.sources);
            return;
          }

          const affected = new Set<string>();
          let fullRebuild = false;
          let orderDirty = false;
          for (let sourceIndex = 0; sourceIndex < evaluation.sources.length; sourceIndex++) {
            const source = evaluation.sources[sourceIndex];
            if (revisions[sourceIndex] === source.revision) continue;
            if (source.kind !== 'collection')
              throw new Error('derive.keyed.merge requires collection inputs.');
            const change = source.change;
            if (!change || change.kind === 'reset') {
              fullRebuild = true;
              continue;
            }
            for (const entry of change.added) affected.add(entry.key);
            for (const entry of change.updated) affected.add(entry.key);
            for (const entry of change.removed) affected.add(entry.key);
            const structural = Boolean(
              change.added.length || change.removed.length || change.order
            );
            if (structural) orderDirty = true;
          }

          if (fullRebuild) {
            rebuild(evaluation.sources, output.output, output.previous.ids(), false);
            remember(evaluation.sources);
            return;
          }

          for (const key of affected) writeEffective(evaluation.sources, output.output, key);
          if (orderDirty) rebuildOrder(evaluation.sources, output.output);
          remember(evaluation.sources);
        },
        release: () => revisions.fill(-1),
      };
    },
    name: 'derive.keyed.merge',
  });
  return projection as KeyedProjection<K, V>;
}

// A string key is already synchronous. Keep this overload first and its key literal
// inference explicit so both key-returning and tuple-returning constant callbacks infer.
function createKeyedSingleton<const K extends string, V>(
  source: Projection<V | undefined>,
  keyOf: (value: V) => K,
  equality?: Equality<V>
): KeyedProjection<K, V>;
function createKeyedSingleton<const D extends ProjectionDependencies, K extends string, V>(
  dependencies: D,
  computeEntry: (values: ProjectionValues<D>) => Synchronous<readonly [K, V] | undefined>,
  equality?: Equality<V>
): KeyedProjection<K, V>;
function createKeyedSingleton<const D extends ProjectionDependencies, K extends string, V>(
  sourceOrDependencies: Projection<V | undefined> | D,
  compute:
    ((value: V) => K) | ((values: ProjectionValues<D>) => Synchronous<readonly [K, V] | undefined>),
  equality?: Equality<V>
): KeyedProjection<K, V> {
  const name = 'derive.keyed.singleton';
  const selection = isProjection(sourceOrDependencies)
    ? {
        kind: 'scalar' as const,
        source: sourceOrDependencies,
        keyOf: compute as (value: V) => K,
      }
    : {
        kind: 'named' as const,
        compiled: compileProjectionDependencies(sourceOrDependencies, name),
        computeEntry: compute as (
          values: ProjectionValues<D>
        ) => Synchronous<readonly [K, V] | undefined>,
      };
  if (selection.kind === 'scalar' && outputKind(selection.source) !== 'value')
    throw new TypeError(`${name} source must be a scalar projection.`);
  if (typeof compute !== 'function')
    throw new TypeError(
      `${name} requires a ${selection.kind === 'scalar' ? 'key selector' : 'compute callback'}.`
    );
  const outputEquality = assertEquality(equality, name);
  const [projection] = defineProcessor({
    dependencies: selection.kind === 'named' ? selection.compiled.projections : [selection.source],
    outputs: [{ kind: 'collection', equality: outputEquality as Equality<unknown> }],
    create: () => ({
      evaluate: evaluation => {
        const output = evaluation.outputs[0];
        if (output.kind !== 'collection') throw new Error(`${name} requires a collection output.`);
        let key: K | undefined;
        let value: unknown;
        if (selection.kind === 'named') {
          const entry = selection.computeEntry(
            snapshotProjectionValues<D>(selection.compiled.names, evaluation.sources)
          );
          assertSynchronous(entry);
          if (entry !== undefined) {
            assertKeyedEntry(entry, name);
            key = entry[0];
            value = entry[1];
          }
        } else {
          const scalar = evaluation.sources[0];
          if (scalar?.kind !== 'value') throw new Error(`${name} resolved a non-scalar input.`);
          value = scalar.value;
          if (value !== undefined) {
            key = selection.keyOf(value as V);
            assertSynchronous(key);
            if (typeof key !== 'string')
              throw new TypeError(`${name} key selector must return a string.`);
          }
        }

        // At most one member: the output owner derives formal order from membership.
        const previousKey = output.previous.ids()[0];
        if (previousKey !== undefined && previousKey !== key) output.output.remove(previousKey);
        if (key !== undefined) output.output.set(key, value);
      },
    }),
    name,
  });
  return projection as KeyedProjection<K, V>;
}

export { createKeyedFrom, createKeyedFromEntries, createKeyedMerge, createKeyedSingleton };
