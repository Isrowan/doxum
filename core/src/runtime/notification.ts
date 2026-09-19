import type { ObjectNode, ImpactTarget } from '../schema';
import type { CommitListener, DocumentCommit, Unsubscribe, ObserverError } from './contract';
import * as target from '../impact/target';

type ProjectionAttachment<TSchema extends ObjectNode> = {
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
type NotificationState<TSchema extends ObjectNode> = {
  readonly root: Set<RootEntry<TSchema>>;
  readonly filtered: Set<FilteredEntry<TSchema>>;
  readonly index: target.SubscriptionIndex<FilteredEntry<TSchema>>;
  readonly cleanups: Set<() => void>;
  readonly processors: ProcessorEntry<TSchema>[];
  readonly candidates: Set<FilteredEntry<TSchema>>;
  readonly rootSnapshot: RootEntry<TSchema>[];
  notifying: boolean;
};
export type NotificationCenter<TSchema extends ObjectNode> = {
  subscribe(listener: CommitListener<TSchema>): Unsubscribe;
  subscribeTargets(
    targets: readonly ImpactTarget<unknown>[],
    listener: CommitListener<TSchema>
  ): Unsubscribe;
  attachProjection(processor: ProjectionAttachment<TSchema>): Unsubscribe;
  publish(
    commit: DocumentCommit<TSchema>,
    afterSettle?: () => readonly ObserverError[]
  ): readonly ObserverError[];
  dispose(): void;
};

const attachProjection = <TSchema extends ObjectNode>(
  notification: NotificationState<TSchema>,
  processor: ProjectionAttachment<TSchema>
): Unsubscribe => {
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

const addRoot = <TSchema extends ObjectNode>(
  notification: NotificationState<TSchema>,
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

const addFiltered = <TSchema extends ObjectNode>(
  notification: NotificationState<TSchema>,
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

const publishState = <TSchema extends ObjectNode>(
  notification: NotificationState<TSchema>,
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

const disposeState = <TSchema extends ObjectNode>(
  notification: NotificationState<TSchema>
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

export const createNotificationCenter = <TSchema extends ObjectNode>(
  schema: TSchema
): NotificationCenter<TSchema> => {
  const state: NotificationState<TSchema> = {
    root: new Set(),
    filtered: new Set(),
    index: new target.SubscriptionIndex(schema),
    cleanups: new Set(),
    processors: [],
    candidates: new Set(),
    rootSnapshot: [],
    notifying: false,
  };
  return Object.freeze({
    subscribe: (listener: CommitListener<TSchema>) => addRoot(state, listener),
    subscribeTargets: (
      targets: readonly ImpactTarget<unknown>[],
      listener: CommitListener<TSchema>
    ) => addFiltered(state, targets, listener),
    attachProjection: (processor: ProjectionAttachment<TSchema>) =>
      attachProjection(state, processor),
    publish: (commit: DocumentCommit<TSchema>, afterSettle?: () => readonly ObserverError[]) =>
      publishState(state, commit, afterSettle),
    dispose: () => disposeState(state),
  });
};
