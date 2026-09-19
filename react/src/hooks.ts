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
import { select } from 'doxum';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

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
};

const objectIs = <T>(previous: T, next: T): boolean => Object.is(previous, next);

export function useDocumentSelector<TSchema extends ObjectNode, TResult>(
  runtime: DocumentReadable<TSchema>,
  selector: DocumentSelector<TSchema, TResult>,
  options?: DocumentSelectorOptions<TResult>
): TResult {
  const equality = options?.isEqual ?? objectIs;
  const readable = useMemo(
    () => select(runtime, selector, equality),
    [equality, runtime, selector]
  );
  return useReadable(readable);
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
