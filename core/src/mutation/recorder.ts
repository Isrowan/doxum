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
  type CompiledMember,
  compiledShape,
  type FixedLayout,
} from '../address';
import * as anchor from './anchor';
import { copyValue, equalValue } from '../schema-value';
import type { MutableTree, MutableTreeNode } from './tree';
import { profile } from '../profile';
import { sealChanges } from './changes';

export type CanonicalState = { schema: ObjectNode; document: unknown };
type MemberFact = { key: string; node: DocumentNode; present: boolean; value: unknown };
type MemberGroup = {
  kind: 'members';
  at: DocumentAddress;
  container: ResolvedContainer;
} & (
  | { layout: 'fixed'; definitions: FixedLayout['members']; members: (MemberFact | undefined)[] }
  | { layout: 'dynamic'; members: Map<string, MemberFact> }
);
type OrderFact = { kind: 'order'; at: DocumentAddress; before: readonly string[] };
type TreeFact = {
  kind: 'tree';
  at: DocumentAddress;
  before: string | null;
  nodes: Map<string, MutableTreeNode | undefined>;
};
type Fact = MemberGroup | OrderFact | TreeFact;
type RestoreFact =
  | OrderFact
  | TreeFact
  | { kind: 'member'; at: DocumentAddress; group: MemberGroup; member: MemberFact };
const firstMember = (group: MemberGroup, key: string): MemberFact | undefined => {
  if (group.layout === 'dynamic') return group.members.get(key);
  const member = group.definitions.get(key);
  return member && group.members[member.slot];
};

const forgetMember = (group: MemberGroup, key: string): void => {
  if (group.layout === 'dynamic') group.members.delete(key);
  else {
    const definition = group.definitions.get(key);
    if (definition) group.members[definition.slot] = undefined;
  }
};
const emptyGroup = (group: MemberGroup): boolean =>
  group.layout === 'fixed' ? !group.members.some(Boolean) : group.members.size === 0;

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
      if (index < 0) {
        anchor.insert(parent, parent.length, value);
      } else parent[index] = value;
    } else if (index >= 0) {
      anchor.remove(parent, index);
    }
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
    anchor.install(value as unknown[], node.keyOf, order);
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

const publishMembers = (changes: Change[], at: DocumentAddress, members: MemberChange[]): void => {
  if (!members.length) return;
  for (let i = 1; i < members.length; i++)
    if (members[i - 1].key > members[i].key) {
      members.sort((a, b) => lexical(a.key, b.key));
      break;
    }
  changes.push({ kind: 'members', at, members });
};

/** Diff only the captured subtree; this algorithm has no recorder or session state. */
const diffMember = (
  changes: Change[],
  members: MemberChange[],
  node: DocumentNode,
  at: DocumentAddress,
  key: string,
  beforePresent: boolean,
  before: unknown,
  afterPresent: boolean,
  after: unknown
): void => {
  if (beforePresent === afterPresent && (!beforePresent || Object.is(before, after))) return;
  if (beforePresent && afterPresent && before !== undefined && after !== undefined) {
    const sameShape =
      node.kind === 'object' ||
      (node.kind === 'variant' &&
        (before as Record<string, unknown>)[node.tag] ===
          (after as Record<string, unknown>)[node.tag]);
    if (sameShape) {
      const left = before as Record<string, unknown>,
        right = after as typeof left;
      const childAt = at.concat(key);
      const children: MemberChange[] = [];
      for (const [child, definition] of compiledShape(node, before)!.members)
        diffMember(
          changes,
          children,
          definition.node,
          childAt,
          child,
          Object.hasOwn(left, child),
          left[child],
          Object.hasOwn(right, child),
          right[child]
        );
      publishMembers(changes, childAt, children);
      return;
    }
    if (node.kind === 'map' || node.kind === 'table') {
      const a = before as Record<string, unknown>,
        b = after as typeof a;
      const left = (node.kind === 'table' ? a.byId : a) as Record<string, unknown>;
      const right = (node.kind === 'table' ? b.byId : b) as typeof left;
      const childAt = at.concat(key);
      const children: MemberChange[] = [];
      for (const id of Object.keys(left))
        diffMember(
          changes,
          children,
          node.value,
          childAt,
          id,
          true,
          left[id],
          Object.hasOwn(right, id),
          right[id]
        );
      for (const id of Object.keys(right))
        if (!Object.hasOwn(left, id))
          diffMember(changes, children, node.value, childAt, id, false, undefined, true, right[id]);
      publishMembers(changes, childAt, children);
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
const restore = (fact: RestoreFact, state: CanonicalState, skip = 0): void => {
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
  private index?: AddressIndex<Fact>;
  private indexedGroups = false;
  private resetBefore?: { value: unknown };
  constructor(private readonly state: CanonicalState) {}
  private indexGroups(): AddressIndex<Fact> {
    const index = (this.index ??= new AddressIndex());
    if (!this.indexedGroups) {
      this.indexedGroups = true;
      for (const fact of this.facts) {
        if (fact.kind === 'members') {
          index.add(fact.at, fact);
          profile.recorder('indexedGroups');
        }
      }
    }
    return index;
  }
  private covered(at: DocumentAddress): boolean {
    return (
      this.resetBefore !== undefined ||
      (this.indexedGroups &&
        this.index!.someAncestor(
          at,
          fact =>
            fact.kind === 'members' &&
            fact.at.length < at.length &&
            firstMember(fact, at[fact.at.length]) !== undefined
        ))
    );
  }
  private absorb(
    at: DocumentAddress,
    node: DocumentNode,
    value: unknown,
    present: boolean
  ): unknown {
    const index = this.indexGroups();
    const children: RestoreFact[] = [];
    index.query(fact => {
      if (fact.kind === 'members') {
        // An ancestor group can contribute only its one directly addressed member.
        if (fact.at.length < at.length) {
          if (fact.at.length + 1 === at.length) {
            const member = firstMember(fact, at[fact.at.length]);
            if (member) children.push({ kind: 'member', at, group: fact, member });
          }
          return;
        }
        for (const member of fact.members.values()) {
          if (!member) continue;
          const memberAt = fact.at.concat(member.key);
          if (contains(at, memberAt))
            children.push({ kind: 'member', at: memberAt, group: fact, member });
        }
      } else if (contains(at, fact.at)) children.push(fact);
    })(at);
    if (present) {
      const copy = { schema: node as ObjectNode, document: copyValue(node, value) };
      for (let i = children.length - 1; i >= 0; i--)
        if (children[i].kind !== 'order') restore(children[i], copy, at.length);
      for (const child of children) if (child.kind === 'order') restore(child, copy, at.length);
      value = copy.document;
    }
    let changedGroups: Set<MemberGroup> | undefined;
    for (const child of children) {
      profile.recorder('absorbed');
      if (child.kind === 'member') {
        const { group, member } = child;
        forgetMember(group, member.key);
        (changedGroups ??= new Set()).add(group);
      } else {
        index.delete(child.at, child);
        this.facts.delete(child);
      }
    }
    for (const group of changedGroups ?? []) {
      if (emptyGroup(group)) {
        index.delete(group.at, group);
        this.groups.delete(group.container.parent);
        this.facts.delete(group);
      }
    }
    return value;
  }
  member(
    container: ResolvedContainer,
    key: string,
    definition: CompiledMember,
    physicalKey: string | number
  ): void {
    if (this.resetBefore) return;
    const { node } = definition;
    let group = this.groups.get(container.parent);
    if (group?.layout === 'dynamic' && group.members.has(key)) return;
    if (group?.layout === 'fixed' && definition.kind === 'fixed' && group.members[definition.slot])
      return;
    const at = this.indexedGroups || node.kind !== 'field' ? container.at.concat(key) : undefined;
    if (at && this.covered(at)) return;
    const present = Object.hasOwn(container.parent, physicalKey);
    let value = (container.parent as Record<string | number, unknown>)[physicalKey];
    if (node.kind !== 'field') value = this.absorb(at!, node, value, present);
    if (!group || !this.facts.has(group)) {
      group =
        container.layout.kind === 'fixed'
          ? {
              kind: 'members',
              at: container.at,
              container,
              layout: 'fixed',
              definitions: container.layout.members,
              members: new Array<MemberFact | undefined>(container.layout.members.size),
            }
          : {
              kind: 'members',
              at: container.at,
              container,
              layout: 'dynamic',
              members: new Map<string, MemberFact>(),
            };
      this.groups.set(container.parent, group);
      this.facts.add(group);
      profile.recorder('groups');
      if (this.indexedGroups) {
        this.index!.add(group.at, group);
        profile.recorder('indexedGroups');
      }
    }
    const member: MemberFact = { key, node, present, value };
    if (group.layout === 'dynamic') group.members.set(key, member);
    else if (definition.kind === 'fixed') group.members[definition.slot] = member;
    else throw new Error('A fixed member group requires a fixed schema member.');
    profile.recorder('facts');
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
    const index = (this.index ??= new AddressIndex());
    for (const fact of index.exact(at) ?? []) if (fact.kind === 'order') return;
    const fact: OrderFact = { kind: 'order', at, before: orderOf(this.state, at) };
    profile.recorder('orderSnapshots');
    profile.recorder('orderItems', fact.before.length);
    this.facts.add(fact);
    index.add(at, fact);
  }
  tree(at: DocumentAddress, ids: readonly string[]): void {
    if (this.covered(at)) return;
    const index = (this.index ??= new AddressIndex());
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
        for (const member of fact.members.values()) {
          if (!member) continue;
          installMember(
            fact.container.parent,
            memberKey(fact.container, member.key),
            member.present,
            member.present ? copyValue(member.node, member.value) : undefined
          );
        }
      } else if (fact.kind === 'tree') restore(fact, this.state);
    }
    for (const fact of facts) if (fact.kind === 'order') restore(fact, this.state);
  }
  seal(): ChangeSet {
    if (this.resetBefore) {
      if (equalValue(this.state.schema, this.resetBefore.value, this.state.document))
        return sealChanges([]);
      profile.recorder('sealed');
      return sealChanges([
        {
          kind: 'reset',
          before: this.resetBefore.value,
          after: copyValue(this.state.schema, this.state.document),
        },
      ]);
    }
    const changes: Change[] = [];
    for (const fact of this.facts) {
      if (fact.kind === 'members') {
        const members: MemberChange[] = [];
        for (const member of fact.members.values()) {
          if (!member) continue;
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
            diffMember(
              changes,
              members,
              member.node,
              fact.at,
              member.key,
              member.present,
              member.value,
              present,
              value
            );
        }
        publishMembers(changes, fact.at, members);
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
    profile.recorder('sealed', changes.length);
    return sealChanges(changes);
  }
}
const lexical = (a: string, b: string): number => (a < b ? -1 : a === b ? 0 : 1);
