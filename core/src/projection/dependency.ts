import { isPlainObject } from '../value/record';
import { snapshotCollectionView } from './collection/view';
import type { SourceContext } from './contract';
import { isProjection, projectionRef, type Projection } from './definition';

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
