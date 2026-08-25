import type {
  DocumentReadable,
  DocumentSchema,
  DocumentSelector,
  HistoryState,
  ImpactTarget,
  LocalHistory,
  OperationResult,
  Readable,
} from 'doxum';
import { target } from 'doxum';
import { track } from 'doxum/integration';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

export type DocumentSelectorOptions<TResult> = {
  readonly isEqual?: (previous: TResult, next: TResult) => boolean;
  readonly server?: () => TResult;
};

type SelectorCache<TSchema extends DocumentSchema, TResult> = {
  readonly runtime: DocumentReadable<TSchema>;
  readonly value: TResult;
  readonly targets: readonly ImpactTarget<unknown>[];
};

const objectIs = <T>(previous: T, next: T): boolean => Object.is(previous, next);
const sameTargets = (
  left: readonly ImpactTarget<unknown>[],
  right: readonly ImpactTarget<unknown>[]
): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!target.same(left[index], right[index])) return false;
  return true;
};

export function useDocumentSelector<TSchema extends DocumentSchema, TResult>(
  runtime: DocumentReadable<TSchema>,
  selector: DocumentSelector<TSchema, TResult>,
  options?: DocumentSelectorOptions<TResult>
): TResult {
  const equality = options?.isEqual ?? objectIs;
  const cache = useRef<SelectorCache<TSchema, TResult> | undefined>(undefined);
  const serverCache = useRef<
    { readonly source: (() => TResult) | undefined; readonly value: TResult } | undefined
  >(undefined);

  const read = useCallback((): TResult => {
    const selection = track(runtime, selector);
    const next = selection.value;
    const previous = cache.current;

    // Keep the prior reference for semantic equality on the same runtime. This
    // is what makes inline selectors safe with useSyncExternalStore.
    const targets = selection.targets;
    if (previous && previous.runtime === runtime && equality(previous.value, next)) {
      cache.current = { runtime, value: previous.value, targets };
      return previous.value;
    }

    cache.current = { runtime, value: next, targets };
    return next;
  }, [equality, runtime, selector]);

  const subscribe = useCallback(
    (listener: () => void) => {
      let targets = cache.current?.targets ?? [];
      let unsubscribe: () => void = () => undefined;
      const install = () => {
        if (targets.length === 0) return () => undefined;
        return runtime.subscribe(
          targets.length === 1
            ? targets[0]
            : (targets as [ImpactTarget<unknown>, ...ImpactTarget<unknown>[]]),
          onCommit
        );
      };
      const onCommit = () => {
        const previous = cache.current;
        const next = read();
        const nextTargets = cache.current?.targets ?? [];
        if (!sameTargets(targets, nextTargets)) {
          unsubscribe();
          targets = nextTargets;
          unsubscribe = install();
        }
        if (previous && previous.value !== next) listener();
      };
      unsubscribe = install();
      return () => unsubscribe();
    },
    [read, runtime]
  );

  const server = options?.server;
  const readServer = useCallback((): TResult => {
    const previous = serverCache.current;
    if (previous && previous.source === server) return previous.value;
    const value = server ? server() : read();
    serverCache.current = { source: server, value };
    return value;
  }, [read, server]);

  return useSyncExternalStore(subscribe, read, readServer);
}

export function useReadable<T>(readable: Readable<T>): T {
  const subscribe = useCallback((listener: () => void) => readable.subscribe(listener), [readable]);
  const read = useCallback(() => readable.current(), [readable]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useHistory<TCommit>(history: LocalHistory<TCommit>): HistoryState & {
  undo(): OperationResult<TCommit>;
  redo(): OperationResult<TCommit>;
} {
  const subscribe = useCallback((listener: () => void) => history.subscribe(listener), [history]);
  const read = useCallback(() => history.current(), [history]);
  const state = useSyncExternalStore(subscribe, read, read);
  const undo = useCallback(() => history.undo(), [history]);
  const redo = useCallback(() => history.redo(), [history]);

  return useMemo(() => ({ ...state, undo, redo }), [redo, state, undo]);
}
