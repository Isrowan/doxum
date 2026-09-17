import type { ObserverError } from '../runtime/contract';
import { ProjectionDisposedError, ProjectionError, type BatchContext } from './contract';
import { profile } from '../profile';

type BatchOptions = { readonly cause?: unknown };

export type SourceRecord = {
  readonly consumers: Set<NodeRecord>;
  context(active: () => boolean): unknown;
  revision(): number;
  reset(): boolean;
  shouldSettle?(): boolean;
  fault: ProjectionError | undefined;
  disposed: boolean;
  clear(): void;
};
export type OutputRecord = SourceRecord & {
  readonly owner: NodeRecord;
  emit(call: (listener: () => void) => void): void;
};
export type NodeRecord = SourceRecord & {
  readonly owner: NodeRecord;
  readonly order: number;
  readonly name: string;
  readonly sources: readonly SourceRecord[];
  readonly outputs?: readonly OutputRecord[];
  readonly changedOutputs?: () => readonly OutputRecord[];
  evaluate(build: boolean): boolean;
  publish(): void;
  emit(call: (listener: () => void) => void): void;
  release(): void;
};

// Sources and nodes share one registry. Public structural lookalikes are never accepted.
export const projectionHandles = new WeakSet<object>();
export const createScheduler = (onError: (error: ProjectionError) => void) => {
  let disposed = false;
  let depth = 0;
  let batchSequence = 0;
  let activeBatch: BatchContext | undefined;
  let phase: 'idle' | 'compute' | 'notify' = 'idle';
  let sequence = 0;
  const records = new Map<object, SourceRecord>();
  const nodes = new Set<NodeRecord>();
  const pending = new Set<SourceRecord>();
  const heap: NodeRecord[] = [];
  const queued = new Set<NodeRecord>();
  const completed: NodeRecord[] = [];
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
  const enqueue = (node: NodeRecord) => {
    if (node.disposed || queued.has(node)) return;
    queued.add(node);
    profile.projection('scheduledNodes');
    let i = heap.length;
    heap.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].order < node.order) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = node;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1;
        if (c + 1 < heap.length && heap[c + 1].order < heap[c].order) c++;
        if (last.order < heap[c].order) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return first;
  };
  const errorFor = (
    node: NodeRecord,
    cause: unknown,
    kind: ProjectionError['phase'] = 'processor'
  ) =>
    new ProjectionError(
      kind,
      node.name,
      node.sources.map(source => source.revision()),
      cause
    );
  const capture = (source: SourceRecord) => {
    if (disposed) return;
    if (phase !== 'idle') {
      source.fault = new ProjectionError(
        'source',
        'reentrant source',
        [source.revision()],
        new Error('Source changed while projection was running.')
      );
      errors.push(source.fault);
      throw source.fault;
    }
    pending.add(source);
    profile.projection('sourceEvents');
    if (source.fault) errors.push(source.fault);
  };
  const settle = () => {
    if (disposed || depth || phase !== 'idle') return;
    phase = 'compute';
    lock(true);
    try {
      pending.forEach(source => {
        if (source.shouldSettle?.() ?? true) source.consumers.forEach(enqueue);
      });
      while (heap.length) {
        const node = pop();
        if (node.disposed) continue;
        const wasFaulted = node.fault !== undefined;
        profile.projection('processedNodes');
        let changed = false;
        const blocked = node.sources.find(source => source.fault || source.disposed);
        if (blocked) {
          node.fault = errorFor(node, blocked.fault ?? new ProjectionDisposedError(), 'blocked');
        } else {
          const build = wasFaulted || node.sources.some(source => source.reset());
          try {
            changed = node.evaluate(build);
            const failure = node.sources.find(source => source.fault)?.fault;
            if (failure) throw failure;
            node.fault = undefined;
          } catch (cause) {
            const error = errorFor(node, cause);
            node.fault = error;
            if (!build) {
              try {
                changed = node.evaluate(true);
                const failure = node.sources.find(source => source.fault)?.fault;
                if (failure) throw failure;
                node.fault = undefined;
                errors.push(error);
              } catch (cause) {
                node.fault = errorFor(node, cause);
                errors.push(node.fault);
              }
            } else errors.push(error);
          }
        }
        completed.push(node);
        const outputs = node.changedOutputs?.() ?? (changed ? [node as OutputRecord] : []);
        const affected = node.fault
          ? (node.outputs ?? [node as OutputRecord])
          : outputs.length
            ? outputs
            : wasFaulted
              ? (node.outputs ?? [node as OutputRecord])
              : [];
        if (affected.length) {
          profile.projection('publishedNodes');
          node.publish();
          affected.forEach(output => {
            emissions.add(output);
            output.consumers.forEach(enqueue);
          });
        }
      }
    } finally {
      lock(false);
      phase = 'idle';
    }
  };
  const flush = (): readonly ObserverError[] => {
    if (disposed || depth) return [];
    if (pending.size || completed.length) profile.projection('flushes');
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
      pending.forEach(source => source.clear());
      completed.forEach(node => node.clear());
      pending.clear();
      queued.clear();
      completed.length = 0;
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
  return {
    assertActive,
    assertIdle,
    capture,
    settle,
    flush,
    run,
    records,
    guards,
    cleanups,
    get active() {
      return !disposed;
    },
    register(handle: object, record: SourceRecord) {
      assertIdle();
      records.set(handle, record);
      projectionHandles.add(handle);
    },
    unregisterSource(handle: object) {
      const record = records.get(handle);
      if (record) {
        assertIdle();
        if (record.consumers.size) throw new Error('Projection source is still used by a node.');
        record.disposed = true;
        pending.delete(record);
        record.clear();
        records.delete(handle);
      }
    },
    releaseNode(handle: object) {
      assertIdle();
      const record = records.get(handle);
      const node =
        record && 'owner' in record
          ? (record as SourceRecord & { readonly owner: NodeRecord }).owner
          : (record as NodeRecord | undefined);
      if (!node || !nodes.has(node)) throw new Error('Unknown projection node.');
      if ((node.outputs ?? [node as OutputRecord]).some(output => output.consumers.size))
        throw new Error('Projection node is still used by another node.');
      node.disposed = true;
      node.sources.forEach(source => source.consumers.delete(node));
      node.release();
      node.clear();
      nodes.delete(node);
      for (const [registered, value] of records)
        if (value === node || ('owner' in value && value.owner === node))
          records.delete(registered);
      pending.delete(node);
      queued.delete(node);
      for (const output of node.outputs ?? [node as OutputRecord]) emissions.delete(output);
    },
    source(handle: object) {
      assertActive();
      const source = records.get(handle);
      if (!source || source.disposed)
        throw new Error('Unknown, disposed, or foreign projection source.');
      return source;
    },
    addNode(node: NodeRecord) {
      nodes.add(node);
      node.sources.forEach(source => source.consumers.add(node));
    },
    order: () => sequence++,
    initialize<T>(run: () => T): T {
      assertIdle();
      phase = 'compute';
      lock(true);
      try {
        return run();
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
      nodes.forEach(node => {
        node.disposed = true;
        node.release();
        node.consumers.clear();
      });
      records.forEach(source => {
        source.disposed = true;
        source.consumers.clear();
        source.clear();
      });
      nodes.clear();
      records.clear();
      pending.clear();
      heap.length = 0;
      completed.length = 0;
      queued.clear();
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
