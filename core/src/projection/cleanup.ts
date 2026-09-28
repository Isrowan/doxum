import { assertSynchronous } from '@/projection/graph/scheduler';
import type { Unsubscribe } from '@/readable';

/** Owner-local, cancellable LIFO callbacks. Lifecycle admission stays with the owner. */
export const createCleanupStack = () => {
  const entries = new Set<() => void>();
  return {
    add(callback: () => unknown): Unsubscribe {
      const entry = () => {
        assertSynchronous(callback());
      };
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    drain(failures: unknown[]): void {
      for (const entry of [...entries].reverse()) {
        if (!entries.delete(entry)) continue;
        try {
          entry();
        } catch (error) {
          failures.push(error);
        }
      }
    },
  };
};
