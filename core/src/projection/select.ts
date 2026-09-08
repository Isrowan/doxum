import type { ObjectNode } from '../schema';
import type { Read } from '../access/scope';
import type { DocumentReadable } from '../runtime/contract';
import { readWith } from '../runtime/access';

export type DocumentSelector<TSchema extends ObjectNode, TResult> = (
  read: Read<TSchema>
) => TResult;

export const select = <TSchema extends ObjectNode, TResult>(
  runtime: DocumentReadable<TSchema>,
  selector: DocumentSelector<TSchema, TResult>
): TResult => readWith(runtime, selector);
