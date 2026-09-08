import type {
  CollectionId,
  CollectionPath,
  CollectionSelector,
  ObjectNode,
  ImpactTarget,
  PathPick,
  SchemaPath,
} from './schema';
import { compilePath } from './schema';
import type { ChangeSet } from './changes';
import { AddressIndex, contains } from './address';
import * as target from './impact-target';
import { profile } from './profile';

export type CollectionImpact<K> =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'incremental';
      readonly added: ReadonlySet<K>;
      readonly removed: ReadonlySet<K>;
      readonly updated: ReadonlySet<K>;
      readonly orderChanged: boolean;
    };
export type DocumentImpact<S extends ObjectNode> = {
  readonly kind: 'incremental' | 'reset';
  affects(pick: PathPick<S>): boolean;
  collection<P extends CollectionPath>(
    pick: (path: SchemaPath<S['shape']>) => P
  ): CollectionImpact<CollectionId<P>>;
};
type ImpactQueries = {
  affects(value: ImpactTarget): boolean;
  collection(selector: CollectionSelector): CollectionImpact<string>;
};
const queries = new WeakMap<object, ImpactQueries>();
export const affectsTarget = (impact: object, value: ImpactTarget): boolean =>
  queries.get(impact)!.affects(value);
export const collectionImpact = <K extends string>(
  impact: object,
  selector: CollectionSelector<K>
): CollectionImpact<K> => queries.get(impact)!.collection(selector) as CollectionImpact<K>;
export const createImpact = <S extends ObjectNode>(
  schema: S,
  changes: ChangeSet
): DocumentImpact<S> => {
  const reset = changes.changes.some(change => change.at.length === 0);
  let values: AddressIndex<true> | undefined;
  let orders: AddressIndex<true> | undefined;
  const index = () => {
    if (!values) {
      values = new AddressIndex();
      orders = new AddressIndex();
      for (const change of changes.changes)
        (change.kind === 'order' ? orders : values).add(change.at, true);
    }
    return values;
  };
  const cache = new Map<string, CollectionImpact<string>>();
  const implementation: ImpactQueries = {
    affects(value) {
      profile.impact.affects();
      if (!target.belongs(value, schema)) return false;
      if (reset) return true;
      const values = index(),
        at = target.indexedAddress(value);
      if (value.kind === 'collection' && 'id' in value && value.id !== undefined)
        return values.hasAncestor(at);
      return values.overlaps(at) || orders!.hasDescendant(at);
    },
    collection(selector) {
      if (selector.schema !== schema)
        throw new TypeError('Collection belongs to another root model.');
      const key = JSON.stringify(selector.address),
        cached = cache.get(key);
      if (cached) return cached;
      const at = selector.address;
      const added = new Set<string>(),
        removed = new Set<string>(),
        updated = new Set<string>();
      let orderChanged = false;
      for (const change of changes.changes) {
        if (change.kind !== 'order' && contains(change.at, at)) {
          const result = { kind: 'reset' } as const;
          cache.set(key, result);
          return result;
        }
        if (!contains(at, change.at)) continue;
        if (change.at.length === at.length) {
          if (change.kind === 'order') {
            const positions = new Map(change.after.map((id, i) => [id, i]));
            let previous = -1;
            for (const id of change.before) {
              const position = positions.get(id);
              if (position === undefined) continue;
              if (position < previous) orderChanged = true;
              previous = position;
            }
          }
          continue;
        }
        const id = change.at[at.length];
        if (change.kind === 'value' && change.at.length === at.length + 1) {
          if (!change.before.present && change.after.present) added.add(id);
          else if (change.before.present && !change.after.present) removed.add(id);
          else updated.add(id);
        } else updated.add(id);
      }
      added.forEach(id => updated.delete(id));
      removed.forEach(id => updated.delete(id));
      const result = { kind: 'incremental', added, removed, updated, orderChanged } as const;
      cache.set(key, result);
      return result;
    },
  };
  const impact: DocumentImpact<S> = Object.freeze({
    kind: reset ? 'reset' : 'incremental',
    affects: (pick: PathPick<S>) =>
      implementation.affects(compilePath<S['shape']>(schema, 'value', pick)),
    collection: <P extends CollectionPath>(pick: (path: SchemaPath<S['shape']>) => P) =>
      implementation.collection(
        compilePath<S['shape']>(schema, 'collection', pick) as CollectionSelector
      ) as CollectionImpact<CollectionId<P>>,
  });
  queries.set(impact, implementation);
  return impact;
};
