import type { Change, ChangeSet, MemberChange } from '../changes';
import type { DocumentAddress, DocumentNode, ObjectNode } from '../schema';
import {
  AddressIndex,
  contains,
  nodeAt,
  read,
  resolveLocated,
  memberKey,
  type ResolvedContainer,
} from '../address';
import * as anchor from './anchor';
import { copyValue, equalValue } from '../schema-value';
import type { MutableTree, MutableTreeNode } from './tree';
import { profile } from '../profile';

export type CanonicalState = { schema: ObjectNode; document: unknown };
type MemberFact = { key: string; node: DocumentNode; present: boolean; value: unknown };
type MemberGroup = {
  kind: 'members';
  at: DocumentAddress;
  container: ResolvedContainer;
  members: Map<string, MemberFact>;
};
type OrderFact = { kind: 'order'; at: DocumentAddress; before: readonly string[] };
type TreeFact = {
  kind: 'tree';
  at: DocumentAddress;
  before: string | null;
  nodes: Map<string, MutableTreeNode | undefined>;
};
type Fact = MemberGroup | OrderFact | TreeFact;
type IndexedFact =
  | OrderFact
  | TreeFact
  | { kind: 'member'; at: DocumentAddress; group: MemberGroup; member: MemberFact };
const isMember = (fact: IndexedFact): boolean => fact.kind === 'member';

const installValue = (
  state: CanonicalState,
  at: DocumentAddress,
  present: boolean,
  value: unknown
): void => {
  if (!at.length) {
    state.document = value;
    return;
  }
  const location = resolveLocated(state.schema, state.document, at);
  if (!location) throw new Error('Cannot restore an unresolved address.');
  installMember(location.parent, location.key, present, value);
};
export const installMember = (
  parent: Record<string, unknown> | unknown[],
  key: string | number,
  present: boolean,
  value: unknown
): void => {
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (present) {
      if (index < 0) parent.push(value);
      else parent[index] = value;
    } else if (index >= 0) parent.splice(index, 1);
  } else if (present) {
    if (Object.hasOwn(parent, key)) parent[key] = value;
    else
      Object.defineProperty(parent, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
  } else delete parent[key];
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
const copyNode = (node: MutableTreeNode): MutableTreeNode => ({
  ...node,
  children: [...node.children],
});
const transition = (
  node: DocumentNode,
  key: string,
  beforePresent: boolean,
  before: unknown,
  afterPresent: boolean,
  after: unknown
): MemberChange | undefined => {
  if (beforePresent === afterPresent && (!beforePresent || Object.is(before, after))) return;
  if (node.kind !== 'field' && beforePresent === afterPresent && equalValue(node, before, after))
    return;
  const value = afterPresent ? (node.kind === 'field' ? after : copyValue(node, after)) : undefined;
  profile.recorder('transitions');
  return !beforePresent
    ? { key, kind: 'added', after: value }
    : !afterPresent
      ? { key, kind: 'removed', before }
      : { key, kind: 'updated', before, after: value };
};
const restore = (fact: IndexedFact, state: CanonicalState, skip = 0): void => {
  const at = skip ? fact.at.slice(skip) : fact.at;
  if (fact.kind === 'member') {
    const member = fact.member;
    installValue(
      state,
      at,
      member.present,
      member.present ? copyValue(member.node, member.value) : undefined
    );
  } else if (fact.kind === 'order') installOrder(state, at, fact.before);
  else {
    const tree = read(state.document, at, state.schema) as MutableTree;
    if (fact.before === null) delete tree.rootId;
    else tree.rootId = fact.before;
    for (const [id, node] of fact.nodes)
      installMember(tree.nodes, id, node !== undefined, node && copyNode(node));
  }
};

/** One first-touch record per owning container, never a per-write operation log. */
export class ChangeRecorder {
  private readonly facts = new Set<Fact>();
  private groups = new WeakMap<object, MemberGroup>();
  private index?: AddressIndex<IndexedFact>;
  private resetBefore?: { value: unknown };
  constructor(private readonly state: CanonicalState) {}
  private indexed(): AddressIndex<IndexedFact> {
    if (!this.index) {
      this.index = new AddressIndex();
      for (const fact of this.facts) {
        if (fact.kind === 'members') {
          for (const member of fact.members.values()) this.indexMember(fact, member);
        } else this.index.add(fact.at, fact);
      }
    }
    return this.index;
  }
  private indexMember(group: MemberGroup, member: MemberFact): void {
    const at = group.at.concat(member.key);
    this.index!.add(at, { kind: 'member', at, group, member });
  }
  private covered(at: DocumentAddress): boolean {
    return this.resetBefore !== undefined || (this.index?.someAncestor(at, isMember) ?? false);
  }
  private absorb(
    at: DocumentAddress,
    node: DocumentNode,
    value: unknown,
    present: boolean
  ): unknown {
    const index = this.indexed();
    const children: IndexedFact[] = [];
    index.query(fact => {
      if (contains(at, fact.at)) children.push(fact);
    })(at);
    if (present) {
      const copy = { schema: node as ObjectNode, document: copyValue(node, value) };
      for (let i = children.length - 1; i >= 0; i--)
        if (children[i].kind !== 'order') restore(children[i], copy, at.length);
      for (const child of children) if (child.kind === 'order') restore(child, copy, at.length);
      value = copy.document;
    }
    for (const child of children) {
      profile.recorder('absorbed');
      index.delete(child.at, child);
      if (child.kind === 'member') {
        child.group.members.delete(child.member.key);
        if (!child.group.members.size) {
          this.groups.delete(child.group.container.parent);
          this.facts.delete(child.group);
        }
      } else this.facts.delete(child);
    }
    return value;
  }
  member(
    container: ResolvedContainer,
    key: string,
    node: DocumentNode,
    physicalKey = memberKey(container, key)
  ): void {
    if (this.resetBefore) return;
    let group = this.groups.get(container.parent);
    if (group?.members.has(key)) return;
    const at = this.index || node.kind !== 'field' ? container.at.concat(key) : undefined;
    if (at && this.covered(at)) return;
    const present = Object.hasOwn(container.parent, physicalKey);
    let value = (container.parent as Record<string | number, unknown>)[physicalKey];
    if (node.kind !== 'field') value = this.absorb(at!, node, value, present);
    if (!group || !this.facts.has(group)) {
      group = { kind: 'members', at: container.at, container, members: new Map() };
      this.groups.set(container.parent, group);
      this.facts.add(group);
      profile.recorder('groups');
    }
    const member: MemberFact = { key, node, present, value };
    group.members.set(key, member);
    profile.recorder('facts');
    if (this.index) this.indexMember(group, member);
  }
  reset(): void {
    if (this.resetBefore) return;
    const value = this.absorb([], this.state.schema, this.state.document, true);
    this.resetBefore = { value };
    this.groups = new WeakMap();
    profile.recorder('facts');
  }
  order(at: DocumentAddress): void {
    if (this.covered(at)) return;
    const index = this.indexed();
    for (const fact of index.exact(at) ?? []) if (fact.kind === 'order') return;
    const fact: OrderFact = { kind: 'order', at, before: orderOf(this.state, at) };
    profile.recorder('orderSnapshots');
    profile.recorder('orderItems', fact.before.length);
    this.facts.add(fact);
    index.add(at, fact);
  }
  tree(at: DocumentAddress, ids: readonly string[]): void {
    if (this.covered(at)) return;
    const index = this.indexed();
    let fact: TreeFact | undefined;
    for (const item of index.exact(at) ?? []) if (item.kind === 'tree') fact = item;
    const tree = read(this.state.document, at, this.state.schema) as MutableTree;
    if (!fact) {
      fact = { kind: 'tree', at, before: tree.rootId ?? null, nodes: new Map() };
      this.facts.add(fact);
      index.add(at, fact);
    }
    for (const id of ids)
      if (!fact.nodes.has(id)) {
        profile.recorder('treeNodes');
        fact.nodes.set(id, Object.hasOwn(tree.nodes, id) ? copyNode(tree.nodes[id]) : undefined);
      }
  }
  rollback(): void {
    if (this.resetBefore) {
      this.state.document = this.resetBefore.value;
      return;
    }
    const facts = [...this.facts];
    for (let i = facts.length - 1; i >= 0; i--) {
      const fact = facts[i];
      if (fact.kind === 'members') {
        for (const member of fact.members.values())
          installMember(
            fact.container.parent,
            memberKey(fact.container, member.key),
            member.present,
            member.present ? copyValue(member.node, member.value) : undefined
          );
      } else if (fact.kind === 'tree') restore(fact, this.state);
    }
    for (const fact of facts) if (fact.kind === 'order') restore(fact, this.state);
  }
  seal(): ChangeSet {
    if (this.resetBefore) {
      if (equalValue(this.state.schema, this.resetBefore.value, this.state.document))
        return { changes: [] };
      profile.recorder('sealed');
      return {
        changes: [
          {
            kind: 'reset',
            before: this.resetBefore.value,
            after: copyValue(this.state.schema, this.state.document),
          },
        ],
      };
    }
    const changes: Change[] = [];
    const publish = (at: DocumentAddress, members: MemberChange[]): void => {
      if (!members.length) return;
      // Most schema groups are already lexical; avoid a sort workspace for each group.
      for (let i = 1; i < members.length; i++)
        if (members[i - 1].key > members[i].key) {
          members.sort((a, b) => lexical(a.key, b.key));
          break;
        }
      changes.push({ kind: 'members', at, members });
    };
    const emit = (
      node: DocumentNode,
      at: DocumentAddress,
      key: string,
      beforePresent: boolean,
      before: unknown,
      afterPresent: boolean,
      after: unknown,
      members: MemberChange[]
    ): void => {
      if (beforePresent === afterPresent && (!beforePresent || Object.is(before, after))) return;
      if (
        node.kind !== 'field' &&
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
              k => typeof k !== 'string' || !Object.hasOwn(shape, k)
            )
          );
          if (
            [...extras].every(
              k =>
                Object.hasOwn(a, k) === Object.hasOwn(b, k) &&
                Object.is(Reflect.get(a, k), Reflect.get(b, k))
            )
          ) {
            const childAt = at.concat(key);
            const childMembers: MemberChange[] = [];
            for (const child of Object.keys(shape))
              emit(
                shape[child],
                childAt,
                child,
                Object.hasOwn(a, child),
                a[child],
                Object.hasOwn(b, child),
                b[child],
                childMembers
              );
            publish(childAt, childMembers);
            return;
          }
        }
        if (node.kind === 'map' || node.kind === 'table') {
          const a = before as Record<string, unknown>,
            b = after as typeof a;
          const left = (node.kind === 'table' ? a.byId : a) as Record<string, unknown>,
            right = (node.kind === 'table' ? b.byId : b) as typeof left;
          const childAt = at.concat(key);
          const childMembers: MemberChange[] = [];
          for (const id of new Set([...Object.keys(left), ...Object.keys(right)]))
            emit(
              node.value,
              childAt,
              id,
              Object.hasOwn(left, id),
              left[id],
              Object.hasOwn(right, id),
              right[id],
              childMembers
            );
          publish(childAt, childMembers);
          if (node.kind === 'table' && !anchor.equal(a.ids as string[], b.ids as string[]))
            changes.push({
              kind: 'order',
              at: childAt,
              before: a.ids as string[],
              after: [...(b.ids as string[])],
            });
          return;
        }
      }
      const member = transition(node, key, beforePresent, before, afterPresent, after);
      if (member) members.push(member);
    };
    for (const fact of this.facts) {
      if (fact.kind === 'members') {
        const members: MemberChange[] = [];
        for (const member of fact.members.values()) {
          const key = memberKey(fact.container, member.key);
          const present = Object.hasOwn(fact.container.parent, key);
          const value = (fact.container.parent as Record<string | number, unknown>)[key];
          if (member.node.kind === 'field') {
            const change = transition(
              member.node,
              member.key,
              member.present,
              member.value,
              present,
              value
            );
            if (change) members.push(change);
          } else
            emit(
              member.node,
              fact.at,
              member.key,
              member.present,
              member.value,
              present,
              value,
              members
            );
        }
        publish(fact.at, members);
      } else if (fact.kind === 'order') {
        const after = orderOf(this.state, fact.at);
        if (!anchor.equal(fact.before, after))
          changes.push({ kind: 'order', at: fact.at, before: fact.before, after });
      } else {
        const tree = read(this.state.document, fact.at, this.state.schema) as MutableTree;
        const node = nodeAt(this.state.schema, fact.at, this.state.document);
        if (node?.kind !== 'tree') throw new Error('Tree schema disappeared before sealing.');
        const nodes: Extract<Change, { kind: 'tree' }>['nodes'][number][] = [];
        for (const [id, before] of fact.nodes) {
          const after = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
          if (!before && !after) continue;
          if (
            before &&
            after &&
            before.parentId === after.parentId &&
            anchor.equal(before.children, after.children) &&
            Object.hasOwn(before, 'value') === Object.hasOwn(after, 'value') &&
            equalValue(node.value, before.value, after.value)
          )
            continue;
          nodes.push(
            !before
              ? { id, kind: 'added', after: copyNode(after!) }
              : !after
                ? { id, kind: 'removed', before }
                : { id, kind: 'updated', before, after: copyNode(after) }
          );
        }
        const after = tree.rootId ?? null;
        if (nodes.length || fact.before !== after)
          changes.push({
            kind: 'tree',
            at: fact.at,
            before: fact.before,
            after,
            nodes: nodes.sort((a, b) => lexical(a.id, b.id)),
          });
      }
    }
    changes.sort(compareChanges);
    profile.recorder('sealed', changes.length);
    return { changes };
  }
}
const lexical = (a: string, b: string): number => (a < b ? -1 : a === b ? 0 : 1);
export const compareChanges = (a: Change, b: Change): number => {
  if (a.kind === 'reset' || b.kind === 'reset')
    return a.kind === b.kind ? 0 : a.kind === 'reset' ? -1 : 1;
  const length = Math.min(a.at.length, b.at.length);
  for (let i = 0; i < length; i++) if (a.at[i] !== b.at[i]) return lexical(a.at[i], b.at[i]);
  return a.at.length - b.at.length || lexical(a.kind, b.kind);
};
