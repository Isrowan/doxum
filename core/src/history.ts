import type { DocumentOperation } from './operations';
import type {
  HistoryState,
  LocalHistory,
  ObserverError,
  OperationResult,
} from './runtime/contract';
import { DocumentDisposedError } from './runtime/contract';

type Batch = {
  readonly operations: readonly DocumentOperation[];
  readonly inverse: readonly DocumentOperation[];
};
type Entry = { readonly batches: Batch[] };
type Group = { entry?: Entry; readonly undos: Entry[]; readonly redos: Entry[] };

export const createHistory = <TCommit>(input: {
  readonly capacity: number;
  readonly apply: (operations: readonly DocumentOperation[]) => OperationResult<TCommit>;
  readonly revision: () => number;
  readonly assertIdle: () => void;
  readonly notify: (run: () => readonly ObserverError[]) => readonly ObserverError[];
}) => {
  let undos: Entry[] = [];
  let redos: Entry[] = [];
  const listeners = new Set<() => void>();
  let state: HistoryState = Object.freeze({ undoDepth: 0, redoDepth: 0 });
  let revision = 0;
  let pending = false;
  let disposed = false;
  let group: Group | undefined;
  const unchanged = (): OperationResult<TCommit> => ({
    status: 'unchanged',
    revision: input.revision(),
  });
  const publish = () => {
    if (state.undoDepth === undos.length && state.redoDepth === redos.length) return;
    state = Object.freeze({ undoDepth: undos.length, redoDepth: redos.length });
    revision++;
    pending = true;
  };
  const flush = (): readonly ObserverError[] => {
    if (!pending) return [];
    pending = false;
    const errors: ObserverError[] = [];
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        errors.push({ phase: 'listener', error });
      }
    }
    return errors;
  };
  const clear = () => {
    group = undefined;
    undos.length = redos.length = 0;
    publish();
  };
  const travel = (direction: 'undo' | 'redo' | 'cancel'): OperationResult<TCommit> => {
    input.assertIdle();
    const from = direction === 'redo' ? redos : undos;
    const to = direction === 'redo' ? undos : redos;
    const previousUndos = undos;
    const previousRedos = redos;
    const entry = direction === 'cancel' ? from.at(-1) : from.pop();
    if (!entry) return unchanged();
    if (direction === 'cancel') {
      if (!group || group.entry !== entry)
        throw new Error('History group no longer owns its entry.');
      undos = group.undos;
      redos = group.redos;
    } else to.push(entry);
    let committed = false;
    try {
      const operations =
        direction === 'redo'
          ? entry.batches.flatMap(batch => batch.operations)
          : entry.batches
              .slice()
              .reverse()
              .flatMap(batch => batch.inverse);
      const result = input.apply(operations);
      committed = result.status !== 'rejected';
      if (committed && direction === 'cancel') group = undefined;
      if (result.status === 'unchanged') {
        publish();
        const errors = input.notify(flush);
        if (errors.length)
          throw new AggregateError(
            errors.map(entry => entry.error),
            'History listeners failed.'
          );
      }
      return result;
    } finally {
      if (!committed) {
        if (direction === 'cancel') {
          undos = previousUndos;
          redos = previousRedos;
        } else {
          to.pop();
          from.push(entry);
        }
      }
    }
  };
  const api: LocalHistory<TCommit> = {
    current: () => state,
    revision: () => revision,
    subscribe: listener => {
      if (disposed) throw new DocumentDisposedError();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    undo: () => {
      input.assertIdle();
      group = undefined;
      return travel('undo');
    },
    redo: () => {
      input.assertIdle();
      group = undefined;
      return travel('redo');
    },
    clear: () => {
      input.assertIdle();
      clear();
      const errors = input.notify(flush);
      if (errors.length)
        throw new AggregateError(
          errors.map(entry => entry.error),
          'History listeners failed.'
        );
    },
    group: () => {
      input.assertIdle();
      if (group) throw new Error('A history group is already active.');
      if (input.capacity <= 0) throw new Error('History is disabled.');
      const scope: Group = { undos: undos.slice(), redos: redos.slice() };
      group = scope;
      return Object.freeze({
        end: () => {
          input.assertIdle();
          if (group === scope) group = undefined;
        },
        cancel: () => {
          input.assertIdle();
          if (group !== scope) return unchanged();
          if (!scope.entry) {
            group = undefined;
            return unchanged();
          }
          const result = travel('cancel');
          if (result.status !== 'rejected') group = undefined;
          return result;
        },
      });
    },
  };
  return {
    api,
    record: (operations: readonly DocumentOperation[], inverse: readonly DocumentOperation[]) => {
      if (input.capacity <= 0) return;
      const batch = { operations, inverse };
      if (group?.entry) group.entry.batches.push(batch);
      else {
        const entry: Entry = { batches: [batch] };
        undos.push(entry);
        if (group) group.entry = entry;
        if (undos.length > input.capacity) undos.shift();
      }
      redos.length = 0;
      publish();
    },
    publish,
    flush,
    endGroup: () => {
      group = undefined;
    },
    invalidate: clear,
    dispose: () => {
      disposed = true;
      listeners.clear();
      clear();
      pending = false;
    },
  };
};
