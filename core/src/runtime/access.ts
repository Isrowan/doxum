import type { DocumentSchema, ReadonlyDocument } from '../schema';
import type { DocumentReader } from '../access/reader';
import { documentReader } from '../access/reader';
import type { DependencyTracker } from '../access/dependency';
import { DocumentDisposedError } from './contract';
import type { DocumentRuntime } from './contract';

export type RuntimeAccessState<TSchema extends DocumentSchema> = {
  readonly schema: TSchema;
  document: ReadonlyDocument<TSchema>;
  disposed: boolean;
};

const states = new WeakMap<object, RuntimeAccessState<DocumentSchema>>();

export const bindRuntimeAccess = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>,
  state: RuntimeAccessState<TSchema>
): void => {
  states.set(runtime as object, state as RuntimeAccessState<DocumentSchema>);
};

export const accessOf = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>
): RuntimeAccessState<TSchema> => {
  const state = states.get(runtime as object);
  if (!state) throw new Error('Unknown Doxum runtime.');
  return state as RuntimeAccessState<TSchema>;
};

export const schemaOf = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>
): TSchema => accessOf(runtime).schema;

export const documentOf = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>
): ReadonlyDocument<TSchema> => accessOf(runtime).document;

export const readWith = <TSchema extends DocumentSchema, TResult>(
  runtime: DocumentRuntime<TSchema>,
  run: (read: DocumentReader<TSchema>) => TResult,
  dependencies?: DependencyTracker
): TResult => {
  const state = accessOf(runtime);
  if (state.disposed) throw new DocumentDisposedError();
  let active = true;
  const reader = documentReader(
    state.schema,
    () => state.document,
    () => active,
    dependencies
  );
  try {
    return run(reader);
  } finally {
    // Readers are transaction-scoped; retaining one cannot expose later
    // mutable canonical state outside the coordinating operation.
    active = false;
  }
};
