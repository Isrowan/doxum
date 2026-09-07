import type { ObserverError } from '../runtime/contract';
import { ProjectionDisposedError, ProjectionError } from './contract';
import { profile } from '../profile';

export type SourceRecord = {
  readonly consumers: Set<NodeRecord>;
  context(active: () => boolean): unknown;
  revision(): number;
  reset(): boolean;
  fault: ProjectionError | undefined;
  disposed: boolean;
  clear(): void;
};
export type NodeRecord = SourceRecord & {
  readonly order: number;
  readonly name: string;
  readonly sources: readonly SourceRecord[];
  forced: boolean;
  statusChanged: boolean;
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
  let phase: 'idle' | 'compute' | 'notify' = 'idle';
  let sequence = 0;
  const records = new Map<object, SourceRecord>();
  const nodes = new Set<NodeRecord>();
  const pending = new Set<SourceRecord>();
  const heap: NodeRecord[] = [];
  const queued = new Set<NodeRecord>();
  const completed: NodeRecord[] = [];
  const emissions = new Set<NodeRecord>();
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
      pending.forEach(source => source.consumers.forEach(enqueue));
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
          const build = node.forced || wasFaulted || node.sources.some(source => source.reset());
          try {
            changed = node.evaluate(build);
            const failure = node.sources.find(source => source.fault)?.fault;
            if (failure) throw failure;
            node.fault = undefined;
          } catch (cause) {
            const error = errorFor(node, cause);
            errors.push(error);
            node.fault = error;
            if (!build) {
              try {
                changed = node.evaluate(true);
                const failure = node.sources.find(source => source.fault)?.fault;
                if (failure) throw failure;
                node.fault = undefined;
              } catch (cause) {
                node.fault = errorFor(node, cause);
                errors.push(node.fault);
              }
            }
          }
        }
        node.forced = false;
        node.statusChanged = wasFaulted !== (node.fault !== undefined);
        completed.push(node);
        if (changed || wasFaulted || node.fault) {
          profile.projection('publishedNodes');
          emissions.add(node);
          node.consumers.forEach(enqueue);
        }
      }
      completed.forEach(node => node.publish());
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
      emissions.forEach(node =>
        node.emit(listener => {
          try {
            listener();
          } catch (cause) {
            errors.push(errorFor(node, cause, 'listener'));
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
        record.disposed = true;
        pending.delete(record);
        record.clear();
        records.delete(handle);
      }
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
    rebuild(node: NodeRecord) {
      assertIdle();
      if (node.disposed) throw new ProjectionDisposedError();
      node.forced = true;
      enqueue(node);
      run();
    },
    disposeNode(node: NodeRecord) {
      if (node.disposed) return;
      assertIdle();
      if (node.consumers.size)
        throw new Error('Cannot dispose a projection node with downstream consumers.');
      node.disposed = true;
      node.sources.forEach(source => source.consumers.delete(node));
      nodes.delete(node);
      node.release();
      for (const [handle, record] of records) if (record === node) records.delete(handle);
    },
    batch<T>(callback: () => T): T {
      assertIdle();
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
          if (failed) {
            try {
              run();
            } catch {
              /* The original application error retains priority. */
            }
          } else run();
        }
      }
    },
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
    debug: () => ({
      nodes: nodes.size,
      sources: records.size - nodes.size,
      subscriptions: cleanups.size,
      pending: pending.size + heap.length,
    }),
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
