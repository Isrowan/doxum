import type { ObjectNode } from '../schema';
import { createAccess, type Read } from '../access/scope';
import type { DependencyTracker } from '../access/dependency';
import { DocumentDisposedError } from './contract';
import type { DocumentReadable } from './contract';
import { contextOf, type RuntimeState } from './context';

export type RuntimeAccessState<TSchema extends ObjectNode> = RuntimeState<TSchema>;

export const accessOf = <TSchema extends ObjectNode>(
  runtime: DocumentReadable<TSchema>
): RuntimeAccessState<TSchema> => {
  return contextOf<TSchema>(runtime).state;
};

export const readWith = <TSchema extends ObjectNode, TResult>(
  runtime: DocumentReadable<TSchema>,
  run: (read: Read<TSchema>) => TResult,
  dependencies?: DependencyTracker
): TResult => {
  const state = accessOf(runtime);
  if (state.disposed) throw new DocumentDisposedError();
  state.projectionLocks = (state.projectionLocks ?? 0) + 1;
  try {
    const reader = createAccess({
      state,
      dependencies,
    }) as Read<TSchema>;
    return run(reader);
  } finally {
    // readWith is an internal borrowed-reader boundary. Retaining its reader or
    // collection methods after this callback is undefined behavior.
    state.projectionLocks!--;
  }
};
