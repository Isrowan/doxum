import type { ObjectSchema } from '@/schema/model';
import type { ReadonlyDocument, DocumentRuntime } from './contract';
import { bindContext, contextOf } from './context';

// A readable capability keeps the canonical runtime behind an explicit
// mutation funnel while remaining fully compatible with selectors, views, and
// framework subscriptions.
export const readonlyDocument = <TSchema extends ObjectSchema<object>>(
  runtime: DocumentRuntime<TSchema>
): ReadonlyDocument<TSchema> => {
  const readable: ReadonlyDocument<TSchema> = {
    revision: runtime.revision,
    subscribe: runtime.subscribe,
  };
  bindContext(readable, contextOf(runtime));
  return Object.freeze(readable);
};
