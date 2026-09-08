import type { Change, ChangeSet, Presence } from '../changes';
import type { DocumentAddress, DocumentNode, ObjectNode } from '../schema';
import {
  AddressIndex,
  contains,
  nodeAt,
  read,
  resolveLocated,
  type ResolvedAddress,
} from '../address';
import { cloneValue, deepEqual } from '../value/ownership';
import { snapshotValue, copyValue, equalValue } from '../schema-value';
import type { MutableTree, MutableTreeNode } from './tree';
import { profile } from '../profile';

export type CanonicalState = { schema: ObjectNode; document: unknown };
type ValueFact = {
  kind: 'value';
  at: DocumentAddress;
  node: DocumentNode;
  before: Presence;
  location?: ResolvedAddress;
};
type OrderFact = { kind: 'order'; at: DocumentAddress; before: readonly string[] };
type TreeFact = {
  kind: 'tree';
  at: DocumentAddress;
  before: Presence<string>;
  nodes: Map<string, Presence<MutableTreeNode>>;
};
type Fact = ValueFact | OrderFact | TreeFact;
const absent = Object.freeze({ present: false } as const);
export const presence = (parent: object, key: PropertyKey): Presence =>
  Object.prototype.hasOwnProperty.call(parent, key)
    ? { present: true, value: (parent as Record<PropertyKey, unknown>)[key] }
    : absent;
export const samePresence = (a: Presence, b: Presence): boolean =>
  a.present === b.present && (!a.present || (b.present && deepEqual(a.value, b.value)));
export const valuePresence = (state: CanonicalState, at: DocumentAddress): Presence => {
  if (!at.length) return { present: true, value: state.document };
  const location = resolveLocated(state.schema, state.document, at);
  return location ? presence(location.parent, location.key) : absent;
};
export const installValue = (state: CanonicalState, at: DocumentAddress, value: Presence): void => {
  if (!at.length) {
    state.document = value.present ? value.value : undefined;
    return;
  }
  const location = resolveLocated(state.schema, state.document, at);
  if (!location) throw new Error('Cannot restore an unresolved address.');
  if (Array.isArray(location.parent)) {
    const index = Number(location.key);
    if (value.present) {
      if (index < 0) location.parent.push(value.value);
      else location.parent[index] = value.value;
    } else if (index >= 0) location.parent.splice(index, 1);
  } else if (value.present)
    Object.defineProperty(location.parent, location.key, {
      value: value.value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  else delete location.parent[location.key];
};
export const orderOf = (state: CanonicalState, at: DocumentAddress): string[] => {
  const node = nodeAt(state.schema, at, state.document);
  const value = read(state.document, at, state.schema);
  return node?.kind === 'list'
    ? (value as unknown[]).map(node.keyOf)
    : [...(value as { ids: string[] }).ids];
};
export const installOrder = (
  state: CanonicalState,
  at: DocumentAddress,
  order: readonly string[]
): void => {
  const node = nodeAt(state.schema, at, state.document);
  const value = read(state.document, at, state.schema);
  if (node?.kind === 'list') {
    const items = value as unknown[];
    const byKey = new Map(items.map(item => [node.keyOf(item), item]));
    items.length = order.length;
    for (let i = 0; i < order.length; i++) items[i] = byKey.get(order[i]);
  } else (value as { ids: string[] }).ids = [...order];
};
const treeRoot = (tree: MutableTree): Presence<string> =>
  tree.rootId === undefined ? absent : { present: true, value: tree.rootId };
const restoreTree = (
  tree: MutableTree,
  root: Presence<string>,
  nodes: Iterable<readonly [string, Presence<MutableTreeNode>]>
): void => {
  if (root.present) tree.rootId = root.value;
  else delete tree.rootId;
  for (const [id, item] of nodes) {
    if (item.present)
      Object.defineProperty(tree.nodes, id, {
        value: { ...item.value, children: [...item.value.children] },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    else delete tree.nodes[id];
  }
};
const restore = (fact: Fact, state: CanonicalState, skip = 0): void => {
  const at = fact.at.slice(skip);
  if (fact.kind === 'value')
    installValue(
      state,
      at,
      fact.before.present
        ? { present: true, value: copyValue(fact.node, fact.before.value) }
        : absent
    );
  else if (fact.kind === 'order') installOrder(state, at, fact.before);
  else restoreTree(read(state.document, at, state.schema) as MutableTree, fact.before, fact.nodes);
};

/** First-touch facts are the sole source for rollback and published before values. */
export class ChangeRecorder {
  private readonly facts = new Set<Fact>();
  private readonly slots = new WeakMap<object, Map<PropertyKey, ValueFact>>();
  private index?: AddressIndex<Fact>;
  constructor(private readonly state: CanonicalState) {}
  private indexed(): AddressIndex<Fact> {
    if (!this.index) {
      this.index = new AddressIndex();
      this.facts.forEach(fact => this.index!.add(fact.at, fact));
    }
    return this.index;
  }
  private covered(at: DocumentAddress): boolean {
    if (!this.index) return false;
    for (let i = 0; i <= at.length; i++) {
      const entries = this.index.exact(at.slice(0, i));
      if (entries && [...entries].some(fact => fact.kind === 'value')) return true;
    }
    return false;
  }
  value(at: DocumentAddress, node: DocumentNode, resolved?: ResolvedAddress): void {
    const location =
      resolved ??
      (at.length ? resolveLocated(this.state.schema, this.state.document, at) : undefined);
    const parent = location?.parent ?? this.state;
    const key = Array.isArray(parent) ? at[at.length - 1] : (location?.key ?? 'document');
    if (this.slots.get(parent)?.has(key) || this.covered(at)) return;
    let before = location ? presence(location.parent, location.key) : valuePresence(this.state, at);
    if (node.kind !== 'field') {
      const index = this.indexed();
      const children: Fact[] = [];
      index.query(fact => {
        if (contains(at, fact.at)) children.push(fact);
      })(at);
      if (before.present) {
        const copy = { schema: node as ObjectNode, document: copyValue(node, before.value) };
        for (const child of children.filter(f => f.kind !== 'order').reverse())
          restore(child, copy, at.length);
        for (const child of children.filter(f => f.kind === 'order'))
          restore(child, copy, at.length);
        before = { present: true, value: copy.document };
      }
      for (const child of children) {
        profile.recorder('absorbed');
        this.facts.delete(child);
        index.delete(child.at, child);
      }
    }
    const fact: ValueFact = {
      kind: 'value',
      at,
      node,
      before,
      ...(location && !Array.isArray(location.parent) ? { location } : {}),
    };
    let slots = this.slots.get(parent);
    if (!slots) this.slots.set(parent, (slots = new Map()));
    slots.set(key, fact);
    this.facts.add(fact);
    profile.recorder('facts');
    this.index?.add(at, fact);
  }
  order(at: DocumentAddress): void {
    if (this.covered(at)) return;
    const index = this.indexed();
    if ([...(index.exact(at) ?? [])].some(f => f.kind === 'order')) return;
    const fact: OrderFact = { kind: 'order', at, before: orderOf(this.state, at) };
    profile.recorder('orderSnapshots');
    profile.recorder('orderItems', fact.before.length);
    this.facts.add(fact);
    index.add(at, fact);
  }
  tree(at: DocumentAddress, ids: readonly string[]): void {
    if (this.covered(at)) return;
    const index = this.indexed();
    let fact = [...(index.exact(at) ?? [])].find((f): f is TreeFact => f.kind === 'tree');
    const tree = read(this.state.document, at, this.state.schema) as MutableTree;
    if (!fact) {
      fact = { kind: 'tree', at, before: treeRoot(tree), nodes: new Map() };
      this.facts.add(fact);
      index.add(at, fact);
    }
    for (const id of ids)
      if (!fact.nodes.has(id)) {
        profile.recorder('treeNodes');
        const entry = presence(tree.nodes, id);
        const value = entry.present ? (entry.value as MutableTreeNode) : undefined;
        fact.nodes.set(
          id,
          value ? { present: true, value: { ...value, children: [...value.children] } } : absent
        );
      }
  }
  rollback(): void {
    const facts = [...this.facts];
    for (const fact of facts.filter(f => f.kind !== 'order').reverse()) restore(fact, this.state);
    for (const fact of facts.filter(f => f.kind === 'order')) restore(fact, this.state);
  }
  seal(): ChangeSet {
    const changes: Change[] = [];
    const publish = (node: DocumentNode, p: Presence): Presence =>
      p.present
        ? Object.freeze({
            present: true,
            value: cloneValue(snapshotValue(node, p.value), 'commit'),
          })
        : absent;
    const emit = (
      node: DocumentNode,
      at: DocumentAddress,
      before: Presence,
      after: Presence
    ): void => {
      if (
        before.present === after.present &&
        (!before.present || (after.present && equalValue(node, before.value, after.value)))
      )
        return;
      if (
        at.length &&
        before.present &&
        after.present &&
        before.value !== undefined &&
        after.value !== undefined
      ) {
        let shape = node.kind === 'object' ? node.shape : undefined;
        if (node.kind === 'variant') {
          const a = before.value as Record<string, unknown>,
            b = after.value as typeof a;
          if (a[node.tag] === b[node.tag]) shape = node.variants[String(a[node.tag])].shape;
        }
        if (shape) {
          const a = before.value as Record<string, unknown>,
            b = after.value as typeof a;
          const extras = new Set(
            [...Reflect.ownKeys(a), ...Reflect.ownKeys(b)].filter(
              key => typeof key !== 'string' || !Object.hasOwn(shape, key)
            )
          );
          if ([...extras].every(key => samePresence(presence(a, key), presence(b, key)))) {
            for (const key of Object.keys(shape))
              emit(shape[key], [...at, key], presence(a, key), presence(b, key));
            return;
          }
        }
        if (node.kind === 'map' || node.kind === 'table') {
          const a = before.value as Record<string, unknown>,
            b = after.value as typeof a;
          const left = (node.kind === 'table' ? a.byId : a) as Record<string, unknown>,
            right = (node.kind === 'table' ? b.byId : b) as typeof left;
          for (const id of new Set([...Object.keys(left), ...Object.keys(right)]))
            emit(node.value, [...at, id], presence(left, id), presence(right, id));
          if (node.kind === 'table' && !deepEqual(a.ids, b.ids))
            changes.push(
              cloneValue({ kind: 'order', at, before: a.ids, after: b.ids }, 'commit') as Change
            );
          return;
        }
      }
      changes.push(
        Object.freeze({
          kind: 'value',
          at: Object.freeze([...at]),
          before: publish(node, before),
          after: publish(node, after),
        })
      );
    };
    for (const fact of this.facts) {
      if (fact.kind === 'value') {
        const after = fact.location
          ? presence(fact.location.parent, fact.location.key)
          : valuePresence(this.state, fact.at);
        emit(fact.node, fact.at, fact.before, after);
      } else if (fact.kind === 'order') {
        const after = orderOf(this.state, fact.at);
        if (!deepEqual(fact.before, after))
          changes.push(
            Object.freeze({
              kind: 'order',
              at: Object.freeze([...fact.at]),
              before: Object.freeze([...fact.before]),
              after: Object.freeze(after),
            })
          );
      } else {
        const tree = read(this.state.document, fact.at, this.state.schema) as MutableTree;
        const node = nodeAt(this.state.schema, fact.at, this.state.document);
        if (node?.kind !== 'tree') throw new Error('Tree schema disappeared before sealing.');
        const publishNode = (p: Presence): Presence => {
          if (!p.present) return absent;
          const value = p.value as MutableTreeNode;
          return {
            present: true,
            value: {
              ...value,
              children: [...value.children],
              ...(Object.hasOwn(value, 'value')
                ? { value: snapshotValue(node.value, value.value) }
                : {}),
            },
          };
        };
        const nodes = [...fact.nodes].flatMap(([id, before]) => {
          const after = presence(tree.nodes, id);
          if (!before.present && !after.present) return [];
          if (before.present && after.present) {
            const a = before.value,
              b = after.value as MutableTreeNode;
            if (
              a.parentId === b.parentId &&
              deepEqual(a.children, b.children) &&
              Object.hasOwn(a, 'value') === Object.hasOwn(b, 'value') &&
              equalValue(node.value, a.value, b.value)
            )
              return [];
          }
          return [{ id, before: publishNode(before), after: publishNode(after) }];
        });
        const after = treeRoot(tree);
        if (nodes.length || !samePresence(fact.before, after))
          changes.push(
            cloneValue(
              { kind: 'tree', at: fact.at, before: fact.before, after, nodes },
              'commit'
            ) as Change
          );
      }
    }
    changes.sort(compareChanges);
    profile.recorder('sealed', changes.length);
    return Object.freeze({ changes: Object.freeze(changes) });
  }
}

export const compareChanges = (
  a: { at: DocumentAddress; kind: string },
  b: { at: DocumentAddress; kind: string }
): number => {
  const length = Math.min(a.at.length, b.at.length);
  for (let i = 0; i < length; i++) if (a.at[i] !== b.at[i]) return a.at[i] < b.at[i] ? -1 : 1;
  return a.at.length - b.at.length || (a.kind < b.kind ? -1 : a.kind === b.kind ? 0 : 1);
};
