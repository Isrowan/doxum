import { profile } from '../../profile';
import { createCollectionOutput, type CollectionOutputState } from '../output/collection';
import { ProjectionDisposedError } from '../contract';
import type {
  CollectionOutputEvaluation,
  OutputDefinition,
  OutputEvaluation,
  ProcessorDefinition,
  ProcessorInstance,
  ValueOutputEvaluation,
} from '../definition';
import {
  assertSynchronous,
  type OutputRecord,
  type ProcessorRecord,
  type Scheduler,
} from './scheduler';
import { createValueOutput, type ValueOutputState } from '../output/value';

type BoundOutput =
  | {
      readonly kind: 'value';
      readonly definition: Extract<OutputDefinition, { readonly kind: 'value' }>;
      readonly state: ValueOutputState<unknown>;
    }
  | {
      readonly kind: 'collection';
      readonly definition: Extract<OutputDefinition, { readonly kind: 'collection' }>;
      readonly state: CollectionOutputState<string, unknown>;
    };

/** Materializes every derive/incremental/group definition through one processor lifecycle. */
export const createProcessor = (
  scheduler: Scheduler,
  definition: ProcessorDefinition,
  dependencies: readonly OutputRecord[]
): ProcessorRecord => {
  scheduler.assertIdle();
  let processor!: ProcessorRecord;
  let instance: ProcessorInstance | undefined;
  let cause: unknown;

  const check = () => {
    if (!scheduler.active || processor.disposed) throw new ProjectionDisposedError();
    if (processor.fault) throw processor.fault;
  };

  const bound: readonly BoundOutput[] = definition.outputs.map(outputDefinition => {
    if (outputDefinition.kind === 'value') {
      const state = createValueOutput<unknown>({
        owner: () => processor,
        check,
        cause: () => cause,
      });
      return { kind: 'value', definition: outputDefinition, state };
    }
    const state = createCollectionOutput<string, unknown>({
      owner: () => processor,
      check,
      cause: () => cause,
    });
    return { kind: 'collection', definition: outputDefinition, state };
  });

  const begin = (active: () => boolean, initialize: boolean): readonly OutputEvaluation[] =>
    Object.freeze(
      bound.map(entry => {
        if (entry.kind === 'value') {
          const evaluation = entry.state.begin(active, initialize);
          return Object.freeze({ kind: 'value' as const, ...evaluation }) as ValueOutputEvaluation;
        }
        const evaluation = entry.state.begin(active, initialize);
        return Object.freeze({
          kind: 'collection' as const,
          ...evaluation,
        }) as CollectionOutputEvaluation;
      })
    );

  const seal = (reset: boolean): readonly OutputRecord[] => {
    const changed: OutputRecord[] = [];
    for (const entry of bound) {
      const didChange = entry.state.seal(reset, entry.definition.equality);
      if (didChange) changed.push(entry.state);
    }
    return Object.freeze(changed);
  };

  const run = (reset: boolean, runCause: unknown, recreate = false): readonly OutputRecord[] => {
    cause = runCause;
    let active = true;
    try {
      const scopeActive = () => active;
      const sources = Object.freeze(dependencies.map(output => output.context(scopeActive)));
      const outputs = begin(scopeActive, reset);
      if (recreate && instance) {
        instance.release?.();
        instance = undefined;
      }
      if (!instance) instance = definition.create();
      profile.materialized[reset ? 'rebuilt' : 'updated']();
      const result = instance.evaluate({ reset, cause: runCause, sources, outputs });
      assertSynchronous(result);
      return seal(reset);
    } finally {
      active = false;
    }
  };

  const order = scheduler.order();
  processor = {
    kind: 'processor',
    order,
    name: definition.name ? `${definition.name} (${order})` : `projection-${order}`,
    dependencies: Object.freeze([...dependencies]),
    outputs: Object.freeze(bound.map(entry => entry.state)),
    fault: undefined,
    disposed: false,
    evaluate: run,
    publish: () => bound.forEach(entry => entry.state.publish()),
    clear: () => {
      bound.forEach(entry => entry.state.clear());
      cause = undefined;
    },
    release: () => {
      const current = instance;
      instance = undefined;
      const failures: unknown[] = [];
      try {
        current?.release?.();
      } catch (error) {
        failures.push(error);
      }
      for (const entry of bound) {
        try {
          entry.state.release();
        } catch (error) {
          failures.push(error);
        }
      }
      cause = undefined;
      if (failures.length) throw failures[0];
    },
  };

  try {
    scheduler.initialize(() => {
      const invalid = dependencies.find(output => output.owner.fault || output.owner.disposed);
      if (invalid) throw invalid.owner.fault ?? new ProjectionDisposedError();
      const changed = processor.evaluate(true, undefined);
      if (changed.length) processor.publish();
      processor.clear();
    });
    scheduler.addProcessor(processor);
  } catch (error) {
    processor.disposed = true;
    try {
      processor.release();
    } catch {
      /* Initialization failure retains priority. */
    }
    throw error;
  }
  return processor;
};
