import type { DocumentSchema } from '../schema';
import type { DocumentReader } from '../access/reader';
import type { DocumentRuntime } from '../runtime/contract';
import { readWith } from '../runtime/access';

export type DocumentSelector<TSchema extends DocumentSchema, TResult> = (
  read: DocumentReader<TSchema>
) => TResult;

export const select = <TSchema extends DocumentSchema, TResult>(
  runtime: DocumentRuntime<TSchema>,
  selector: DocumentSelector<TSchema, TResult>
): TResult => readWith(runtime, selector);
