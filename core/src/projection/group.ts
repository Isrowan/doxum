import { ProjectionDisposedError, type CollectionNode, type CollectionGroupSpec } from './contract';
import { createCollectionState } from './collection-state';
import { profile } from '../profile';
import {
  assertScope,
  assertSynchronous,
  type NodeRecord,
  type OutputRecord,
  type Scheduler,
} from './scheduler';

/**
 * Materializes one processor callback with several keyed output leaves. The
 * scheduler sees one node and the output leaves remain ordinary source records
 * for dependency, revision and listener matching.
 */
export const createCollectionGroup = (
  scheduler: Scheduler,
  spec: CollectionGroupSpec
): readonly CollectionNode<string, unknown>[] => {
  scheduler.assertIdle();
  const sources = Object.entries(spec.sources).map(
    ([key, handle]) => [key, scheduler.source(handle)] as const
  );
  const states = spec.outputs.map(() => createCollectionState<string, unknown>());
  let instance: ReturnType<typeof spec.build> | undefined;
  let cause: unknown;
  let changedOutputs: readonly OutputRecord[] = Object.freeze([]);
  let node!: NodeRecord;
  const order = scheduler.order();

  const outputs = states.map((state, index) => {
    const output: OutputRecord = {
      owner: undefined as unknown as NodeRecord,
      consumers: new Set(),
      context: active => state.context(active, cause),
      revision: state.revision,
      reset: state.reset,
      fault: undefined,
      disposed: false,
      clear: state.clear,
      emit: state.emit,
    };
    Object.defineProperty(output, 'fault', {
      configurable: false,
      enumerable: true,
      get: () => node.fault,
      set: value => {
        node.fault = value;
      },
    });
    return output;
  });

  const check = () => {
    if (node.disposed || !scheduler.active) throw new ProjectionDisposedError();
    if (node.fault) throw node.fault;
  };

  const evaluate = (
    inputSources: Record<string, unknown>,
    build: boolean,
    active: () => boolean
  ) => {
    const metadata = Object.values(inputSources).find(
      value =>
        value &&
        typeof value === 'object' &&
        'cause' in value &&
        (value as { readonly cause?: unknown }).cause !== undefined
    ) as { readonly cause?: unknown } | undefined;
    cause = metadata?.cause ?? scheduler.batchContext()?.cause;
    const makeInput = (reset: boolean) => {
      const evaluations = states.map(state => state.begin(active, reset));
      return {
        sources: inputSources,
        previous: evaluations.map(evaluation => evaluation.previous),
        next: evaluations.map(evaluation => evaluation.next),
        outputs: evaluations.map(evaluation => evaluation.output),
      };
    };
    let input = makeInput(build);
    if (build || !instance) {
      profile.materialized.rebuilt();
      instance = undefined;
      const built = spec.build(input);
      assertSynchronous(built);
      instance = built;
    } else {
      profile.materialized.updated();
      const result = instance.update(input);
      assertSynchronous(result);
      if (result?.kind === 'rebuild') {
        input = makeInput(true);
        instance = undefined;
        const built = spec.build(input);
        assertSynchronous(built);
        instance = built;
        build = true;
      }
    }
    changedOutputs = Object.freeze(
      states.flatMap((state, index) =>
        state.seal(build, spec.outputs[index].isEqual ?? Object.is) ? [outputs[index]] : []
      )
    );
    return changedOutputs.length > 0;
  };

  node = {
    owner: undefined as unknown as NodeRecord,
    order,
    name: `processor-group (${order})`,
    sources: sources.map(([, source]) => source),
    consumers: new Set(),
    outputs,
    disposed: false,
    fault: undefined,
    context: active => {
      assertScope(active);
      return Object.freeze({ kind: 'group' as const });
    },
    revision: () => Math.max(0, ...states.map(state => state.revision())),
    reset: () => states.some(state => state.reset()),
    evaluate: build => {
      let active = true;
      try {
        const scopeActive = () => active;
        const inputs = Object.fromEntries(
          sources.map(([key, source]) => [key, source.context(scopeActive)])
        ) as Record<string, unknown>;
        return evaluate(inputs, build, scopeActive);
      } finally {
        active = false;
      }
    },
    changedOutputs: () => changedOutputs,
    publish: () => {
      if (node.fault) states.forEach(state => state.clear());
      else states.forEach(state => state.publish());
    },
    emit: () => undefined,
    clear: () => {
      states.forEach(state => state.clear());
      changedOutputs = Object.freeze([]);
      cause = undefined;
    },
    release: () => {
      states.forEach(state => state.release());
      outputs.forEach(output => {
        output.disposed = true;
        output.consumers.clear();
      });
      instance = undefined;
    },
  };
  (node as { owner: NodeRecord }).owner = node;
  outputs.forEach(output => {
    (output as { owner: NodeRecord }).owner = node;
  });

  scheduler.initialize(() => {
    const invalid = node.sources.find(source => source.fault || source.disposed);
    if (invalid) throw invalid.fault ?? new ProjectionDisposedError();
    node.evaluate(true);
    node.publish();
    node.clear();
  });
  const handles = outputs.map((output, index) => {
    const handle = {
      kind: 'collection' as const,
      current: () => {
        check();
        return states[index].current(check);
      },
      revision: () => {
        check();
        return states[index].revision();
      },
      subscribe: (
        listener: (change: import('./contract').CollectionChange<string, unknown>) => void
      ) => {
        check();
        states[index].subscribe(listener);
        return () => states[index].unsubscribe(listener);
      },
    } as CollectionNode<string, unknown>;
    scheduler.register(handle, output);
    return Object.freeze(handle);
  });
  scheduler.addNode(node);
  return Object.freeze(handles);
};
