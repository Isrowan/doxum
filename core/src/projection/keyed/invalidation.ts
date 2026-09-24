import type { CollectionContext, SourceContext } from '@/projection/contract';
import type { KeyedDependencyRuntime } from './dependency';

type KeyedInvalidation = {
  readonly rebuild: boolean;
  readonly keys: Iterable<string>;
  readonly removed: readonly { readonly key: string }[];
  readonly structural: boolean;
};

/** Shared driver/dependency invalidation policy; owns no revisions or member cache. */
export const collectKeyedInvalidation = (
  driver: CollectionContext<string, unknown>,
  sources: readonly SourceContext[],
  dependencies: KeyedDependencyRuntime,
  reset: boolean
): KeyedInvalidation => {
  const changed = dependencies.driverChanged(driver);
  const change = changed ? driver.change : undefined;
  if (reset || (changed && (!change || change.kind === 'reset')))
    return { rebuild: true, keys: driver.read.ids(), removed: [], structural: true };

  const dirty = new Set<string>();
  let removed: readonly { readonly key: string }[] = [];
  let structural = false;
  if (change?.kind === 'incremental') {
    removed = change.removed;
    for (const entry of change.added) dirty.add(entry.key);
    for (const entry of change.updated) dirty.add(entry.key);
    structural = Boolean(change.added.length || change.removed.length || change.order);
  }
  const all = dependencies.collectInvalidated(sources, dirty);
  if (!all) for (const key of dirty) if (!driver.read.has(key)) dirty.delete(key);
  return { rebuild: false, keys: all ? driver.read.ids() : dirty, removed, structural };
};
