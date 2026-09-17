import {
  ProjectionDisposedError,
  type CollectionNode,
  type GroupProcess,
  type GroupSpec,
  type ValueNode,
} from './contract';
import { createCollectionState, type CollectionState } from './collection-state';
import { createValueState, type ValueState } from './value-state';
import { profile } from '../profile';
import { assertSynchronous, type NodeRecord, type OutputRecord, type Scheduler } from './scheduler';

type GroupState =
  | { readonly kind: 'value'; readonly state: ValueState<unknown> }
  | { readonly kind: 'collection'; readonly state: CollectionState<string, unknown> };

type GroupNode = ValueNode<unknown> | CollectionNode<string, unknown>;

/**
 * Materializes one processor callback with several value/collection leaves.
 * The scheduler sees one node; each leaf remains an ordinary source record.
 */
export const createGroup = (scheduler: Scheduler, spec: GroupSpec): readonly GroupNode[] => {
  scheduler.assertIdle();
  const sources = Object.entries(spec.sources).map(
    ([key, handle]) => [key, scheduler.source(handle)] as const
  );
  const states: readonly GroupState[] = spec.outputs.map(output =>
    output.kind === 'value'
      ? { kind: 'value', state: createValueState<unknown>() }
      : { kind: 'collection', state: createCollectionState<string, unknown>() }
  );
  let instance: ReturnType<typeof spec.build> | undefined;
  let cause: unknown;
  let changedOutputs: readonly OutputRecord[] = Object.freeze([]);
  let node!: NodeRecord;
  const order = scheduler.order();

  const outputs = states.map(entry => {
    const output: OutputRecord = {
      owner: undefined as unknown as NodeRecord,
      consumers: new Set(),
      context: active => entry.state.context(active, cause),
      revision: entry.state.revision,
      reset: entry.state.reset,
      fault: undefined,
      disposed: false,
      clear: entry.state.clear,
      emit: entry.state.emit,
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

  const makeInput = (
    inputSources: Record<string, unknown>,
    reset: boolean,
    active: () => boolean
  ): GroupProcess => {
    const previous: unknown[] = [];
    const next: (() => unknown)[] = [];
    const drafts: unknown[] = [];
    for (const entry of states) {
      if (entry.kind === 'value') {
        const evaluation = entry.state.begin(active, reset);
        previous.push(evaluation.previous);
        next.push(evaluation.next);
        drafts.push(evaluation.output);
      } else {
        const evaluation = entry.state.begin(active, reset);
        previous.push(evaluation.previous);
        next.push(() => evaluation.next);
        drafts.push(evaluation.output);
      }
    }
    return Object.freeze({
      sources: inputSources,
      previous: Object.freeze(previous),
      next: Object.freeze(next),
      outputs: Object.freeze(drafts),
    });
  };

  const seal = (reset: boolean): readonly OutputRecord[] => {
    const changed: OutputRecord[] = [];
    for (let index = 0; index < states.length; index++) {
      const entry = states[index];
      const output = spec.outputs[index];
      const didChange = entry.state.seal(reset, output.isEqual ?? Object.is);
      if (didChange) changed.push(outputs[index]);
    }
    return Object.freeze(changed);
  };

  const evaluate = (
    inputSources: Record<string, unknown>,
    build: boolean,
    active: () => boolean
  ) => {
    changedOutputs = Object.freeze([]);
    const metadata = Object.values(inputSources).find(
      value =>
        value &&
        typeof value === 'object' &&
        'cause' in value &&
        (value as { readonly cause?: unknown }).cause !== undefined
    ) as { readonly cause?: unknown } | undefined;
    cause = metadata?.cause ?? scheduler.batchContext()?.cause;
    let input = makeInput(inputSources, build, active);
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
        input = makeInput(inputSources, true, active);
        instance = undefined;
        const built = spec.build(input);
        assertSynchronous(built);
        instance = built;
        build = true;
      }
    }
    changedOutputs = seal(build);
    return changedOutputs.length > 0;
  };

  node = {
    owner: undefined as unknown as NodeRecord,
    order,
    name: `processor-group:${spec.outputs.map(output => output.path.join('.')).join(',')} (${order})`,
    sources: sources.map(([, source]) => source),
    consumers: new Set(),
    outputs,
    disposed: false,
    fault: undefined,
    context: () => Object.freeze({ kind: 'group' as const }),
    revision: () => Math.max(0, ...states.map(entry => entry.state.revision())),
    reset: () => states.some(entry => entry.state.reset()),
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
      if (node.fault) states.forEach(entry => entry.state.clear());
      else states.forEach(entry => entry.state.publish());
    },
    emit: () => undefined,
    clear: () => {
      states.forEach(entry => entry.state.clear());
      changedOutputs = Object.freeze([]);
      cause = undefined;
    },
    release: () => {
      states.forEach(entry => entry.state.release());
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

  const handles = states.map((entry, index): GroupNode => {
    const output = outputs[index];
    if (entry.kind === 'value') {
      const handle = Object.freeze({
        kind: 'value' as const,
        current: () => entry.state.current(check),
        revision: () => {
          check();
          return entry.state.revision();
        },
        subscribe: (listener: () => void) => {
          check();
          entry.state.subscribe(listener);
          return () => entry.state.unsubscribe(listener);
        },
      }) as ValueNode<unknown>;
      scheduler.register(handle, output);
      return handle;
    }
    const handle = Object.freeze({
      kind: 'collection' as const,
      current: () => entry.state.current(check),
      revision: () => {
        check();
        return entry.state.revision();
      },
      subscribe: (
        listener: (change: import('./contract').CollectionChange<string, unknown>) => void
      ) => {
        check();
        entry.state.subscribe(listener);
        return () => entry.state.unsubscribe(listener);
      },
    }) as CollectionNode<string, unknown>;
    scheduler.register(handle, output);
    return handle;
  });
  scheduler.addNode(node);
  return Object.freeze(handles);
};
