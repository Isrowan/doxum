import type { DocumentOperationUnion } from './operations';
import type { HistoryState, LocalHistory, OperationResult } from './runtime/contract';

type Entry = {
  readonly operations: readonly DocumentOperationUnion[];
  readonly inverse: readonly DocumentOperationUnion[];
};
export const createHistory = <TCommit>(input: {
  readonly capacity: number;
  readonly apply: (operations: readonly DocumentOperationUnion[]) => OperationResult<TCommit>;
  readonly revision: () => number;
}): {
  readonly api: LocalHistory<TCommit>;
  readonly record: (
    operations: readonly DocumentOperationUnion[],
    inverse: readonly DocumentOperationUnion[]
  ) => void;
  readonly invalidate: () => void;
} => {
  const undos: Entry[] = [];
  const redos: Entry[] = [];
  const listeners = new Set<() => void>();
  let state: HistoryState = Object.freeze({ undoDepth: 0, redoDepth: 0 });
  const current = () => {
    if (state.undoDepth !== undos.length || state.redoDepth !== redos.length)
      state = Object.freeze({
        undoDepth: undos.length,
        redoDepth: redos.length,
      });
    return state;
  };
  const emit = () => {
    if (listeners.size === 0) return;
    current();
    Array.from(listeners).forEach(listener => listener());
  };
  const clear = () => {
    if (undos.length || redos.length) {
      undos.length = 0;
      redos.length = 0;
      emit();
    }
  };
  const api: LocalHistory<TCommit> = {
    current,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    undo: () => {
      const entry = undos.pop();
      if (!entry) return { status: 'unchanged', revision: input.revision() };
      const result = input.apply(entry.inverse);
      if (result.status === 'committed') {
        redos.push(entry);
        emit();
      } else undos.push(entry);
      return result;
    },
    redo: () => {
      const entry = redos.pop();
      if (!entry) return { status: 'unchanged', revision: input.revision() };
      const result = input.apply(entry.operations);
      if (result.status === 'committed') {
        undos.push(entry);
        emit();
      } else redos.push(entry);
      return result;
    },
    clear,
  };
  return {
    api,
    record: (operations, inverse) => {
      if (input.capacity <= 0) return;
      undos.push({ operations, inverse });
      if (undos.length > input.capacity) undos.shift();
      redos.length = 0;
      emit();
    },
    invalidate: clear,
  };
};
