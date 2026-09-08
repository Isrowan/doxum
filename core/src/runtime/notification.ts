import type { DocumentSchema, ImpactTarget } from '../schema';
import type {
  CommitListener,
  DocumentCommit,
  DocumentReadable,
  DocumentRuntime,
  Unsubscribe,
  ObserverError,
} from './contract';
import * as target from '../impact-target';
import { AddressIndex } from '../address';

export type ProjectionAttachment<TSchema extends DocumentSchema> = {
  capture(commit: DocumentCommit<TSchema>): void;
  settle(): void;
  flush(): readonly ObserverError[];
  dispose(): void;
};
type ProcessorEntry<TSchema extends DocumentSchema> = {
  readonly processor: ProjectionAttachment<TSchema>;
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
  readonly index: AddressIndex<FilteredEntry<TSchema>>;
  readonly cleanups: Set<() => void>;
  readonly processors: ProcessorEntry<TSchema>[];
  readonly candidates: Set<FilteredEntry<TSchema>>;
  readonly rootSnapshot: RootEntry<TSchema>[];
  notifying: boolean;
};

const notifications = new WeakMap<object, RuntimeNotification<DocumentSchema>>();
const readableOwners = new WeakMap<object, DocumentReadable<DocumentSchema>>();

export const bindDocumentReadable = (
  readable: object,
  runtime: DocumentReadable<DocumentSchema>
): void => {
  readableOwners.set(readable, runtime);
};
export const documentReadableOwner = (
  readable: object
): DocumentReadable<DocumentSchema> | undefined => readableOwners.get(readable);

export const createNotification = <TSchema extends DocumentSchema>(
  runtime: DocumentReadable<TSchema>
): RuntimeNotification<TSchema> => {
  const notification: RuntimeNotification<TSchema> = {
    root: new Set(),
    filtered: new Set(),
    index: new AddressIndex(),
    cleanups: new Set(),
    processors: [],
    candidates: new Set(),
    rootSnapshot: [],
    notifying: false,
  };
  notifications.set(runtime as object, notification as RuntimeNotification<DocumentSchema>);
  return notification;
};

const notificationOf = <TSchema extends DocumentSchema>(
  runtime: DocumentReadable<TSchema>
): RuntimeNotification<TSchema> => {
  const value = notifications.get(runtime as object);
  if (!value) throw new Error('Unknown Doxum runtime.');
  return value as RuntimeNotification<TSchema>;
};

export const shareNotification = <TSchema extends DocumentSchema>(
  source: DocumentRuntime<TSchema>,
  target: DocumentReadable<TSchema>
): void => {
  notifications.set(
    target as object,
    notificationOf(source) as RuntimeNotification<DocumentSchema>
  );
};

export const attachProjection = <TSchema extends DocumentSchema>(
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

export const subscribeRoot = <TSchema extends DocumentSchema>(
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
  const addresses = targets.map(target.indexedAddress);
  addresses.forEach(address => notification.index.add(address, entry));
  const remove = () => {
    notification.filtered.delete(entry);
    addresses.forEach(address => notification.index.delete(address, entry));
  };
  return () => {
    if (!entry.active) return;
    entry.active = false;
    if (notification.notifying) notification.cleanups.add(remove);
    else remove();
  };
};

export const notify = <TSchema extends DocumentSchema>(
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
    if (commit.impact.kind === 'reset') {
      notification.filtered.forEach(entry => candidates.add(entry));
    } else if (notification.filtered.size) {
      const collect = notification.index.query(entry => candidates.add(entry));
      for (const operation of commit.operations) {
        collect(operation.at);
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
    notification.cleanups.forEach(cleanup => cleanup());
    notification.cleanups.clear();
  }
  return Object.freeze(errors);
};

export const disposeNotification = <TSchema extends DocumentSchema>(
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
