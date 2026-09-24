import { profile } from '@/profile';
import type { ObserverError, Unsubscribe } from '@/runtime/contract';
import type { BatchContext, CollectionChange, SourceContext } from '@/projection/contract';
import { ProjectionDisposedError, ProjectionError } from '@/projection/contract';

type BatchOptions = { readonly cause?: unknown };

type ProducerBase = {
  readonly name: string;
  readonly outputs: readonly OutputRecord[];
  fault: ProjectionError | undefined;
  disposed: boolean;
  clear(): void;
  release(): void;
};

export type OutputListener = (change?: CollectionChange<string, unknown>) => void;

export type OutputRecord = {
  readonly kind: 'value' | 'collection';
  readonly owner: ProducerRecord;
  context(active: () => boolean, consumer?: ProcessorRecord): SourceContext;
  acknowledge(consumer: ProcessorRecord): void;
  pending(consumer: ProcessorRecord): boolean;
  current(): unknown;
  revision(): number;
  reset(consumer?: ProcessorRecord): boolean;
  subscribe(listener: OutputListener): Unsubscribe;
  observe(listener: OutputListener): Unsubscribe;
  emit(
    call: (listener: OutputListener, change?: CollectionChange<string, unknown>) => void,
    force?: boolean
  ): void;
  finish(): void;
  hasConsumers(): boolean;
  forEachConsumer(run: (consumer: ProcessorRecord) => void): void;
  attachConsumer(consumer: ProcessorRecord): void;
  detachConsumer(consumer: ProcessorRecord): void;
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
  evaluate(reset: boolean, cause: unknown, recreate?: boolean): readonly OutputRecord[];
  publish(): void;
};

export type ProducerRecord = SourceBoundaryRecord | ProcessorRecord;

export const createScheduler = (onError: (error: ProjectionError) => void) => {
  let disposed = false;
  let depth = 0;
  let batchSequence = 0;
  let activeBatch: BatchContext | undefined;
  let phase: 'idle' | 'input' | 'compute' | 'notify' = 'idle';
  let sequence = 0;
  const sources = new Set<SourceBoundaryRecord>();
  const processors = new Set<ProcessorRecord>();
  const pendingSources = new Set<SourceBoundaryRecord>();
  const dirty = new Set<ProducerRecord>();
  const queued = new Set<ProcessorRecord>();
  const completed = new Set<ProcessorRecord>();
  const emissions = new Set<OutputRecord>();
  const forced = new Set<OutputRecord>();
  const errors: ProjectionError[] = [];
  let reportingFailures: unknown[] = [];
  const guards = new Set<(locked: boolean) => void>();

  const assertActive = () => {
    if (disposed) throw new ProjectionDisposedError();
  };
  const assertIdle = () => {
    assertActive();
    if (phase !== 'idle')
      throw new Error(
        'Projection cannot be re-entered during input callbacks, processing or notification.'
      );
  };
  const lock = (value: boolean) => guards.forEach(guard => guard(value));

  const markDirty = (producer: ProducerRecord): void => {
    const pending = [producer];
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index];
      if (current.disposed || dirty.has(current)) continue;
      dirty.add(current);
      for (const output of current.outputs)
        output.forEachConsumer(consumer => pending.push(consumer));
    }
  };
  const enqueue = (processor: ProcessorRecord): void => {
    if (processor.disposed || queued.has(processor)) return;
    queued.add(processor);
    profile.projection('scheduledNodes');
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
    markDirty(source);
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

  const propagate = (output: OutputRecord, force = false): void => {
    emissions.add(output);
    if (force) forced.add(output);
    output.forEachConsumer(enqueue);
  };

  const advanceSource = (source: SourceBoundaryRecord, cause: unknown): void => {
    pendingSources.delete(source);
    const wasFaulted = source.fault !== undefined;
    let changed = false;
    let force = false;
    if (!source.fault || source.recovering()) {
      try {
        // A fresh attempt may read the last valid source snapshot internally.
        // Public re-entry remains forbidden until this compute phase completes.
        source.fault = undefined;
        const prepared = source.prepare(cause);
        changed = prepared.changed;
        force = prepared.force;
        source.fault = undefined;
      } catch (failure) {
        source.fault = errorFor(source, failure, 'source');
        errors.push(source.fault);
      }
    }
    if (changed || force) source.publish();
    if (source.fault || changed || force || wasFaulted) propagate(source.outputs[0], force);
    source.clear();
  };

  const advanceProcessor = (processor: ProcessorRecord, cause: unknown): void => {
    queued.delete(processor);
    const wasFaulted = processor.fault !== undefined;
    profile.projection('processedNodes');
    let changedOutputs: readonly OutputRecord[] = [];
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
      const reset = wasFaulted || processor.dependencies.some(output => output.reset(processor));
      try {
        changedOutputs = processor.evaluate(reset, cause, wasFaulted);
        const failure = processor.dependencies.find(output => output.owner.fault)?.owner.fault;
        if (failure) throw failure;
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
    if (processor.fault) {
      processor.outputs.forEach(output => propagate(output));
    } else {
      if (changedOutputs.length) processor.publish();
      const recovered = wasFaulted && !processor.fault;
      (recovered ? processor.outputs : changedOutputs).forEach(output => propagate(output));
    }
    if (processor.fault || changedOutputs.length) profile.projection('publishedNodes');
  };

  // Iterative dependency-first traversal also supports deep projection chains.
  const advance = (target: ProducerRecord, cause: unknown): void => {
    const stack = [{ producer: target, dependency: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const { producer } = frame;
      if (producer.disposed || !dirty.has(producer)) {
        dirty.delete(producer);
        stack.pop();
        continue;
      }
      if (producer.kind === 'processor') {
        let dependency: ProducerRecord | undefined;
        while (frame.dependency < producer.dependencies.length) {
          const candidate = producer.dependencies[frame.dependency++].owner;
          if (dirty.has(candidate)) {
            dependency = candidate;
            break;
          }
        }
        if (dependency) {
          stack.push({ producer: dependency, dependency: 0 });
          continue;
        }
      }
      stack.pop();
      dirty.delete(producer);
      if (producer.kind === 'source') advanceSource(producer, cause);
      else if (queued.has(producer)) {
        if (
          producer.fault ||
          producer.dependencies.some(output => output.owner.fault || output.pending(producer))
        )
          advanceProcessor(producer, cause);
        else {
          queued.delete(producer);
          producer.dependencies.forEach(output => output.acknowledge(producer));
        }
      }
    }
  };

  const compute = <T>(run: () => T): T => {
    phase = 'compute';
    lock(true);
    try {
      return run();
    } finally {
      lock(false);
      phase = 'idle';
    }
  };
  const settle = () => {
    if (disposed || depth || phase !== 'idle') return;
    const cause = settleCause();
    compute(() => {
      for (const producer of dirty) advance(producer, cause);
    });
  };
  const ensureCurrent = (output: OutputRecord): void => {
    assertActive();
    // Listener reads are safe after settlement; compute/input callbacks may not
    // use public reads to bypass dependency declarations or acceptance isolation.
    if (phase === 'notify') return;
    assertIdle();
    if (dirty.has(output.owner)) {
      const cause = settleCause();
      compute(() => advance(output.owner, cause));
    }
  };

  const flush = (): readonly ObserverError[] => {
    if (disposed || depth) return [];
    if (emissions.size || completed.size) profile.projection('flushes');
    phase = 'notify';
    lock(true);
    const reportFailures: unknown[] = [];
    try {
      emissions.forEach(output =>
        output.emit(
          (listener, change) => {
            try {
              listener(change);
            } catch (cause) {
              errors.push(errorFor(output.owner, cause, 'listener'));
            }
          },
          forced.has(output) || Boolean(output.owner.fault)
        )
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
      emissions.forEach(output => output.finish());
      completed.forEach(processor => processor.clear());
      pendingSources.clear();
      queued.clear();
      completed.clear();
      emissions.clear();
      forced.clear();
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

  const batch = <T>(callback: () => T, options?: BatchOptions): T => {
    assertIdle();
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
    if (producer.outputs.some(output => output.hasConsumers()))
      throw new Error('Projection producer is still used by another processor.');
    producer.disposed = true;
    dirty.delete(producer);
    if (producer.kind === 'processor') {
      producer.dependencies.forEach(output => output.detachConsumer(producer));
      processors.delete(producer);
      queued.delete(producer);
      completed.delete(producer);
    } else {
      sources.delete(producer);
      pendingSources.delete(producer);
    }
    const failures: unknown[] = [];
    try {
      producer.release();
    } catch (error) {
      failures.push(error);
    }
    try {
      producer.clear();
    } catch (error) {
      failures.push(error);
    }
    producer.outputs.forEach(output => emissions.delete(output));
    if (failures.length) throw failures[0];
  };

  return {
    assertActive,
    assertIdle,
    capture,
    settle,
    ensureCurrent,
    flush,
    run,
    registerGuard(guard: (locked: boolean) => void): Unsubscribe {
      assertActive();
      guards.add(guard);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        guards.delete(guard);
      };
    },
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
      processor.dependencies.forEach(output => output.attachConsumer(processor));
    },
    releaseProducer,
    nextId: () => sequence++,
    acceptInput<T>(callback: () => T): T {
      assertIdle();
      phase = 'input';
      lock(true);
      try {
        return callback();
      } finally {
        lock(false);
        phase = 'idle';
      }
    },
    initialize<T>(callback: () => T): T {
      assertIdle();
      return compute(callback);
    },
    batch,
    batchContext: () => activeBatch,
    dispose() {
      if (disposed) return;
      assertIdle();
      disposed = true;
      const failures: unknown[] = [];
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
      dirty.clear();
      queued.clear();
      completed.clear();
      emissions.clear();
      forced.clear();
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
