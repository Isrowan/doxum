import type {
  ReadonlyDocument,
  ObjectSchema,
  DocumentSelector,
  HistoryState,
  LocalHistory,
  OperationResult,
  Readable,
  ProjectionRuntime,
  ProjectionScope,
  Projection,
  Input,
  CollectionInput,
  CollectionInputDraft,
} from 'doxum';
import { select } from 'doxum';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

const ProjectionContext = createContext<ProjectionRuntime | ProjectionScope | undefined>(undefined);
export const ProjectionProvider = ProjectionContext.Provider;

export function useProjection<T>(projection: Projection<T>): T;
export function useProjection<T, R>(
  projection: Projection<T>,
  selector: (value: T) => R,
  equality?: (previous: R, next: R) => boolean
): R;
export function useProjection<T, R>(
  projection: Projection<T>,
  selector?: (value: T) => R,
  equality: (previous: R, next: R) => boolean = Object.is
): T | R {
  const context = useContext(ProjectionContext);
  const owner = context;
  if (!owner) throw new Error('ProjectionRuntime is required.');
  const readable = useMemo(
    () => (selector ? owner.select(projection, selector, equality) : owner.select(projection)),
    [equality, owner, projection, selector]
  );
  return useReadable(readable as Readable<T | R>);
}

export function useInput<T>(input: Input<T>): readonly [T, (value: T) => void];
export function useInput<K extends string, V>(
  input: CollectionInput<K, V>
): readonly [
  ReadonlyMap<K, V>,
  <R>(
    run: (draft: CollectionInputDraft<K, V>) => R extends PromiseLike<unknown> ? never : R
  ) => void,
];
export function useInput(input: Projection<unknown>): readonly [unknown, (next: never) => void] {
  const context = useContext(ProjectionContext);
  const owner = context;
  if (!owner) throw new Error('ProjectionRuntime is required.');
  const value = useProjection(input);
  const update = useCallback(
    (next: never) =>
      (owner.update as (target: Projection<unknown>, next: unknown) => void)(input, next),
    [input, owner]
  );
  return useMemo(() => [value, update] as const, [update, value]);
}

const objectIs = <T>(previous: T, next: T): boolean => Object.is(previous, next);

export function useDocumentSelector<TSchema extends ObjectSchema<object>, TResult>(
  runtime: ReadonlyDocument<TSchema>,
  selector: DocumentSelector<TSchema, TResult>,
  equality: (previous: TResult, next: TResult) => boolean = objectIs
): TResult {
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
