import { profile } from '../../profile';
import type { Unsubscribe } from '../../runtime/contract';
import { createCollectionOutput, type CollectionOutputState } from '../output/collection';
import type { CollectionChange, CollectionRead } from '../contract';
import { ProjectionDisposedError, ProjectionError } from '../contract';
import type { OutputRecord, Scheduler, SourceBoundaryRecord } from '../graph/scheduler';
import { createValueOutput, type ValueOutputState } from '../output/value';
import type { CollectionInputDraft } from '../definition';

export type SourceWrite =
  | { readonly kind: 'value'; set(value: unknown): void }
  | {
      readonly kind: 'collection';
      update(run: (draft: CollectionInputDraft<string, unknown>) => void): void;
    };

export type SourceMaterialization = {
  readonly producer: SourceBoundaryRecord;
  readonly output: OutputRecord;
  readonly write?: SourceWrite;
};

export type SourceMark = { readonly reset?: boolean; readonly cause?: unknown };
type CollectionMark = SourceMark & {
  readonly candidates?: Iterable<string>;
  readonly fullScan?: boolean;
  readonly orderMayChange?: boolean;
};

export type ValueBoundary = SourceMaterialization & {
  readonly mark: (metadata?: SourceMark) => void;
  readonly fail: (cause: unknown) => void;
  readonly detach: (cleanup: Unsubscribe) => void;
};

export type CollectionBoundary = SourceMaterialization & {
  readonly mark: (metadata?: CollectionMark) => void;
  readonly fail: (cause: unknown) => void;
  readonly detach: (cleanup: Unsubscribe) => void;
};

const sourceError = (cause: unknown): ProjectionError => new ProjectionError('source', cause);

export const createValueBoundary = (
  scheduler: Scheduler,
  name: string,
  initial: unknown,
  equality: (previous: unknown, next: unknown) => boolean,
  prepare: (previous: unknown) => unknown,
  clearSource: (failed: boolean) => void
): ValueBoundary => {
  const state: ValueOutputState<unknown> = createValueOutput();
  let boundary!: SourceBoundaryRecord;
  let pendingReset = false;
  let pendingCause: unknown;
  let contextCause: unknown;
  let recovering = false;
  let cleanup: Unsubscribe | undefined;

  const check = () => {
    if (!scheduler.active || boundary.disposed) throw new ProjectionDisposedError();
    if (boundary.fault) throw boundary.fault;
  };

  const output: OutputRecord = {
    kind: 'value',
    get owner() {
      return boundary;
    },
    consumers: new Set(),
    context: active => state.context(active, contextCause),
    current: () => state.current(check),
    revision: state.revision,
    reset: state.reset,
    subscribe: listener => {
      check();
      const wrapped = () => listener();
      state.subscribe(wrapped);
      return () => state.unsubscribe(wrapped);
    },
    emit: state.emit,
    clear: state.clear,
    release: state.release,
  };

  boundary = {
    kind: 'source',
    name,
    outputs: Object.freeze([output]) as readonly [OutputRecord],
    fault: undefined,
    disposed: false,
    pendingCause: () => pendingCause,
    recovering: () => recovering,
    prepare: cause => {
      contextCause = cause;
      let active = true;
      try {
        const evaluation = state.begin(() => active, pendingReset);
        evaluation.output.set(prepare(evaluation.previous));
        const changed = state.seal(pendingReset, equality);
        recovering = false;
        return { changed, force: pendingReset };
      } finally {
        active = false;
      }
    },
    publish: state.publish,
    clear: () => {
      const failed = boundary.fault !== undefined;
      state.clear();
      pendingReset = false;
      pendingCause = undefined;
      contextCause = undefined;
      recovering = false;
      clearSource(failed);
    },
    release: () => {
      cleanup?.();
      cleanup = undefined;
      state.release();
      output.consumers.clear();
    },
  };

  scheduler.initialize(() => {
    let active = true;
    try {
      const evaluation = state.begin(() => active, true);
      evaluation.output.set(initial);
      state.seal(true, equality);
      state.publish();
      state.clear();
    } finally {
      active = false;
    }
  });
  scheduler.addSource(boundary);

  const mark = (metadata: SourceMark = {}) => {
    scheduler.assertIdle();
    pendingReset ||= metadata.reset ?? false;
    if (metadata.cause !== undefined) pendingCause ??= metadata.cause;
    if (boundary.fault) recovering = true;
    scheduler.capture(boundary);
  };
  const fail = (cause: unknown) => {
    boundary.fault = sourceError(cause);
    recovering = false;
    scheduler.capture(boundary);
  };
  return {
    producer: boundary,
    output,
    mark,
    fail,
    detach: next => {
      cleanup = next;
    },
  };
};

type CollectionStageOptions<K extends string, V> = {
  readonly reset: boolean;
  readonly candidates?: Iterable<K>;
  readonly orderMayChange?: boolean;
  readonly isEqual?: (previous: V, next: V) => boolean;
};

/** Applies source hints to an output draft; exact net change semantics remain in the output. */
const stageCollectionRead = <K extends string, V>(
  state: CollectionOutputState<K, V>,
  read: CollectionRead<K, V>,
  active: () => boolean,
  options: CollectionStageOptions<K, V>
): boolean => {
  const evaluation = state.begin(active, options.reset);
  if (options.reset) {
    const ids = read.ids();
    profile.collectionView.idsScanned(ids.length);
    for (const key of ids) {
      profile.collectionView.mapped();
      evaluation.output.set(key, read.get(key) as V);
    }
    evaluation.output.order(ids);
  } else {
    const previous = state.current(() => undefined);
    const keys = options.candidates
      ? [...new Set(options.candidates)]
      : [...new Set([...previous.ids(), ...read.ids()])];
    if (!options.candidates) profile.collectionView.idsScanned(keys.length);
    for (const key of keys) {
      if (read.has(key)) {
        profile.collectionView.mapped();
        evaluation.output.set(key, read.get(key) as V);
      } else evaluation.output.remove(key);
    }
    if (options.orderMayChange || !options.candidates) {
      const ids = read.ids();
      if (options.candidates) profile.collectionView.idsScanned(ids.length);
      evaluation.output.order(ids);
    }
  }
  return state.seal(options.reset, options.isEqual ?? Object.is);
};

export const createCollectionBoundary = (
  scheduler: Scheduler,
  name: string,
  readLatest: (
    active: () => boolean,
    previous: CollectionRead<string, unknown>
  ) => CollectionRead<string, unknown>,
  equality: (previous: unknown, next: unknown) => boolean,
  clearSource: (failed: boolean) => void
): CollectionBoundary => {
  const state: CollectionOutputState<string, unknown> = createCollectionOutput();
  let boundary!: SourceBoundaryRecord;
  let pendingReset = false;
  let pendingCause: unknown;
  let contextCause: unknown;
  let recovering = false;
  let fullScan = false;
  let orderMayChange = false;
  const candidates = new Set<string>();
  let cleanup: Unsubscribe | undefined;

  const check = () => {
    if (!scheduler.active || boundary.disposed) throw new ProjectionDisposedError();
    if (boundary.fault) throw boundary.fault;
  };

  const output: OutputRecord = {
    kind: 'collection',
    get owner() {
      return boundary;
    },
    consumers: new Set(),
    context: active => state.context(active, contextCause),
    current: () => state.current(check),
    revision: state.revision,
    reset: state.reset,
    subscribe: listener => {
      check();
      const wrapped = (change: CollectionChange<string, unknown>) => listener(change);
      state.subscribe(wrapped);
      return () => state.unsubscribe(wrapped);
    },
    emit: state.emit,
    clear: state.clear,
    release: state.release,
  };

  boundary = {
    kind: 'source',
    name,
    outputs: Object.freeze([output]) as readonly [OutputRecord],
    fault: undefined,
    disposed: false,
    pendingCause: () => pendingCause,
    recovering: () => recovering,
    prepare: cause => {
      contextCause = cause;
      let active = true;
      try {
        const changed = stageCollectionRead(
          state,
          readLatest(
            () => active,
            state.current(() => undefined)
          ),
          () => active,
          {
            reset: pendingReset,
            ...(fullScan ? {} : { candidates }),
            orderMayChange,
            isEqual: equality,
          }
        );
        recovering = false;
        return { changed, force: pendingReset };
      } finally {
        active = false;
      }
    },
    publish: state.publish,
    clear: () => {
      const failed = boundary.fault !== undefined;
      state.clear();
      pendingReset = false;
      pendingCause = undefined;
      contextCause = undefined;
      recovering = false;
      fullScan = false;
      orderMayChange = false;
      candidates.clear();
      clearSource(failed);
    },
    release: () => {
      cleanup?.();
      cleanup = undefined;
      state.release();
      output.consumers.clear();
    },
  };

  scheduler.initialize(() => {
    let active = true;
    try {
      stageCollectionRead(
        state,
        readLatest(
          () => active,
          state.current(() => undefined)
        ),
        () => active,
        { reset: true, isEqual: equality }
      );
      state.publish();
      state.clear();
    } finally {
      active = false;
    }
  });
  scheduler.addSource(boundary);

  const mark = (metadata: CollectionMark = {}) => {
    scheduler.assertIdle();
    pendingReset ||= metadata.reset ?? false;
    if (metadata.cause !== undefined) pendingCause ??= metadata.cause;
    fullScan ||= metadata.fullScan ?? false;
    orderMayChange ||= metadata.orderMayChange ?? false;
    if (metadata.candidates) for (const key of metadata.candidates) candidates.add(key);
    if (boundary.fault) recovering = true;
    scheduler.capture(boundary);
  };
  const fail = (cause: unknown) => {
    boundary.fault = sourceError(cause);
    recovering = false;
    scheduler.capture(boundary);
  };
  return {
    producer: boundary,
    output,
    mark,
    fail,
    detach: next => {
      cleanup = next;
    },
  };
};
