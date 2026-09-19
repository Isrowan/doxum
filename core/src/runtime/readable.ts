import type { ObjectNode } from '../schema';
import type { DocumentReadable, DocumentRuntime } from './contract';
import { bindContext, contextOf } from './context';

// A readable capability keeps the canonical runtime behind an explicit
// mutation funnel while remaining fully compatible with selectors, views, and
// framework subscriptions.
export const asReadable = <TSchema extends ObjectNode>(
  runtime: DocumentRuntime<TSchema>
): DocumentReadable<TSchema> => {
  const readable: DocumentReadable<TSchema> = {
    revision: runtime.revision,
    subscribe: runtime.subscribe,
  };
  bindContext(readable, contextOf(runtime));
  return Object.freeze(readable);
};
