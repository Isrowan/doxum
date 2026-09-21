/** Exhaustively notifies one projection-readable listener snapshot. */
export const notifyProjectionListeners = (
  listeners: Iterable<() => void>,
  message: string
): void => {
  const snapshot = [...listeners];
  const failures: unknown[] = [];
  for (const listener of snapshot) {
    try {
      listener();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, message);
};
