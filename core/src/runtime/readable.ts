import type { DocumentSchema } from '../schema';
import type { DocumentReadable, DocumentRuntime } from './contract';
import { accessOf, bindRuntimeAccess } from './access';
import { shareNotification } from './notification';

// A readable capability keeps the canonical runtime behind an explicit
// mutation funnel while remaining fully compatible with selectors, views, and
// framework subscriptions.
export const asReadable = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>
): DocumentReadable<TSchema> => {
  const readable: DocumentReadable<TSchema> = {
    address: runtime.address,
    revision: runtime.revision,
    subscribe: runtime.subscribe,
  };
  bindRuntimeAccess(readable, accessOf(runtime));
  shareNotification(runtime, readable);
  return Object.freeze(readable);
};
