import type { ObjectSchema } from '../schema/model';
import { createAccess, type Read } from '../access/scope';
import type { DependencyTracker } from '../access/dependency';
import { DocumentDisposedError } from './contract';
import type { ReadonlyDocument } from './contract';
import { contextOf } from './context';

export const readWith = <TSchema extends ObjectSchema<object>, TResult>(
  runtime: ReadonlyDocument<TSchema>,
  run: (read: Read<TSchema>) => TResult,
  dependencies?: DependencyTracker
): TResult => {
  const state = contextOf<TSchema>(runtime).state;
  if (state.disposed) throw new DocumentDisposedError();
  state.projectionLocks += 1;
  try {
    const reader = createAccess({
      state,
      dependencies,
    }) as Read<TSchema>;
    return run(reader);
  } finally {
    // readWith is an internal borrowed-reader boundary. Retaining its reader or
    // collection methods after this callback is undefined behavior.
    state.projectionLocks--;
  }
};
