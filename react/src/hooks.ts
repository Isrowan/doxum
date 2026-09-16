import type {
  DocumentReadable,
  ObjectNode,
  DocumentSelector,
  HistoryState,
  LocalHistory,
  OperationResult,
  Readable,
  ProjectionRuntime,
  ProjectionScope,
  Projection,
  Input,
} from 'doxum';
import { track, subscribeDependencies, sameTarget, type ImpactTarget } from 'doxum/integration';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

const ProjectionContext = createContext<ProjectionRuntime | ProjectionScope | undefined>(undefined);
export const ProjectionProvider = ProjectionContext.Provider;

export function useProjection<T>(projection: Projection<T, unknown>): T;
export function useProjection<T, R>(
  projection: Projection<T, unknown>,
  selector: (value: T) => R,
  equality?: (previous: R, next: R) => boolean
): R;
export function useProjection<T, R>(
  projection: Projection<T, unknown>,
  selector?: (value: T) => R,
  equality: (previous: R, next: R) => boolean = Object.is
): T | R {
  const context = useContext(ProjectionContext);
  const owner = context;
  if (!owner) throw new Error('ProjectionRuntime is required.');
  const readable = useMemo(
    () => (selector ? owner.readable(projection, selector, equality) : owner.readable(projection)),
    [equality, owner, projection, selector]
  );
  return useReadable(readable as Readable<T | R>);
}

export function useInput<T>(input: Input<T>): readonly [T, (value: T) => void] {
  const context = useContext(ProjectionContext);
  const owner = context;
  if (!owner) throw new Error('ProjectionRuntime is required.');
  const value = useProjection(input);
  const set = useCallback((next: T) => owner.set(input, next), [input, owner]);
  return useMemo(() => [value, set] as const, [set, value]);
}

export type DocumentSelectorOptions<TResult> = {
  readonly isEqual?: (previous: TResult, next: TResult) => boolean;
  readonly server?: () => TResult;
};

type SelectorCache<TSchema extends ObjectNode, TResult> = {
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
    if (!sameTarget(left[index], right[index])) return false;
  return true;
};

export function useDocumentSelector<TSchema extends ObjectNode, TResult>(
  runtime: DocumentReadable<TSchema>,
  selector: DocumentSelector<TSchema, TResult>,
  options?: DocumentSelectorOptions<TResult>
): TResult {
  const equality = options?.isEqual ?? objectIs;
  const cache = useRef<SelectorCache<TSchema, TResult> | undefined>(undefined);
  const serverCache = useRef<
    | {
        readonly runtime: DocumentReadable<TSchema>;
        readonly selector: DocumentSelector<TSchema, TResult>;
        readonly source: (() => TResult) | undefined;
        readonly value: TResult;
      }
    | undefined
  >(undefined);

  const read = useMemo(() => {
    // Each selector closure owns its revision cache, including inline selectors
    // that allocate arrays or objects. Equality only compares distinct snapshots.
    let snapshot: { readonly revision: number; readonly value: TResult } | undefined;
    return (): TResult => {
      const revision = runtime.revision();
      if (snapshot?.revision === revision) return snapshot.value;
      const selection = track(runtime, selector);
      const previous = cache.current;
      const value =
        previous && previous.runtime === runtime && equality(previous.value, selection.value)
          ? previous.value
          : selection.value;
      cache.current = { runtime, value, targets: selection.targets };
      snapshot = { revision, value };
      return value;
    };
  }, [equality, runtime, selector]);

  const subscribe = useCallback(
    (listener: () => void) => {
      read();
      let targets = cache.current?.targets ?? [];
      let unsubscribe: () => void = () => undefined;
      const install = () => {
        if (targets.length === 0) return () => undefined;
        return subscribeDependencies(runtime, targets, onCommit);
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
        if (previous && !Object.is(previous.value, next)) listener();
      };
      unsubscribe = install();
      return () => unsubscribe();
    },
    [read, runtime]
  );

  const server = options?.server;
  const readServer = useCallback((): TResult => {
    const previous = serverCache.current;
    if (
      previous &&
      previous.source === server &&
      previous.runtime === runtime &&
      previous.selector === selector
    )
      return previous.value;
    const value = server ? server() : read();
    serverCache.current = { runtime, selector, source: server, value };
    return value;
  }, [read, server, runtime, selector]);

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
