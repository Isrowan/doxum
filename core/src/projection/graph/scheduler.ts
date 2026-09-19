import { profile } from '../../profile';
import type { ObserverError, Unsubscribe } from '../../runtime/contract';
import type { BatchContext, CollectionChange, SourceContext } from '../contract';
import { ProjectionDisposedError, ProjectionError } from '../contract';

type BatchOptions = { readonly cause?: unknown };

type ProducerBase = {
  readonly name: string;
  readonly outputs: readonly OutputRecord[];
  fault: ProjectionError | undefined;
  disposed: boolean;
  clear(): void;
  release(): void;
};

export type OutputRecord = {
  readonly kind: 'value' | 'collection';
  readonly owner: ProducerRecord;
  readonly consumers: Set<ProcessorRecord>;
  context(active: () => boolean): SourceContext;
  current(): unknown;
  revision(): number;
  reset(): boolean;
  subscribe(listener: (change?: CollectionChange<string, unknown>) => void): Unsubscribe;
  emit(call: (listener: () => void) => void): void;
  clear(): void;
  release(): void;
};

export type SourceBoundaryRecord = ProducerBase & {
  readonly kind: 'source';
  readonly outputs: readonly [OutputRecord];
  pendingCause(): unknown;
  recovering(): boolean;
  prepare(cause: unknown): { readonly changed: boolean; readonly force: boolean };
  publish(): void;
};

export type ProcessorRecord = ProducerBase & {
  readonly kind: 'processor';
  readonly dependencies: readonly OutputRecord[];
  readonly order: number;
  evaluate(reset: boolean, cause: unknown, recreate?: boolean): readonly OutputRecord[];
  publish(): void;
};

export type ProducerRecord = SourceBoundaryRecord | ProcessorRecord;

export const createScheduler = (onError: (error: ProjectionError) => void) => {
  let disposed = false;
  let depth = 0;
  let batchSequence = 0;
  let activeBatch: BatchContext | undefined;
  let phase: 'idle' | 'compute' | 'notify' = 'idle';
  let sequence = 0;
  const sources = new Set<SourceBoundaryRecord>();
  const processors = new Set<ProcessorRecord>();
  const pendingSources = new Set<SourceBoundaryRecord>();
  const heap: ProcessorRecord[] = [];
  const queued = new Set<ProcessorRecord>();
  const completed = new Set<ProcessorRecord>();
  const emissions = new Set<OutputRecord>();
  const errors: ProjectionError[] = [];
  let reportingFailures: unknown[] = [];
  const guards = new Set<(locked: boolean) => void>();
  const cleanups = new Set<() => void>();

  const assertActive = () => {
    if (disposed) throw new ProjectionDisposedError();
  };
  const assertIdle = () => {
    assertActive();
    if (phase !== 'idle')
      throw new Error('Projection cannot be re-entered during processing or notification.');
  };
  const lock = (value: boolean) => guards.forEach(guard => guard(value));

  const enqueue = (processor: ProcessorRecord) => {
    if (processor.disposed || queued.has(processor)) return;
    queued.add(processor);
    profile.projection('scheduledNodes');
    let index = heap.length;
    heap.push(processor);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].order < processor.order) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = processor;
  };

  const pop = (): ProcessorRecord => {
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].order < heap[child].order) child++;
        if (last.order < heap[child].order) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };

  const errorFor = (
    producer: ProducerRecord,
    cause: unknown,
    kind: ProjectionError['phase'] = producer.kind === 'source' ? 'source' : 'processor'
  ) => new ProjectionError(kind, cause);

  const capture = (source: SourceBoundaryRecord) => {
    if (disposed) return;
    if (phase !== 'idle') {
      source.fault = errorFor(
        source,
        new Error('Source changed while projection was running.'),
        'source'
      );
      errors.push(source.fault);
      throw source.fault;
    }
    pendingSources.add(source);
    profile.projection('sourceEvents');
    if (source.fault) errors.push(source.fault);
  };

  const settleCause = (): unknown => {
    if (activeBatch?.cause !== undefined) return activeBatch.cause;
    for (const source of pendingSources) {
      const cause = source.pendingCause();
      if (cause !== undefined) return cause;
    }
    return undefined;
  };

  const settle = () => {
    if (disposed || depth || phase !== 'idle') return;
    phase = 'compute';
    lock(true);
    const cause = settleCause();
    try {
      for (const source of pendingSources) {
        if (source.disposed) continue;
        const wasFaulted = source.fault !== undefined;
        let changed = false;
        let force = false;
        if (!source.fault || source.recovering()) {
          try {
            const prepared = source.prepare(cause);
            changed = prepared.changed;
            force = prepared.force;
            source.fault = undefined;
          } catch (failure) {
            source.fault = errorFor(source, failure, 'source');
            errors.push(source.fault);
          }
        }
        const recovered = wasFaulted && !source.fault;
        if (changed) source.publish();
        if (source.fault || changed || force || recovered) {
          const output = source.outputs[0];
          emissions.add(output);
          output.consumers.forEach(enqueue);
        }
      }

      while (heap.length) {
        const processor = pop();
        if (processor.disposed) continue;
        const wasFaulted = processor.fault !== undefined;
        profile.projection('processedNodes');
        let changedOutputs: readonly OutputRecord[] = Object.freeze([]);
        const blocked = processor.dependencies.find(
          output => output.owner.fault || output.owner.disposed
        );
        if (blocked) {
          processor.fault = errorFor(
            processor,
            blocked.owner.fault ?? new ProjectionDisposedError(),
            'blocked'
          );
        } else {
          const reset = wasFaulted || processor.dependencies.some(output => output.reset());
          try {
            changedOutputs = processor.evaluate(reset, cause, wasFaulted);
            const dependencyFailure = processor.dependencies.find(output => output.owner.fault)
              ?.owner.fault;
            if (dependencyFailure) throw dependencyFailure;
            processor.fault = undefined;
          } catch (failure) {
            const error = errorFor(processor, failure);
            processor.fault = error;
            if (!reset) {
              try {
                changedOutputs = processor.evaluate(true, cause, true);
                const dependencyFailure = processor.dependencies.find(output => output.owner.fault)
                  ?.owner.fault;
                if (dependencyFailure) throw dependencyFailure;
                processor.fault = undefined;
                errors.push(error);
              } catch (rebuildFailure) {
                processor.fault = errorFor(processor, rebuildFailure);
                errors.push(processor.fault);
              }
            } else errors.push(error);
          }
        }
        completed.add(processor);
        const recovered = wasFaulted && !processor.fault;
        if (processor.fault) {
          processor.outputs.forEach(output => {
            emissions.add(output);
            output.consumers.forEach(enqueue);
          });
        } else {
          if (changedOutputs.length) {
            processor.publish();
            changedOutputs.forEach(output => emissions.add(output));
          }
          const propagated = recovered ? processor.outputs : changedOutputs;
          propagated.forEach(output => output.consumers.forEach(enqueue));
        }
        if (processor.fault || changedOutputs.length) {
          profile.projection('publishedNodes');
        }
      }
    } finally {
      lock(false);
      phase = 'idle';
    }
  };

  const flush = (): readonly ObserverError[] => {
    if (disposed || depth) return [];
    if (pendingSources.size || completed.size) profile.projection('flushes');
    phase = 'notify';
    lock(true);
    const reportFailures: unknown[] = [];
    try {
      emissions.forEach(output =>
        output.emit(listener => {
          try {
            listener();
          } catch (cause) {
            errors.push(errorFor(output.owner, cause, 'listener'));
          }
        })
      );
      for (const error of errors.slice()) {
        try {
          onError(error);
        } catch (cause) {
          reportFailures.push(cause);
        }
      }
      return Object.freeze([
        ...errors.map(error =>
          Object.freeze({
            phase: error.phase === 'listener' ? ('listener' as const) : ('processor' as const),
            error,
          })
        ),
        ...reportFailures.map(error => Object.freeze({ phase: 'listener' as const, error })),
      ]);
    } finally {
      pendingSources.forEach(source => source.clear());
      completed.forEach(processor => processor.clear());
      pendingSources.clear();
      queued.clear();
      completed.clear();
      emissions.clear();
      errors.length = 0;
      reportingFailures = reportFailures;
      lock(false);
      phase = 'idle';
    }
  };

  const run = () => {
    settle();
    const result = flush();
    const failures = reportingFailures;
    reportingFailures = [];
    if (failures.length) throw new AggregateError(failures, 'Projection error reporter failed.');
    return result;
  };

  const batch = <T>(optionsOrCallback: BatchOptions | (() => T), maybeCallback?: () => T): T => {
    assertIdle();
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new TypeError('Projection batch requires a callback.');
    const outer = depth === 0;
    if (outer)
      activeBatch = Object.freeze({
        id: ++batchSequence,
        ...(options?.cause === undefined ? {} : { cause: options.cause }),
      });
    depth++;
    let failed = false;
    try {
      const value = callback();
      assertSynchronous(value);
      return value;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      depth--;
      if (!depth) {
        try {
          if (failed) {
            try {
              run();
            } catch {
              /* The original application error retains priority. */
            }
          } else run();
        } finally {
          activeBatch = undefined;
        }
      }
    }
  };

  const releaseProducer = (producer: ProducerRecord) => {
    assertIdle();
    if (producer.outputs.some(output => output.consumers.size))
      throw new Error('Projection producer is still used by another processor.');
    producer.disposed = true;
    if (producer.kind === 'processor') {
      producer.dependencies.forEach(output => output.consumers.delete(producer));
      processors.delete(producer);
      queued.delete(producer);
      completed.delete(producer);
    } else {
      sources.delete(producer);
      pendingSources.delete(producer);
    }
    producer.release();
    producer.clear();
    producer.outputs.forEach(output => emissions.delete(output));
  };

  return {
    assertActive,
    assertIdle,
    capture,
    settle,
    flush,
    run,
    guards,
    cleanups,
    get active() {
      return !disposed;
    },
    addSource(source: SourceBoundaryRecord) {
      assertIdle();
      sources.add(source);
    },
    addProcessor(processor: ProcessorRecord) {
      assertIdle();
      processors.add(processor);
      processor.dependencies.forEach(output => output.consumers.add(processor));
    },
    releaseProducer,
    order: () => sequence++,
    initialize<T>(callback: () => T): T {
      assertIdle();
      phase = 'compute';
      lock(true);
      try {
        return callback();
      } finally {
        lock(false);
        phase = 'idle';
      }
    },
    batch,
    batchContext: () => activeBatch,
    dispose() {
      if (disposed) return;
      assertIdle();
      disposed = true;
      const failures: unknown[] = [];
      cleanups.forEach(cleanup => {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        }
      });
      cleanups.clear();
      processors.forEach(processor => {
        processor.disposed = true;
        try {
          processor.release();
        } catch (error) {
          failures.push(error);
        }
      });
      sources.forEach(source => {
        source.disposed = true;
        try {
          source.release();
        } catch (error) {
          failures.push(error);
        }
      });
      processors.clear();
      sources.clear();
      pendingSources.clear();
      heap.length = 0;
      queued.clear();
      completed.clear();
      emissions.clear();
      guards.clear();
      errors.length = 0;
      reportingFailures = [];
      if (failures.length) throw new AggregateError(failures, 'Projection cleanup failed.');
    },
  };
};

export type Scheduler = ReturnType<typeof createScheduler>;

export const assertSynchronous = (value: unknown): void => {
  if (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
    throw new TypeError('Projection callbacks must be synchronous.');
};

export const assertScope = (active: () => boolean) => {
  if (!active()) throw new Error('Projection reader or writer is no longer active.');
};
