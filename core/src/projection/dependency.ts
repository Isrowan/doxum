import { isPlainObject } from '@/value/record';
import { snapshotCollectionView } from '@/projection/collection/view';
import type { SourceContext } from './contract';
import { isProjection, projectionRef, type Projection } from './definition';

export type ProjectionDependencies = Readonly<Record<string, Projection<unknown>>> &
  Partial<Record<keyof Projection<unknown>, never>>;
export type ProjectionValues<D extends ProjectionDependencies> = {
  readonly [K in keyof D]: D[K] extends Projection<infer T> ? T : never;
};

export type CompiledProjectionDependencies = {
  readonly names: readonly string[];
  readonly projections: readonly Projection<unknown>[];
};

export type NamedDependencyEntry = {
  readonly name: string;
  readonly value: unknown;
};

/** Owns validation of the shared named dependency object shape. */
export const readNamedDependencyEntries = (
  dependencies: unknown,
  label: string
): readonly NamedDependencyEntry[] => {
  if (!isPlainObject(dependencies) || isProjection(dependencies))
    throw new TypeError(`${label} dependencies must be a plain object.`);
  const entries: NamedDependencyEntry[] = [];
  for (const name of Reflect.ownKeys(dependencies)) {
    if (typeof name !== 'string') throw new TypeError(`${label} dependency names must be strings.`);
    const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError(`${label} dependencies must be enumerable data properties.`);
    entries.push(Object.freeze({ name, value: descriptor.value }));
  }
  return Object.freeze(entries);
};

/** Creates the durable dependency value exposed to pure derive callbacks. */
export const snapshotDependencyValue = (source: SourceContext): unknown =>
  source.kind === 'value' ? source.value : snapshotCollectionView(source.read);

/** Builds the same readonly named value boundary for scalar and keyed pure computations. */
export const snapshotProjectionValues = <D extends ProjectionDependencies>(
  names: readonly string[],
  sources: readonly SourceContext[]
): ProjectionValues<D> => {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < names.length; index++)
    values[names[index]] = snapshotDependencyValue(sources[index]);
  return Object.freeze(values) as ProjectionValues<D>;
};

/** Compiles the shared named Projection dependency declaration contract. */
export const compileProjectionDependencies = (
  dependencies: unknown,
  label: string
): CompiledProjectionDependencies => {
  const names: string[] = [];
  const projections: Projection<unknown>[] = [];
  for (const { name, value } of readNamedDependencyEntries(dependencies, label)) {
    const projection = value as Projection<unknown>;
    projectionRef(projection);
    names.push(name);
    projections.push(projection);
  }
  return Object.freeze({
    names: Object.freeze(names),
    projections: Object.freeze(projections),
  });
};
