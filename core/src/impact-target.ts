import type { DocumentAddress, ObjectNode, ImpactTarget } from './schema';
import type { ChangeSet } from './changes';
import { AddressIndex } from './address';

export const address = (target: ImpactTarget<unknown>): DocumentAddress =>
  'at' in target ? target.at : target.address;

export const id = (target: ImpactTarget<unknown>): string | undefined =>
  target.kind === 'collection' && 'id' in target ? target.id : undefined;

export const belongs = (target: ImpactTarget<unknown>, schema: ObjectNode): boolean =>
  !('schema' in target) || target.schema === schema;

export const same = (left: ImpactTarget<unknown>, right: ImpactTarget<unknown>): boolean => {
  if (left.kind !== right.kind) return false;
  if ('schema' in left && 'schema' in right && left.schema !== right.schema) return false;
  const leftAddress = address(left);
  const rightAddress = address(right);
  if (leftAddress.length !== rightAddress.length) return false;
  for (let index = 0; index < leftAddress.length; index += 1)
    if (leftAddress[index] !== rightAddress[index]) return false;
  return left.kind !== 'collection' || id(left) === id(right);
};

export const indexedAddress = (target: ImpactTarget<unknown>): DocumentAddress => {
  const key = id(target);
  return key === undefined ? address(target) : [...address(target), key];
};

export const affected = (
  target: ImpactTarget,
  values: AddressIndex<true>,
  orders: AddressIndex<true>
): boolean => {
  const at = indexedAddress(target);
  return id(target) !== undefined
    ? values.hasAncestor(at)
    : values.overlaps(at) || orders.hasDescendant(at);
};

/** Targets are classified once; commit matching never builds a reverse impact index. */
export class SubscriptionIndex<T> {
  private readonly ordinary = new AddressIndex<T>();
  private readonly membership = new AddressIndex<T>();
  constructor(private readonly schema: ObjectNode) {}
  add(target: ImpactTarget, value: T): void {
    if (belongs(target, this.schema))
      (id(target) === undefined ? this.ordinary : this.membership).add(
        indexedAddress(target),
        value
      );
  }
  delete(target: ImpactTarget, value: T): void {
    if (belongs(target, this.schema))
      (id(target) === undefined ? this.ordinary : this.membership).delete(
        indexedAddress(target),
        value
      );
  }
  collect(changes: ChangeSet, visit: (value: T) => void): void {
    const values = this.ordinary.query(visit);
    const members = this.membership.query(visit, 'descendants');
    const orders = this.ordinary.query(visit, 'ancestors');
    for (const change of changes.changes) {
      if (change.kind === 'reset') {
        values([]);
        members([]);
      } else if (change.kind === 'members') {
        values(change.at, change.members);
        members(change.at, change.members);
        if (change.order) orders(change.at);
      } else {
        values(change.at);
        members(change.at);
      }
    }
  }
  clear(): void {
    this.ordinary.clear();
    this.membership.clear();
  }
}
