import type { Unsubscribe } from './readable';

/** Each registration owns its identity, independently of callback reuse. */
export const addListener = <Args extends unknown[]>(
  listeners: Set<(...args: Args) => void>,
  listener: (...args: Args) => void,
  removed?: () => void
): Unsubscribe => {
  const entry = (...args: Args) => listener(...args);
  listeners.add(entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(entry);
    removed?.();
  };
};
