import { isPlainObject } from '../value/record';
import { snapshotCollectionView } from './collection/view';
import type { SourceContext } from './contract';
import { isProjection, projectionRef, type Projection } from './definition';

export type CompiledProjectionDependencies = {
  readonly names: readonly string[];
  readonly projections: readonly Projection<unknown>[];
};

/** Creates the durable dependency value exposed to pure derive callbacks. */
export const snapshotDependencyValue = (source: SourceContext): unknown =>
  source.kind === 'value' ? source.value : snapshotCollectionView(source.read);

/** Compiles the shared named Projection dependency declaration contract. */
export const compileProjectionDependencies = (
  dependencies: unknown,
  label: string
): CompiledProjectionDependencies => {
  if (!isPlainObject(dependencies) || isProjection(dependencies))
    throw new TypeError(`${label} dependencies must be a plain object.`);
  const names: string[] = [];
  const projections: Projection<unknown>[] = [];
  for (const key of Reflect.ownKeys(dependencies)) {
    if (typeof key !== 'string') throw new TypeError(`${label} dependency names must be strings.`);
    const descriptor = Object.getOwnPropertyDescriptor(dependencies, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError(`${label} dependencies must be enumerable data properties.`);
    const projection = descriptor.value as Projection<unknown>;
    projectionRef(projection);
    names.push(key);
    projections.push(projection);
  }
  return Object.freeze({
    names: Object.freeze(names),
    projections: Object.freeze(projections),
  });
};
