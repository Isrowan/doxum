import type { Synchronous } from '@/runtime/contract';
import { isPlainObject } from '@/value/record';
import { collectionView, mapRead } from '@/projection/collection/view';
import type { SourceContext } from '@/projection/contract';
import { readNamedDependencyEntries, snapshotDependencyValue } from '@/projection/dependency';
import {
  isProjection,
  outputDefinitionOf,
  type KeyedProjection,
  type Projection,
} from '@/projection/definition';
import { assertSynchronous } from '@/projection/graph/scheduler';
import { createKeyRelation, type KeyRelation } from './relation';

export type SingularKeyedDependency<
  DriverKey extends string,
  DriverValue,
  SourceKey extends string,
  SourceValue,
> = {
  readonly source: KeyedProjection<SourceKey, SourceValue>;
  readonly key: (value: DriverValue, key: DriverKey) => Synchronous<SourceKey | undefined>;
  readonly keys?: never;
};

export type SameKeyedDependency<SourceKey extends string, SourceValue> = {
  readonly source: KeyedProjection<SourceKey, SourceValue>;
  readonly key?: never;
  readonly keys?: never;
};

export type PluralKeyedDependency<
  DriverKey extends string,
  DriverValue,
  SourceKey extends string,
  SourceValue,
> = {
  readonly source: KeyedProjection<SourceKey, SourceValue>;
  readonly keys: (value: DriverValue, key: DriverKey) => Synchronous<readonly SourceKey[]>;
  readonly key?: never;
};

export type KeyedDependency<DriverKey extends string, DriverValue> =
  | (Projection<unknown> & {
      readonly source?: never;
      readonly key?: never;
      readonly keys?: never;
    })
  | SameKeyedDependency<string, unknown>
  | SingularKeyedDependency<DriverKey, DriverValue, string, unknown>
  | PluralKeyedDependency<DriverKey, DriverValue, string, unknown>;

export type KeyedDependencyRecord<DriverKey extends string, DriverValue> = Readonly<
  Record<string, KeyedDependency<DriverKey, DriverValue>>
>;

type SameKeyConstraint<DriverKey extends string, Dependency> = Dependency extends {
  readonly source: KeyedProjection<infer SourceKey extends string, unknown>;
}
  ? Dependency extends { readonly key: unknown } | { readonly keys: unknown }
    ? unknown
    : [DriverKey] extends [SourceKey]
      ? unknown
      : never
  : unknown;

export type KeyedDependencies<DriverKey extends string, DriverValue, D extends object> = {
  readonly [P in keyof D]: P extends string
    ? KeyedDependency<DriverKey, DriverValue> & SameKeyConstraint<DriverKey, D[P]>
    : never;
};

export type KeyedDependencyValues<D extends object> = {
  readonly [P in keyof D]: D[P] extends {
    readonly source: KeyedProjection<infer K extends string, infer V>;
    readonly keys: (...args: never[]) => unknown;
  }
    ? ReadonlyMap<K, V>
    : D[P] extends {
          readonly source: KeyedProjection<infer _K extends string, infer V>;
        }
      ? V | undefined
      : D[P] extends Projection<infer T>
        ? T
        : never;
};

type CompiledDynamicKeyedDependency =
  | {
      readonly kind: 'same';
      readonly projection: Projection<unknown>;
    }
  | {
      readonly kind: 'one';
      readonly projection: Projection<unknown>;
      readonly select: (value: unknown, key: string) => unknown;
    }
  | {
      readonly kind: 'many';
      readonly projection: Projection<unknown>;
      readonly select: (value: unknown, key: string) => unknown;
    };

type CompiledKeyedDependency =
  | {
      readonly name: string;
      readonly kind: 'global';
      readonly projection: Projection<unknown>;
    }
  | ({ readonly name: string } & CompiledDynamicKeyedDependency);

export type CompiledKeyedDependencies = {
  readonly entries: readonly CompiledKeyedDependency[];
  readonly projections: readonly Projection<unknown>[];
};

export const outputKind = (projection: Projection<unknown>): 'value' | 'collection' =>
  outputDefinitionOf(projection).kind;

export const assertKeyedProjection = (projection: Projection<unknown>, role: string): void => {
  if (outputKind(projection) !== 'collection')
    throw new TypeError(`${role} must be a keyed collection projection.`);
};

const compileDynamicDependency = (
  value: unknown,
  label: string
): CompiledDynamicKeyedDependency => {
  if (!isPlainObject(value) || isProjection(value))
    throw new TypeError(`${label} dependencies must be projections or keyed lookups.`);
  const candidate: { source?: unknown; key?: unknown; keys?: unknown } = {};
  const allowed = new Set(['source', 'key', 'keys']);
  let hasKey = false;
  let hasKeys = false;
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== 'string' || !allowed.has(name))
      throw new TypeError(`${label} dynamic keyed dependency contains an unknown property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError(`${label} dynamic keyed dependency must use enumerable data properties.`);
    candidate[name as 'source' | 'key' | 'keys'] = descriptor.value;
    if (name === 'key') hasKey = true;
    if (name === 'keys') hasKeys = true;
  }
  if (!isProjection(candidate.source))
    throw new TypeError(`${label} dynamic keyed dependency source must be a projection.`);
  if (hasKey && hasKeys)
    throw new TypeError(`${label} dynamic keyed dependency must not declare both key and keys.`);
  assertKeyedProjection(candidate.source, `${label} dynamic keyed dependency source`);
  if (!hasKey && !hasKeys)
    return {
      kind: 'same',
      projection: candidate.source,
    };
  const singular = hasKey;
  const selector = singular ? candidate.key : candidate.keys;
  if (typeof selector !== 'function')
    throw new TypeError(`${label} dynamic keyed dependency selector must be a function.`);
  return singular
    ? {
        kind: 'one',
        projection: candidate.source,
        select: selector as (value: unknown, key: string) => unknown,
      }
    : {
        kind: 'many',
        projection: candidate.source,
        select: selector as (value: unknown, key: string) => unknown,
      };
};

export const compileKeyedDependencies = (
  driver: Projection<unknown>,
  dependencySpecs: KeyedDependencyRecord<string, unknown> | undefined,
  label: string
): CompiledKeyedDependencies => {
  const entries: CompiledKeyedDependency[] = [];
  const projections: Projection<unknown>[] = [driver];
  if (dependencySpecs === undefined)
    return Object.freeze({
      entries: Object.freeze(entries),
      projections: Object.freeze(projections),
    });
  for (const { name, value: dependency } of readNamedDependencyEntries(dependencySpecs, label)) {
    if (isProjection(dependency)) {
      entries.push(Object.freeze({ name, kind: 'global' as const, projection: dependency }));
      projections.push(dependency);
      continue;
    }
    const dynamic = compileDynamicDependency(dependency, label);
    entries.push(Object.freeze({ name, ...dynamic }));
    projections.push(dynamic.projection);
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    projections: Object.freeze(projections),
  });
};

const selectedKey = (
  dependency: Extract<CompiledDynamicKeyedDependency, { readonly kind: 'one' }>,
  value: unknown,
  key: string
): string | undefined => {
  const result = dependency.select(value, key);
  assertSynchronous(result);
  if (result === undefined) return undefined;
  if (typeof result !== 'string')
    throw new TypeError('Dynamic keyed dependency key must be a string or undefined.');
  return result;
};

const selectedKeys = (
  dependency: Extract<CompiledDynamicKeyedDependency, { readonly kind: 'many' }>,
  value: unknown,
  key: string
): readonly string[] => {
  const result = dependency.select(value, key);
  assertSynchronous(result);
  if (!Array.isArray(result))
    throw new TypeError('Dynamic keyed dependency keys must be an array of strings.');
  const seen = new Set<string>();
  for (const selected of result) {
    if (typeof selected !== 'string')
      throw new TypeError('Dynamic keyed dependency keys must contain only strings.');
    if (seen.has(selected))
      throw new TypeError('Dynamic keyed dependency keys must not contain duplicates.');
    seen.add(selected);
  }
  return result as readonly string[];
};

export type KeyedDependencyRuntime = {
  prepare(sources: readonly SourceContext[], reset: boolean): void;
  resolve(
    driverValue: unknown,
    driverKey: string,
    sources: readonly SourceContext[]
  ): Readonly<Record<string, unknown>>;
  driverChanged(source: SourceContext): boolean;
  collectInvalidated(sources: readonly SourceContext[], dirty: Set<string>): boolean;
  remove(driverKey: string): void;
  clearBindings(): void;
  remember(sources: readonly SourceContext[]): void;
  release(): void;
};

const emptyValues: Readonly<Record<string, unknown>> = Object.freeze(
  Object.create(null) as Record<string, unknown>
);

export const createKeyedDependencyRuntime = (
  compiled: CompiledKeyedDependencies
): KeyedDependencyRuntime => {
  type GlobalDependencyState = {
    readonly kind: 'global';
    readonly entry: Extract<CompiledKeyedDependency, { readonly kind: 'global' }>;
    readonly sourceIndex: number;
    revision: number;
    globalValue: unknown;
  };
  type SameDependencyState = {
    readonly kind: 'same';
    readonly entry: Extract<CompiledKeyedDependency, { readonly kind: 'same' }>;
    readonly sourceIndex: number;
    revision: number;
  };
  type DynamicDependencyState = {
    readonly kind: 'dynamic';
    readonly entry: Extract<CompiledKeyedDependency, { readonly kind: 'one' | 'many' }>;
    readonly sourceIndex: number;
    readonly relation: KeyRelation;
    revision: number;
  };
  type DependencyState = GlobalDependencyState | SameDependencyState | DynamicDependencyState;
  const states: DependencyState[] = compiled.entries.map((entry, index) => {
    const sourceIndex = index + 1;
    if (entry.kind === 'global')
      return { kind: 'global', entry, sourceIndex, revision: -1, globalValue: undefined };
    if (entry.kind === 'same') return { kind: 'same', entry, sourceIndex, revision: -1 };
    return {
      kind: 'dynamic',
      entry,
      sourceIndex,
      relation: createKeyRelation(),
      revision: -1,
    };
  });
  let driverRevision = -1;

  return {
    prepare(sources, reset) {
      for (const state of states) {
        if (state.kind !== 'global') continue;
        const source = sources[state.sourceIndex];
        if (reset || state.revision !== source.revision)
          state.globalValue = snapshotDependencyValue(source);
      }
    },
    resolve(driverValue, driverKey, sources) {
      if (!states.length) return emptyValues;
      const values = Object.create(null) as Record<string, unknown>;
      for (const state of states) {
        if (state.kind === 'global') {
          values[state.entry.name] = state.globalValue;
          continue;
        }
        const source = sources[state.sourceIndex];
        if (source.kind !== 'collection')
          throw new TypeError('Dynamic keyed dependency resolved to a non-collection source.');
        if (state.kind === 'same') {
          values[state.entry.name] = source.read.get(driverKey);
          continue;
        }
        const dependency = state.entry;
        if (dependency.kind === 'one') {
          const selected = selectedKey(dependency, driverValue, driverKey);
          state.relation.replaceOne(driverKey, selected);
          values[dependency.name] = selected === undefined ? undefined : source.read.get(selected);
          continue;
        }
        const keys = selectedKeys(dependency, driverValue, driverKey);
        state.relation.replace(driverKey, keys);
        const selected = new Map<string, unknown>();
        for (const key of keys) if (source.read.has(key)) selected.set(key, source.read.get(key));
        values[dependency.name] = collectionView(mapRead(selected));
      }
      return Object.freeze(values);
    },
    driverChanged(source) {
      return driverRevision !== source.revision;
    },
    collectInvalidated(sources, dirty) {
      let all = false;
      for (const state of states) {
        const source = sources[state.sourceIndex];
        if (state.revision === source.revision) continue;
        if (state.kind === 'global') {
          all = true;
          continue;
        }
        if (source.kind !== 'collection' || !source.change || source.change.kind === 'reset') {
          all = true;
          continue;
        }
        if (state.kind === 'same') {
          for (const entry of source.change.added) dirty.add(entry.key);
          for (const entry of source.change.updated) dirty.add(entry.key);
          for (const entry of source.change.removed) dirty.add(entry.key);
          continue;
        }
        for (const entry of source.change.added)
          for (const dependent of state.relation.reverse(entry.key) ?? []) dirty.add(dependent);
        for (const entry of source.change.updated)
          for (const dependent of state.relation.reverse(entry.key) ?? []) dirty.add(dependent);
        for (const entry of source.change.removed)
          for (const dependent of state.relation.reverse(entry.key) ?? []) dirty.add(dependent);
      }
      return all;
    },
    remove(driverKey) {
      for (const state of states) if (state.kind === 'dynamic') state.relation.delete(driverKey);
    },
    clearBindings() {
      for (const state of states) if (state.kind === 'dynamic') state.relation.clear();
    },
    remember(sources) {
      driverRevision = sources[0]?.revision ?? -1;
      for (const state of states) state.revision = sources[state.sourceIndex].revision;
    },
    release() {
      for (const state of states) {
        state.revision = -1;
        if (state.kind === 'global') state.globalValue = undefined;
        else if (state.kind === 'dynamic') state.relation.clear();
      }
      driverRevision = -1;
    },
  };
};
