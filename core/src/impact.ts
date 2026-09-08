import type { CollectionSelector, DocumentAddress, DocumentSchema, ImpactTarget } from './schema';
import type { DocumentOperation } from './operations';
import { AddressIndex, contains } from './address';
import type { MutationCollectionChange } from './mutation/contract';
import { profile } from './profile';
import * as target from './impact-target';

export type CollectionImpact<TId> =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'incremental';
      readonly added: ReadonlySet<TId>;
      readonly removed: ReadonlySet<TId>;
      readonly updated: ReadonlySet<TId>;
      readonly orderChanged: boolean;
    };

export type DocumentImpact<TSchema extends DocumentSchema> = {
  readonly kind: 'incremental' | 'reset';
  readonly affects: (target: ImpactTarget<unknown>) => boolean;
  readonly collection: <TId extends string>(
    selector: CollectionSelector<TId>
  ) => CollectionImpact<TId>;
  readonly operations: readonly DocumentOperation[];
};

const emptyCollectionImpact: CollectionImpact<string> = Object.freeze({
  kind: 'incremental',
  added: new Set<string>(),
  removed: new Set<string>(),
  updated: new Set<string>(),
  orderChanged: false,
});
const resetCollectionImpact: CollectionImpact<never> = Object.freeze({
  kind: 'reset',
});

export const createImpact = <TSchema extends DocumentSchema>(input: {
  readonly schema: TSchema;
  readonly operations: readonly DocumentOperation[];
  readonly paths: readonly DocumentAddress[];
  readonly collections?: readonly MutationCollectionChange[];
  readonly reset?: boolean;
}): DocumentImpact<TSchema> => {
  const kind = input.reset ? 'reset' : 'incremental';
  let values: AddressIndex<true> | undefined;
  let orders: AddressIndex<true> | undefined;
  let collections: AddressIndex<MutationCollectionChange> | undefined;
  const changes = input.collections ?? [];
  const paths = input.paths;
  const getCollections = () => {
    if (collections) return collections;
    const index = new AddressIndex<MutationCollectionChange>();
    for (const change of changes) index.add(change.address, change);
    return (collections = index);
  };
  const getValues = () => {
    if (values) return values;
    const index = new AddressIndex<true>();
    const collectionIndex = getCollections();
    for (const path of paths) {
      const collection = collectionIndex.exact(path)?.values().next().value;
      if (!collection) index.add(path, true);
      else {
        for (const id of collection.added) index.add([...path, id], true);
        for (const id of collection.removed) index.add([...path, id], true);
        for (const id of collection.updated) index.add([...path, id], true);
      }
    }
    return (values = index);
  };
  const getOrders = () => {
    if (orders) return orders;
    const index = new AddressIndex<true>();
    for (const change of changes) if (change.orderChanged) index.add(change.address, true);
    return (orders = index);
  };
  const collectionCache = new AddressIndex<CollectionImpact<string>>();
  return {
    kind,
    operations: input.operations,
    affects: value => {
      profile.impact.affects();
      if (!target.belongs(value, input.schema)) return false;
      if (kind === 'reset') return true;
      const valueIndex = getValues();
      const address = target.indexedAddress(value);
      return valueIndex.overlaps(address) || getOrders().hasDescendant(address);
    },
    collection: <TId extends string>(selector: CollectionSelector<TId>): CollectionImpact<TId> => {
      if (selector.schema !== input.schema)
        throw new Error('Collection selector belongs to another schema.');
      if (kind === 'reset') return resetCollectionImpact as CollectionImpact<TId>;
      const cached = collectionCache.exact(selector.address)?.values().next().value;
      if (cached) return cached as CollectionImpact<TId>;
      const collectionIndex = getCollections();
      const exact = collectionIndex.exact(selector.address)?.values().next().value;
      // Only ancestor changes can reset this collection. Descendant field paths
      // do not require a value index just to read collection membership changes.
      const subtreeReset = paths.some(path => {
        if (path.length >= selector.address.length || !contains(path, selector.address))
          return false;
        const membership = collectionIndex.exact(path)?.values().next().value;
        if (!membership) return true;
        const id = selector.address[path.length];
        return (
          path.length + 1 < selector.address.length &&
          (membership.added.has(id) || membership.removed.has(id) || membership.updated.has(id))
        );
      });
      if (subtreeReset) {
        const reset = { kind: 'reset' } as const;
        collectionCache.add(selector.address, reset);
        return reset;
      }
      if (!exact) {
        const empty = emptyCollectionImpact as CollectionImpact<TId>;
        collectionCache.add(selector.address, empty as CollectionImpact<string>);
        return empty;
      }
      const incremental = {
        kind: 'incremental' as const,
        added: exact.added as ReadonlySet<TId>,
        removed: exact.removed as ReadonlySet<TId>,
        updated: exact.updated as ReadonlySet<TId>,
        orderChanged: exact.orderChanged,
      };
      collectionCache.add(selector.address, incremental as CollectionImpact<string>);
      return incremental;
    },
  };
};
