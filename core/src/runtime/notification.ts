import type { DocumentSchema, ImpactTarget } from '../schema';
import type {
  CommitListener,
  DocumentCommit,
  DocumentRuntime,
  RuntimeProcessor,
  Unsubscribe,
  ObserverError,
} from './contract';
import * as target from '../impact-target';

type ProcessorEntry<TSchema extends DocumentSchema> = {
  readonly processor: RuntimeProcessor<TSchema>;
  active: boolean;
};
type RootEntry<TSchema extends DocumentSchema> = {
  readonly listener: CommitListener<TSchema>;
  active: boolean;
};
type FilteredEntry<TSchema extends DocumentSchema> = {
  readonly targets: readonly ImpactTarget<unknown>[];
  readonly listener: CommitListener<TSchema>;
  active: boolean;
};
export type RuntimeNotification<TSchema extends DocumentSchema> = {
  readonly root: Set<RootEntry<TSchema>>;
  readonly filtered: Set<FilteredEntry<TSchema>>;
  readonly buckets: Map<BucketKey, Set<FilteredEntry<TSchema>>>;
  readonly processors: ProcessorEntry<TSchema>[];
  readonly candidates: Set<FilteredEntry<TSchema>>;
  readonly rootSnapshot: RootEntry<TSchema>[];
  notifying: boolean;
};

const ROOT_BUCKET = Symbol('document-root');
type BucketKey = string | typeof ROOT_BUCKET;
const notifications = new WeakMap<object, RuntimeNotification<DocumentSchema>>();

const key = (value: ImpactTarget<unknown>): BucketKey => target.bucket(value) ?? ROOT_BUCKET;

export const createNotification = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>
): RuntimeNotification<TSchema> => {
  const notification: RuntimeNotification<TSchema> = {
    root: new Set(),
    filtered: new Set(),
    buckets: new Map(),
    processors: [],
    candidates: new Set(),
    rootSnapshot: [],
    notifying: false,
  };
  notifications.set(runtime as object, notification as RuntimeNotification<DocumentSchema>);
  return notification;
};

const notificationOf = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>
): RuntimeNotification<TSchema> => {
  const value = notifications.get(runtime as object);
  if (!value) throw new Error('Unknown Doxum runtime.');
  return value as RuntimeNotification<TSchema>;
};

export const registerProcessor = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>,
  processor: RuntimeProcessor<TSchema>
): Unsubscribe => {
  const notification = notificationOf(runtime);
  const entry: ProcessorEntry<TSchema> = { processor, active: true };
  notification.processors.push(entry);
  return () => {
    if (!entry.active) return;
    entry.active = false;
    if (!notification.notifying) {
      const index = notification.processors.indexOf(entry);
      if (index >= 0) notification.processors.splice(index, 1);
    }
  };
};

export const subscribeRoot = <TSchema extends DocumentSchema>(
  notification: RuntimeNotification<TSchema>,
  listener: CommitListener<TSchema>
): Unsubscribe => {
  const entry: RootEntry<TSchema> = { listener, active: true };
  notification.root.add(entry);
  return () => {
    entry.active = false;
    if (!notification.notifying) notification.root.delete(entry);
  };
};

export const subscribeTargets = <TSchema extends DocumentSchema>(
  notification: RuntimeNotification<TSchema>,
  targets: readonly ImpactTarget<unknown>[],
  listener: CommitListener<TSchema>
): Unsubscribe => {
  const entry: FilteredEntry<TSchema> = {
    targets: Object.freeze(targets.slice()),
    listener,
    active: true,
  };
  notification.filtered.add(entry);
  const keys = new Set(targets.map(key));
  keys.forEach(key => {
    const bucket = notification.buckets.get(key) ?? new Set();
    bucket.add(entry);
    notification.buckets.set(key, bucket);
  });
  return () => {
    if (!entry.active) return;
    entry.active = false;
    if (notification.notifying) return;
    notification.filtered.delete(entry);
    keys.forEach(key => {
      const bucket = notification.buckets.get(key);
      bucket?.delete(entry);
      if (bucket?.size === 0) notification.buckets.delete(key);
    });
  };
};

export const notify = <TSchema extends DocumentSchema>(
  notification: RuntimeNotification<TSchema>,
  commit: DocumentCommit<TSchema>
): readonly ObserverError[] => {
  notification.notifying = true;
  const errors: ObserverError[] = [];
  const call = (listener: CommitListener<TSchema>): void => {
    try {
      listener(commit);
    } catch (error) {
      errors.push(Object.freeze({ phase: 'listener', error }));
    }
  };
  try {
    const processorCount = notification.processors.length;
    for (let index = 0; index < processorCount; index += 1) {
      const entry = notification.processors[index];
      if (!entry?.active) continue;
      try {
        entry.processor.process(commit);
      } catch (error) {
        errors.push(Object.freeze({ phase: 'processor', error }));
      }
    }
    for (let index = 0; index < processorCount; index += 1) {
      const entry = notification.processors[index];
      if (!entry?.active) continue;
      try {
        entry.processor.flush();
      } catch (error) {
        errors.push(Object.freeze({ phase: 'flush', error }));
      }
    }

    const candidates = notification.candidates;
    candidates.clear();
    if (commit.impact.kind === 'reset') {
      notification.filtered.forEach(entry => candidates.add(entry));
    } else {
      for (const operation of commit.operations) {
        const key = operation.at[0] ?? ROOT_BUCKET;
        notification.buckets.get(key)?.forEach(entry => candidates.add(entry));
        notification.buckets.get(ROOT_BUCKET)?.forEach(entry => candidates.add(entry));
      }
    }
    candidates.forEach(entry => {
      if (entry.active && entry.targets.some(commit.impact.affects)) call(entry.listener);
    });
    const rootSnapshot = notification.rootSnapshot;
    rootSnapshot.length = 0;
    notification.root.forEach(entry => rootSnapshot.push(entry));
    for (const entry of rootSnapshot) if (entry.active) call(entry.listener);
  } finally {
    notification.notifying = false;
    let writeIndex = 0;
    for (const entry of notification.processors)
      if (entry.active) notification.processors[writeIndex++] = entry;
    notification.processors.length = writeIndex;
    notification.root.forEach(entry => {
      if (!entry.active) notification.root.delete(entry);
    });
    notification.filtered.forEach(entry => {
      if (!entry.active) notification.filtered.delete(entry);
    });
    notification.buckets.forEach((bucket, key) => {
      bucket.forEach(entry => {
        if (!entry.active) bucket.delete(entry);
      });
      if (bucket.size === 0) notification.buckets.delete(key);
    });
  }
  return Object.freeze(errors);
};

export const disposeNotification = <TSchema extends DocumentSchema>(
  notification: RuntimeNotification<TSchema>
): void => {
  notification.root.clear();
  notification.filtered.clear();
  notification.buckets.clear();
  notification.processors.length = 0;
  notification.candidates.clear();
  notification.rootSnapshot.length = 0;
};
