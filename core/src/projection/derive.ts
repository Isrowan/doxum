import type { Synchronous } from '@/runtime/contract';
import {
  compileProjectionDependencies,
  snapshotProjectionValues,
  type ProjectionDependencies,
  type ProjectionValues,
} from './dependency';
import { defineProcessor, type Projection } from './definition';
import { keyedDerive } from '@/projection/derive/keyed';
import { assertSynchronous } from '@/projection/graph/scheduler';

type Equality<T> = (previous: T, next: T) => boolean;

function createValueDerive<const D extends ProjectionDependencies, T>(
  dependencies: D,
  compute: (values: ProjectionValues<D>) => Synchronous<T>,
  equality: Equality<T> = Object.is
): Projection<T> {
  const compiled = compileProjectionDependencies(dependencies, 'Derive');
  const names = compiled.names;
  const ordered = compiled.projections;
  const [projection] = defineProcessor({
    dependencies: ordered,
    outputs: [{ kind: 'value', equality: equality as Equality<unknown> }],
    create: () => ({
      evaluate: evaluation => {
        const output = evaluation.outputs[0];
        if (output.kind !== 'value') throw new Error('derive requires a value output.');
        const next = compute(snapshotProjectionValues<D>(names, evaluation.sources));
        assertSynchronous(next);
        output.output.set(next);
      },
    }),
  });
  return projection as Projection<T>;
}

export const derive = Object.assign(createValueDerive, { keyed: keyedDerive });
