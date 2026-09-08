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
import * as anchor from './anchor';
import { copyValue, equalValue } from '../schema-value';
import type { MutableTree, MutableTreeNode } from './tree';
import { profile } from '../profile';

export type CanonicalState = { schema: ObjectNode; document: unknown };
type ValueFact = {
  kind: 'value';
  index: number;
  at: DocumentAddress;
  node: DocumentNode;
  present: boolean;
  value: unknown;
  location?: ResolvedAddress;
};
type OrderFact = { kind: 'order'; index: number; at: DocumentAddress; before: readonly string[] };
type TreeFact = {
  kind: 'tree';
  index: number;
  at: DocumentAddress;
  before: Presence<string>;
  nodes: Map<string, Presence<MutableTreeNode>>;
};
type Fact = ValueFact | OrderFact | TreeFact;
const absent = { present: false } as const;
export const presence = (parent: object, key: PropertyKey): Presence =>
  Object.prototype.hasOwnProperty.call(parent, key)
    ? { present: true, value: (parent as Record<PropertyKey, unknown>)[key] }
    : absent;
export const samePresence = (a: Presence, b: Presence): boolean =>
  a.present === b.present && (!a.present || (b.present && Object.is(a.value, b.value)));
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
      fact.present ? { present: true, value: copyValue(fact.node, fact.value) } : absent
    );
  else if (fact.kind === 'order') installOrder(state, at, fact.before);
  else restoreTree(read(state.document, at, state.schema) as MutableTree, fact.before, fact.nodes);
};

/** First-touch facts are the sole source for rollback and published before values. */
export class ChangeRecorder {
  private readonly facts: (Fact | undefined)[] = [];
  private readonly slots = new WeakMap<object, Set<PropertyKey>>();
  private index?: AddressIndex<Fact>;
  constructor(private readonly state: CanonicalState) {}
  private indexed(): AddressIndex<Fact> {
    if (!this.index) {
      this.index = new AddressIndex();
      this.facts.forEach(fact => {
        if (fact) this.index!.add(fact.at, fact);
      });
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
    const present = location ? Object.hasOwn(location.parent, location.key) : true;
    let value = location
      ? (location.parent as Record<string | number, unknown>)[location.key]
      : this.state.document;
    if (node.kind !== 'field') {
      const index = this.indexed();
      const children: Fact[] = [];
      index.query(fact => {
        if (contains(at, fact.at)) children.push(fact);
      })(at);
      if (present) {
        const copy = { schema: node as ObjectNode, document: copyValue(node, value) };
        for (const child of children.filter(f => f.kind !== 'order').reverse())
          restore(child, copy, at.length);
        for (const child of children.filter(f => f.kind === 'order'))
          restore(child, copy, at.length);
        value = copy.document;
      }
      for (const child of children) {
        profile.recorder('absorbed');
        this.facts[child.index] = undefined;
        index.delete(child.at, child);
      }
    }
    const fact: ValueFact = {
      kind: 'value',
      index: this.facts.length,
      at,
      node,
      present,
      value,
      location: location && !Array.isArray(location.parent) ? location : undefined,
    };
    let slots = this.slots.get(parent);
    if (!slots) this.slots.set(parent, (slots = new Set()));
    slots.add(key);
    this.facts.push(fact);
    profile.recorder('facts');
    this.index?.add(at, fact);
  }
  order(at: DocumentAddress): void {
    if (this.covered(at)) return;
    const index = this.indexed();
    if ([...(index.exact(at) ?? [])].some(f => f.kind === 'order')) return;
    const fact: OrderFact = {
      kind: 'order',
      index: this.facts.length,
      at,
      before: orderOf(this.state, at),
    };
    profile.recorder('orderSnapshots');
    profile.recorder('orderItems', fact.before.length);
    this.facts.push(fact);
    index.add(at, fact);
  }
  tree(at: DocumentAddress, ids: readonly string[]): void {
    if (this.covered(at)) return;
    const index = this.indexed();
    let fact = [...(index.exact(at) ?? [])].find((f): f is TreeFact => f.kind === 'tree');
    const tree = read(this.state.document, at, this.state.schema) as MutableTree;
    if (!fact) {
      fact = {
        kind: 'tree',
        index: this.facts.length,
        at,
        before: treeRoot(tree),
        nodes: new Map(),
      };
      this.facts.push(fact);
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
    for (let i = this.facts.length - 1; i >= 0; i--) {
      const fact = this.facts[i];
      if (fact && fact.kind !== 'order') restore(fact, this.state);
    }
    for (const fact of this.facts) if (fact?.kind === 'order') restore(fact, this.state);
  }
  seal(): ChangeSet {
    const changes: Change[] = [];
    const publish = (node: DocumentNode, present: boolean, value: unknown): Presence =>
      present ? { present: true, value: copyValue(node, value) } : absent;
    const emit = (
      node: DocumentNode,
      at: DocumentAddress,
      beforePresent: boolean,
      before: unknown,
      afterPresent: boolean,
      after: unknown
    ): void => {
      if (beforePresent === afterPresent && (!beforePresent || Object.is(before, after))) return;
      if (
        node.kind !== 'field' &&
        at.length &&
        beforePresent &&
        afterPresent &&
        before !== undefined &&
        after !== undefined
      ) {
        let shape = node.kind === 'object' ? node.shape : undefined;
        if (node.kind === 'variant') {
          const a = before as Record<string, unknown>,
            b = after as typeof a;
          if (a[node.tag] === b[node.tag]) shape = node.variants[String(a[node.tag])].shape;
        }
        if (shape) {
          const a = before as Record<string, unknown>,
            b = after as typeof a;
          const extras = new Set(
            [...Reflect.ownKeys(a), ...Reflect.ownKeys(b)].filter(
              key => typeof key !== 'string' || !Object.hasOwn(shape, key)
            )
          );
          if ([...extras].every(key => samePresence(presence(a, key), presence(b, key)))) {
            for (const key of Object.keys(shape))
              emit(
                shape[key],
                at.concat(key),
                Object.hasOwn(a, key),
                a[key],
                Object.hasOwn(b, key),
                b[key]
              );
            return;
          }
        }
        if (node.kind === 'map' || node.kind === 'table') {
          const a = before as Record<string, unknown>,
            b = after as typeof a;
          const left = (node.kind === 'table' ? a.byId : a) as Record<string, unknown>,
            right = (node.kind === 'table' ? b.byId : b) as typeof left;
          for (const id of new Set([...Object.keys(left), ...Object.keys(right)]))
            emit(
              node.value,
              at.concat(id),
              Object.hasOwn(left, id),
              left[id],
              Object.hasOwn(right, id),
              right[id]
            );
          if (node.kind === 'table' && !anchor.equal(a.ids as string[], b.ids as string[]))
            changes.push({
              kind: 'order',
              at,
              before: a.ids as string[],
              after: [...(b.ids as string[])],
            });
          return;
        }
      }
      if (beforePresent === afterPresent && equalValue(node, before, after)) return;
      changes.push({
        kind: 'value',
        at,
        before: beforePresent ? { present: true, value: before } : absent,
        after: publish(node, afterPresent, after),
      });
    };
    for (const fact of this.facts) {
      if (!fact) continue;
      if (fact.kind === 'value') {
        if (fact.location) {
          const { parent, key } = fact.location;
          emit(
            fact.node,
            fact.at,
            fact.present,
            fact.value,
            Object.hasOwn(parent, key),
            (parent as Record<string | number, unknown>)[key]
          );
        } else {
          const after = valuePresence(this.state, fact.at);
          emit(
            fact.node,
            fact.at,
            fact.present,
            fact.value,
            after.present,
            after.present ? after.value : undefined
          );
        }
      } else if (fact.kind === 'order') {
        const after = orderOf(this.state, fact.at);
        if (!anchor.equal(fact.before, after))
          changes.push({
            kind: 'order',
            at: fact.at,
            before: fact.before,
            after,
          });
      } else {
        const tree = read(this.state.document, fact.at, this.state.schema) as MutableTree;
        const node = nodeAt(this.state.schema, fact.at, this.state.document);
        if (node?.kind !== 'tree') throw new Error('Tree schema disappeared before sealing.');
        const publishNode = (p: Presence): Presence<MutableTreeNode> => {
          if (!p.present) return absent;
          const value = p.value as MutableTreeNode;
          return {
            present: true,
            value: {
              ...value,
              children: [...value.children],
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
              anchor.equal(a.children, b.children) &&
              Object.hasOwn(a, 'value') === Object.hasOwn(b, 'value') &&
              equalValue(node.value, a.value, b.value)
            )
              return [];
          }
          return [{ id, before, after: publishNode(after) }];
        });
        const after = treeRoot(tree);
        if (nodes.length || !samePresence(fact.before, after))
          changes.push({ kind: 'tree', at: fact.at, before: fact.before, after, nodes });
      }
    }
    changes.sort(compareChanges);
    profile.recorder('sealed', changes.length);
    return { changes };
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
