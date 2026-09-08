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
  const reset = changes.changes.some(change => change.kind === 'reset');
  let values: AddressIndex<true> | undefined;
  let orders: AddressIndex<true> | undefined;
  const index = () => {
    if (!values) {
      profile.impact.index();
      values = new AddressIndex();
      orders = new AddressIndex();
      for (const change of changes.changes) {
        if (change.kind === 'members')
          for (const member of change.members) values.add(change.at, true, member.key);
        else if (change.kind !== 'reset')
          (change.kind === 'order' ? orders : values).add(change.at, true);
      }
    }
    return values;
  };
  const cache = new Map<string, CollectionImpact<string>>();
  const implementation: ImpactQueries = {
    affects(value) {
      profile.impact.affects();
      if (!target.belongs(value, schema)) return false;
      if (reset) return true;
      return target.affected(value, index(), orders!);
    },
    collection(selector) {
      if (selector.schema !== schema)
        throw new TypeError('Collection belongs to another root model.');
      const key = JSON.stringify(selector.address),
        cached = cache.get(key);
      if (cached) return cached;
      if (reset) {
        const result = { kind: 'reset' } as const;
        cache.set(key, result);
        return result;
      }
      const at = selector.address;
      const added = new Set<string>(),
        removed = new Set<string>(),
        updated = new Set<string>();
      let orderChanged = false;
      for (const change of changes.changes) {
        if (change.kind === 'reset') continue;
        if (change.kind === 'members') {
          if (change.at.length < at.length && contains(change.at, at)) {
            if (change.members.some(member => member.key === at[change.at.length])) {
              const result = { kind: 'reset' } as const;
              cache.set(key, result);
              return result;
            }
          } else if (contains(at, change.at)) {
            if (change.at.length === at.length) {
              for (const member of change.members) {
                if (member.kind === 'added') added.add(member.key);
                else if (member.kind === 'removed') removed.add(member.key);
                else updated.add(member.key);
              }
            } else updated.add(change.at[at.length]);
          }
          continue;
        }
        if (change.kind === 'tree' && contains(change.at, at)) {
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
        updated.add(id);
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
