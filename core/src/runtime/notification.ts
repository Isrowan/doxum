import type { ObjectNode, ImpactTarget } from '../schema';
import type {
  CommitListener,
  DocumentCommit,
  DocumentReadable,
  DocumentRuntime,
  Unsubscribe,
  ObserverError,
} from './contract';
import * as target from '../impact-target';

export type ProjectionAttachment<TSchema extends ObjectNode> = {
  capture(commit: DocumentCommit<TSchema>): void;
  settle(): void;
  flush(): readonly ObserverError[];
  dispose(): void;
};
type ProcessorEntry<TSchema extends ObjectNode> = {
  readonly processor: ProjectionAttachment<TSchema>;
  active: boolean;
};
type RootEntry<TSchema extends ObjectNode> = {
  readonly listener: CommitListener<TSchema>;
  active: boolean;
};
type FilteredEntry<TSchema extends ObjectNode> = {
  readonly targets: readonly ImpactTarget<unknown>[];
  readonly listener: CommitListener<TSchema>;
  active: boolean;
};
export type RuntimeNotification<TSchema extends ObjectNode> = {
  readonly root: Set<RootEntry<TSchema>>;
  readonly filtered: Set<FilteredEntry<TSchema>>;
  readonly index: target.SubscriptionIndex<FilteredEntry<TSchema>>;
  readonly cleanups: Set<() => void>;
  readonly processors: ProcessorEntry<TSchema>[];
  readonly candidates: Set<FilteredEntry<TSchema>>;
  readonly rootSnapshot: RootEntry<TSchema>[];
  notifying: boolean;
};

const notifications = new WeakMap<object, RuntimeNotification<ObjectNode>>();
const readableOwners = new WeakMap<object, DocumentReadable<ObjectNode>>();

export const bindDocumentReadable = (
  readable: object,
  runtime: DocumentReadable<ObjectNode>
): void => {
  readableOwners.set(readable, runtime);
};
export const documentReadableOwner = (readable: object): DocumentReadable<ObjectNode> | undefined =>
  readableOwners.get(readable);

export const createNotification = <TSchema extends ObjectNode>(
  runtime: DocumentRuntime<TSchema>
): RuntimeNotification<TSchema> => {
  const notification: RuntimeNotification<TSchema> = {
    root: new Set(),
    filtered: new Set(),
    index: new target.SubscriptionIndex(runtime.schema),
    cleanups: new Set(),
    processors: [],
    candidates: new Set(),
    rootSnapshot: [],
    notifying: false,
  };
  notifications.set(runtime as object, notification as RuntimeNotification<ObjectNode>);
  return notification;
};

const notificationOf = <TSchema extends ObjectNode>(
  runtime: DocumentReadable<TSchema>
): RuntimeNotification<TSchema> => {
  const value = notifications.get(runtime as object);
  if (!value) throw new Error('Unknown Doxum runtime.');
  return value as RuntimeNotification<TSchema>;
};

export const shareNotification = <TSchema extends ObjectNode>(
  source: DocumentRuntime<TSchema>,
  target: DocumentReadable<TSchema>
): void => {
  notifications.set(target as object, notificationOf(source) as RuntimeNotification<ObjectNode>);
};

export const attachProjection = <TSchema extends ObjectNode>(
  runtime: DocumentReadable<TSchema>,
  processor: ProjectionAttachment<TSchema>
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

export const subscribeRoot = <TSchema extends ObjectNode>(
  notification: RuntimeNotification<TSchema>,
  listener: CommitListener<TSchema>
): Unsubscribe => {
  const entry: RootEntry<TSchema> = { listener, active: true };
  notification.root.add(entry);
  return () => {
    entry.active = false;
    if (!notification.notifying) notification.root.delete(entry);
    else
      notification.cleanups.add(() => {
        notification.root.delete(entry);
      });
  };
};

export const subscribeTargets = <TSchema extends ObjectNode>(
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
  entry.targets.forEach(value => notification.index.add(value, entry));
  const remove = () => {
    notification.filtered.delete(entry);
    entry.targets.forEach(value => notification.index.delete(value, entry));
  };
  return () => {
    if (!entry.active) return;
    entry.active = false;
    if (notification.notifying) notification.cleanups.add(remove);
    else remove();
  };
};

export const notify = <TSchema extends ObjectNode>(
  notification: RuntimeNotification<TSchema>,
  commit: DocumentCommit<TSchema>,
  afterSettle?: () => readonly ObserverError[]
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
        entry.processor.capture(commit);
      } catch (error) {
        errors.push(Object.freeze({ phase: 'processor', error }));
      }
    }
    for (let index = 0; index < processorCount; index += 1) {
      const entry = notification.processors[index];
      if (!entry?.active) continue;
      try {
        entry.processor.settle();
      } catch (error) {
        errors.push(Object.freeze({ phase: 'processor', error }));
      }
    }
    for (let index = 0; index < processorCount; index += 1) {
      const entry = notification.processors[index];
      if (!entry?.active) continue;
      try {
        errors.push(...entry.processor.flush());
      } catch (error) {
        errors.push(Object.freeze({ phase: 'flush', error }));
      }
    }

    if (afterSettle) errors.push(...afterSettle());
    const candidates = notification.candidates;
    candidates.clear();
    if (notification.filtered.size)
      notification.index.collect(commit.changes, entry => candidates.add(entry));
    candidates.forEach(entry => {
      if (entry.active) call(entry.listener);
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
    notification.cleanups.forEach(cleanup => cleanup());
    notification.cleanups.clear();
  }
  return Object.freeze(errors);
};

export const subscribeDependencies = <S extends ObjectNode>(
  runtime: DocumentReadable<S>,
  targets: readonly ImpactTarget[],
  listener: CommitListener<S>
): Unsubscribe => subscribeTargets(notificationOf(runtime), targets, listener);

export const disposeNotification = <TSchema extends ObjectNode>(
  notification: RuntimeNotification<TSchema>
): void => {
  const attachments = notification.processors.slice();
  notification.root.clear();
  notification.filtered.clear();
  notification.index.clear();
  notification.cleanups.clear();
  notification.processors.length = 0;
  notification.candidates.clear();
  notification.rootSnapshot.length = 0;
  const errors: unknown[] = [];
  attachments.forEach(entry => {
    if (!entry.active) return;
    try {
      entry.processor.dispose();
    } catch (error) {
      errors.push(error);
    }
  });
  if (errors.length) throw new AggregateError(errors, 'Projection disposal notification failed.');
};
