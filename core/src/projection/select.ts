import type { DocumentSchema } from '../schema';
import type { DocumentReader } from '../access/reader';
import type { DocumentReadable } from '../runtime/contract';
import { readWith } from '../runtime/access';

export type DocumentSelector<TSchema extends DocumentSchema, TResult> = (
  read: DocumentReader<TSchema>
) => TResult;

export const select = <TSchema extends DocumentSchema, TResult>(
  runtime: DocumentReadable<TSchema>,
  selector: DocumentSelector<TSchema, TResult>
): TResult => readWith(runtime, selector);
