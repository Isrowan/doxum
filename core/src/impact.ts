import type { CollectionSelector, DocumentAddress, DocumentSchema, ImpactTarget } from './schema';
import type { DocumentOperationUnion } from './operations';
import { contains, overlaps } from './address';
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
  readonly operations: readonly DocumentOperationUnion<TSchema>[];
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
  readonly operations: readonly DocumentOperationUnion<TSchema>[];
  readonly paths?: readonly DocumentAddress[];
  readonly collections?: readonly MutationCollectionChange[];
  readonly reset?: boolean;
}): DocumentImpact<TSchema> => {
  const kind = input.reset ? 'reset' : 'incremental';
  const paths = input.paths ?? input.operations.map(operation => operation.at);
  let pathBuckets: Map<string | undefined, DocumentAddress[]> | undefined;
  const somePath = (
    address: DocumentAddress,
    test: (changed: DocumentAddress) => boolean
  ): boolean => {
    if (address.length === 0 || paths.length <= 8) return paths.some(test);
    if (!pathBuckets) {
      pathBuckets = new Map();
      for (const changed of paths) {
        const first = changed[0];
        const bucket = pathBuckets.get(first) ?? [];
        bucket.push(changed);
        pathBuckets.set(first, bucket);
      }
    }
    const root = pathBuckets.get(undefined);
    if (root?.some(test)) return true;
    return pathBuckets.get(address[0])?.some(test) ?? false;
  };
  const pathsAffect = (address: DocumentAddress): boolean =>
    address.length === 0
      ? paths.length > 0
      : somePath(address, changed => overlaps(changed, address));
  let collectionCache:
    | {
        readonly address: DocumentAddress;
        readonly value: CollectionImpact<unknown>;
      }[]
    | undefined;
  const findCollection = (address: DocumentAddress) =>
    input.collections?.find(
      entry =>
        entry.address.length === address.length &&
        entry.address.every((segment, index) => segment === address[index])
    );
  return {
    kind,
    operations: input.operations,
    affects: value => {
      profile.impact.affects();
      if (kind === 'reset') return true;
      if (!target.belongs(value, input.schema)) return false;
      const address = target.address(value);
      if (pathsAffect(address)) return true;
      if (value.kind === 'collection') {
        const collectionAddress = target.address(value);
        const collection = findCollection(collectionAddress);
        if (!collection) return false;
        const id = target.id(value);
        if (id !== undefined)
          return (
            collection.added.has(id) || collection.removed.has(id) || collection.updated.has(id)
          );
        return (
          collection.added.size > 0 ||
          collection.removed.size > 0 ||
          collection.updated.size > 0 ||
          collection.orderChanged
        );
      }
      return false;
    },
    collection: <TId extends string>(selector: CollectionSelector<TId>): CollectionImpact<TId> => {
      if (selector.schema !== input.schema)
        throw new Error('Collection selector belongs to another schema.');
      if (kind === 'reset') return resetCollectionImpact as CollectionImpact<TId>;
      const cached = collectionCache?.find(
        entry =>
          entry.address.length === selector.address.length &&
          entry.address.every((segment, index) => segment === selector.address[index])
      )?.value;
      if (cached) return cached as CollectionImpact<TId>;
      const exact = findCollection(selector.address);
      const subtreeReset = somePath(
        selector.address,
        changed => contains(changed, selector.address) && changed.length < selector.address.length
      );
      if (subtreeReset) {
        const reset = { kind: 'reset' } as const;
        (collectionCache ??= []).push({
          address: selector.address,
          value: reset,
        });
        return reset;
      }
      if (!exact) {
        const empty = emptyCollectionImpact as CollectionImpact<TId>;
        (collectionCache ??= []).push({
          address: selector.address,
          value: empty as CollectionImpact<unknown>,
        });
        return empty;
      }
      const incremental = {
        kind: 'incremental' as const,
        added: exact.added as ReadonlySet<TId>,
        removed: exact.removed as ReadonlySet<TId>,
        updated: exact.updated as ReadonlySet<TId>,
        orderChanged: exact.orderChanged,
      };
      (collectionCache ??= []).push({
        address: selector.address,
        value: incremental as CollectionImpact<unknown>,
      });
      return incremental;
    },
  };
};
