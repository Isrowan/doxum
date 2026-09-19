import type { DocumentAddress, ObjectNode, ImpactTarget, TreeTarget } from './schema';
import type { ChangeSet } from './changes';
import { AddressIndex } from './address';

const treeRootSegment = 'rootId';
const treeNodesSegment = 'nodes';
const ordinaryNamespace = '\0value';
const treeNamespace = '\0tree';

export const tree = (
  at: DocumentAddress,
  selection: Exclude<TreeTarget, { readonly kind: 'nodes' }>
): ImpactTarget => ({ kind: 'value', at, tree: selection });

export const address = (target: ImpactTarget<unknown>): DocumentAddress =>
  'at' in target ? target.at : target.address;

export const id = (target: ImpactTarget<unknown>): string | undefined =>
  target.kind === 'collection' && 'id' in target ? target.id : undefined;

export const belongs = (target: ImpactTarget<unknown>, schema: ObjectNode): boolean =>
  !('schema' in target) || target.schema === schema;

const treeTarget = (target: ImpactTarget<unknown>): TreeTarget | undefined =>
  'tree' in target ? target.tree : undefined;

const sameTreeTarget = (left: TreeTarget | undefined, right: TreeTarget | undefined): boolean => {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind !== 'node' || (right.kind === 'node' && left.id === right.id);
};

export const same = (left: ImpactTarget<unknown>, right: ImpactTarget<unknown>): boolean => {
  if ('schema' in left && 'schema' in right && left.schema !== right.schema) return false;
  if (!sameTreeTarget(treeTarget(left), treeTarget(right))) return false;
  if (left.kind !== right.kind) return false;
  const leftAddress = address(left);
  const rightAddress = address(right);
  if (leftAddress.length !== rightAddress.length) return false;
  for (let index = 0; index < leftAddress.length; index += 1)
    if (leftAddress[index] !== rightAddress[index]) return false;
  return left.kind !== 'collection' || id(left) === id(right);
};

export const indexedAddress = (target: ImpactTarget<unknown>): DocumentAddress => {
  const tree = treeTarget(target);
  if (tree?.kind === 'root') return [treeNamespace, ...address(target), treeRootSegment];
  if (tree?.kind === 'nodes') return [treeNamespace, ...address(target), treeNodesSegment];
  if (tree?.kind === 'node') return [treeNamespace, ...address(target), treeNodesSegment, tree.id];
  const key = id(target);
  return key === undefined
    ? [ordinaryNamespace, ...address(target)]
    : [ordinaryNamespace, ...address(target), key];
};

export const visitChangedLocations = (
  changes: ChangeSet,
  value: (at: DocumentAddress) => void,
  order: (at: DocumentAddress) => void
): void => {
  for (const change of changes.changes) {
    if (change.kind === 'reset') continue;
    if (change.kind === 'members') {
      for (const member of change.members) {
        value([ordinaryNamespace, ...change.at, member.key]);
        value([treeNamespace, ...change.at, member.key]);
      }
      if (change.order) order([ordinaryNamespace, ...change.at]);
      continue;
    }
    value([ordinaryNamespace, ...change.at]);
    if (change.before !== change.after) value([treeNamespace, ...change.at, treeRootSegment]);
    for (const node of change.nodes)
      value([treeNamespace, ...change.at, treeNodesSegment, node.id]);
  }
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
    if (!belongs(target, this.schema)) return;
    (id(target) === undefined ? this.ordinary : this.membership).add(indexedAddress(target), value);
  }
  delete(target: ImpactTarget, value: T): void {
    if (!belongs(target, this.schema)) return;
    (id(target) === undefined ? this.ordinary : this.membership).delete(
      indexedAddress(target),
      value
    );
  }
  collect(changes: ChangeSet, visit: (value: T) => void): void {
    const values = this.ordinary.query(visit);
    const members = this.membership.query(visit, 'descendants');
    const orders = this.ordinary.query(visit, 'ancestors');
    if (changes.changes.some(change => change.kind === 'reset')) {
      values([]);
      members([]);
      return;
    }
    visitChangedLocations(
      changes,
      at => {
        values(at);
        members(at);
      },
      orders
    );
  }
  clear(): void {
    this.ordinary.clear();
    this.membership.clear();
  }
}
