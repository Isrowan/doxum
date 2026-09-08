import type { ObjectNode, Infer } from '../schema';
import { createAccess, type Read } from '../access/scope';
import type { DependencyTracker } from '../access/dependency';
import { DocumentDisposedError } from './contract';
import type { DocumentReadable } from './contract';

export type RuntimeAccessState<TSchema extends ObjectNode> = {
  readonly schema: TSchema;
  document: Infer<TSchema>;
  disposed: boolean;
  projectionLocks?: number;
};

const states = new WeakMap<object, RuntimeAccessState<ObjectNode>>();

export const bindRuntimeAccess = <TSchema extends ObjectNode>(
  runtime: DocumentReadable<TSchema>,
  state: RuntimeAccessState<TSchema>
): void => {
  states.set(runtime as object, state as RuntimeAccessState<ObjectNode>);
};

export const accessOf = <TSchema extends ObjectNode>(
  runtime: DocumentReadable<TSchema>
): RuntimeAccessState<TSchema> => {
  const state = states.get(runtime as object);
  if (!state) throw new Error('Unknown Doxum runtime.');
  return state as RuntimeAccessState<TSchema>;
};

export const schemaOf = <TSchema extends ObjectNode>(runtime: DocumentReadable<TSchema>): TSchema =>
  accessOf(runtime).schema;

export const documentOf = <TSchema extends ObjectNode>(
  runtime: DocumentReadable<TSchema>
): Infer<TSchema> => accessOf(runtime).document;

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
      schema: state.schema,
      root: () => state.document,
      dependencies,
    }) as Read<TSchema>;
    return run(reader);
  } finally {
    // readWith is an internal borrowed-reader boundary. Retaining its reader or
    // collection methods after this callback is undefined behavior.
    state.projectionLocks!--;
  }
};
