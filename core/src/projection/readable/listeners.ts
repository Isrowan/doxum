/** Exhaustively notifies an already-stable projection listener snapshot. */
export const notifyProjectionListenerSnapshot = (
  listeners: readonly (() => void)[],
  message: string
): void => {
  let failures: unknown[] | undefined;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      (failures ??= []).push(error);
    }
  }
  if (failures?.length === 1) throw failures[0];
  if (failures?.length) throw new AggregateError(failures, message);
};

/** Snapshots a mutable listener collection before exhaustive notification. */
export const notifyProjectionListeners = (listeners: Iterable<() => void>, message: string): void =>
  notifyProjectionListenerSnapshot([...listeners], message);
