import type { ChangeDirection, ChangeSet } from '../changes';
import type { DocumentAddress, DocumentAnchor, DocumentNode } from '../schema';
import {
  createAddressResolver,
  nodeAt,
  read,
  resolveContainer,
  memberKey,
  type CompiledMember,
  type ResolvedContainer,
} from '../address';
import { checkKey, checkValue, copyValue } from '../schema-value';
import {
  ChangeRecorder,
  installOrder,
  installMember,
  orderOf,
  type CanonicalState,
} from './recorder';
import { fail } from './issue';
import * as anchor from './anchor';
import * as tree from './tree';

export class MutationSession {
  readonly identity = {};
  generation = 0;
  readonly recorder: ChangeRecorder;
  private resolver;
  private resolvedRoot: unknown;
  constructor(readonly state: CanonicalState) {
    this.recorder = new ChangeRecorder(state);
    this.resolver = createAddressResolver(state.schema, state.document);
    this.resolvedRoot = state.document;
  }
  private validate(node: DocumentNode, value: unknown, at: DocumentAddress): void {
    const issue = checkValue(node, value, at);
    if (issue)
      fail(
        issue.address,
        issue.code === 'invalid-tree'
          ? 'invalid-tree'
          : issue.code === 'invalid-key'
            ? 'invalid-key'
            : 'invalid-value',
        issue.message
      );
  }
  resolve(at: DocumentAddress): ResolvedContainer {
    const location = at.length ? this.resolver.resolve(at) : undefined;
    const node = at.length ? location?.node : this.state.schema;
    const value = at.length
      ? location && (location.parent as Record<string | number, unknown>)[location.key]
      : this.state.document;
    return (
      resolveContainer(this.identity, this.generation, at, node, value) ??
      fail(at, 'invalid-address', 'Container does not exist.')
    );
  }
  replace(at: DocumentAddress, value: unknown): void {
    if (!at.length) {
      this.validate(this.state.schema, value, at);
      if (Object.is(this.state.document, value)) return;
      this.recorder.reset();
      this.state.document = copyValue(this.state.schema, value);
      this.invalidate();
      return;
    }
    this.writeMember(this.resolve(at.slice(0, -1)), at[at.length - 1], value, 'set');
  }
  assignMember(container: ResolvedContainer, key: string, value: unknown): void {
    container = this.current(container);
    const member = this.definition(container, key);
    if (
      container.layout.kind === 'fixed' &&
      member.node.kind !== 'field' &&
      member.node.kind !== 'variant' &&
      !member.node.optional
    )
      return fail(
        container.at.concat(key),
        'invalid-value',
        'Replace fields, variants, or collection entries; edit object members individually.'
      );
    this.writeLocatedMember(container, key, member, memberKey(container, key), value, 'set');
  }
  removeMember(container: ResolvedContainer, key: string): void {
    this.writeMember(container, key, undefined, 'remove');
  }
  private current(container: ResolvedContainer): ResolvedContainer {
    if (container.owner !== this.identity)
      return fail(
        container.at,
        'invalid-address',
        'Container belongs to another mutation session.'
      );
    return container.generation === this.generation ? container : this.resolve(container.at);
  }
  private definition(container: ResolvedContainer, key: string): CompiledMember {
    const layout = container.layout;
    const member = layout.kind === 'dynamic' ? layout.entry : layout.members.get(key);
    if (!member)
      return fail(container.at.concat(key), 'invalid-address', 'Address does not exist.');
    return member;
  }
  private writeMember(
    container: ResolvedContainer,
    key: string,
    value: unknown,
    operation: 'set' | 'remove'
  ): boolean {
    container = this.current(container);
    const member = this.definition(container, key);
    return this.writeLocatedMember(
      container,
      key,
      member,
      memberKey(container, key),
      value,
      operation
    );
  }
  /** Location and definition are resolved once by the calling operation. */
  private writeLocatedMember(
    container: ResolvedContainer,
    key: string,
    member: CompiledMember,
    physicalKey: string | number,
    value: unknown,
    operation: 'set' | 'remove'
  ): boolean {
    const parentNode = container.node;
    const node = member.node;
    const present = operation === 'set';
    if (parentNode.kind === 'variant' && parentNode.tag === key)
      return fail(
        container.at.concat(key),
        'invalid-value',
        'Variant discriminants are read-only.'
      );
    const entry = container.layout.kind === 'dynamic';
    if (!present && !node.optional && !entry)
      return fail(
        container.at.concat(key),
        'required-field',
        'A required value cannot be removed.'
      );
    const existed = Object.hasOwn(container.parent, physicalKey);
    const previous = (container.parent as Record<string | number, unknown>)[physicalKey];
    if (existed === present && (!present || Object.is(previous, value))) return false;
    if (parentNode.kind === 'map' || parentNode.kind === 'table') {
      const issue = checkKey(parentNode.key, key, []);
      if (issue)
        return fail(container.at.concat(key, ...issue.address), 'invalid-key', issue.message);
    }
    if (present) {
      if (node.kind === 'field') {
        const issue = checkValue(node, value, []);
        if (issue)
          return fail(container.at.concat(key, ...issue.address), 'invalid-value', issue.message);
      } else this.validate(node, value, container.at.concat(key));
      if (parentNode.kind === 'list' && parentNode.keyOf(value) !== key)
        return fail(
          container.at.concat(key),
          'invalid-list-key',
          'Replacing an item must retain its addressed key.'
        );
    }
    const membershipChanged = entry && existed !== present;
    if (membershipChanged && (parentNode.kind === 'list' || parentNode.kind === 'table'))
      this.recorder.order(container.at);
    this.recorder.member(container, key, member, physicalKey);
    const next = present ? (node.kind === 'field' ? value : copyValue(node, value)) : undefined;
    installMember(container.parent, physicalKey, present, next);
    if (node.kind !== 'field' || membershipChanged) this.invalidate();
    return membershipChanged;
  }
  private invalidate(): void {
    this.generation++;
    if (this.resolvedRoot !== this.state.document) {
      this.resolvedRoot = this.state.document;
      this.resolver = createAddressResolver(this.state.schema, this.state.document);
    } else this.resolver.invalidate();
  }
  private container(at: DocumentAddress) {
    const node = nodeAt(this.state.schema, at, this.state.document);
    const value = read(this.state.document, at, this.state.schema);
    if (!node || value === undefined)
      return fail(at, 'invalid-address', 'Container does not exist.');
    return { node, value };
  }
  tableCreate(
    at: DocumentAddress,
    entries: readonly { id: string; value: unknown }[],
    position?: DocumentAnchor
  ): void {
    const { node, value } = this.container(at);
    if (node.kind !== 'table') return fail(at, 'invalid-collection', 'Expected a table.');
    const table = value as { ids: string[]; byId: Record<string, unknown> };
    if (!anchor.valid(table.ids, position))
      return fail(at, 'invalid-anchor', 'Unknown table anchor.');
    const ids = new Set<string>();
    for (const entry of entries) {
      if (Object.hasOwn(table.byId, entry.id) || ids.has(entry.id))
        return fail(at, 'duplicate-entity', 'Table key already exists.');
      ids.add(entry.id);
    }
    if (!entries.length) return;
    this.recorder.order(at);
    const index = anchor.index(table.ids, position);
    for (const entry of entries) this.replace([...at, entry.id], entry.value);
    const length = table.ids.length;
    table.ids.length += entries.length;
    table.ids.copyWithin(index + entries.length, index, length);
    for (let i = 0; i < entries.length; i++) table.ids[index + i] = entries[i].id;
  }
  tableRemove(at: DocumentAddress, ids: readonly string[]): void {
    const { node, value } = this.container(at);
    if (node.kind !== 'table') return fail(at, 'invalid-collection', 'Expected a table.');
    const table = value as { ids: string[]; byId: Record<string, unknown> };
    for (const id of ids)
      if (!Object.hasOwn(table.byId, id))
        return fail(at, 'missing-entity', 'Table key does not exist.');
    if (!ids.length) return;
    this.recorder.order(at);
    const removed = new Set(ids);
    for (const id of removed) this.removeMember(this.resolve(at), id);
    table.ids = table.ids.filter(id => !removed.has(id));
  }
  move(at: DocumentAddress, id: string, position?: DocumentAnchor): void {
    const { node, value } = this.container(at);
    if (node.kind !== 'table' && node.kind !== 'list')
      return fail(at, 'invalid-collection', 'Expected an ordered container.');
    const items = node.kind === 'table' ? (value as { ids: string[] }).ids : (value as unknown[]);
    const keys = node.kind === 'table' ? (items as string[]) : anchor.keys(items, node.keyOf);
    const index =
      node.kind === 'table' ? (items as string[]).indexOf(id) : (keys as anchor.KeyOrder).index(id);
    if (index < 0) return fail(at, 'missing-entity', 'Ordered key does not exist.');
    if (!anchor.valid(keys, position)) return fail(at, 'invalid-anchor', 'Unknown order anchor.');
    const next = anchor.afterRemove(keys, index, position);
    if (next === index) return;
    this.recorder.order(at);
    anchor.move(items, index, next);
    this.invalidate();
  }
  listInsert(at: DocumentAddress, value: unknown, position?: DocumentAnchor): void {
    const { node, value: current } = this.container(at);
    if (node.kind !== 'list') return fail(at, 'invalid-list-key', 'Expected a list.');
    this.validate(node.value, value, at);
    const id = node.keyOf(value);
    if (typeof id !== 'string') return fail(at, 'invalid-list-key', 'List key must be a string.');
    const items = current as unknown[],
      keys = anchor.keys(items, node.keyOf);
    if (keys.index(id) >= 0) return fail(at, 'duplicate-list-item', 'List key already exists.');
    if (!anchor.valid(keys, position)) return fail(at, 'invalid-anchor', 'Unknown list anchor.');
    this.recorder.order(at);
    const container = this.resolve(at);
    this.recorder.member(container, id, this.definition(container, id), -1);
    anchor.insert(items, anchor.index(keys, position), value);
    this.invalidate();
  }
  listSet(at: DocumentAddress, id: string, value: unknown): void {
    const { node, value: items } = this.container(at);
    if (node.kind !== 'list') return fail(at, 'invalid-list-key', 'Expected a list.');
    const index = anchor.indexedKeys(items as unknown[], node.keyOf).index(id);
    if (index < 0) return fail(at, 'missing-list-item', 'List key does not exist.');
    const container = this.resolve(at);
    this.writeLocatedMember(container, id, this.definition(container, id), index, value, 'set');
  }
  listRemove(at: DocumentAddress, id: string): void {
    const { node, value } = this.container(at);
    if (node.kind !== 'list') return fail(at, 'missing-list-item', 'List key does not exist.');
    const index = anchor.keys(value as unknown[], node.keyOf).index(id);
    if (index < 0) return fail(at, 'missing-list-item', 'List key does not exist.');
    this.recorder.order(at);
    const container = this.resolve(at);
    this.writeLocatedMember(
      container,
      id,
      this.definition(container, id),
      index,
      undefined,
      'remove'
    );
  }
  treeEdit(
    at: DocumentAddress,
    run: (value: tree.MutableTree, capture: (ids: readonly string[]) => void) => void
  ): void {
    const { node, value } = this.container(at);
    if (node.kind !== 'tree' || !tree.is(value))
      return fail(at, 'invalid-tree', 'Expected a tree.');
    run(value, ids => this.recorder.tree(at, ids));
    this.invalidate();
  }
  treeSet(at: DocumentAddress, id: string, value: unknown): void {
    const node = nodeAt(this.state.schema, at, this.state.document);
    if (node?.kind !== 'tree') return fail(at, 'invalid-tree', 'Expected a tree.');
    this.validate(node.value, value, [...at, id]);
    this.treeEdit(at, (current, capture) => tree.set(current, id, value, capture, at));
  }
  treeInsert(at: DocumentAddress, id: string, value: unknown, position?: tree.TreePosition): void {
    const node = nodeAt(this.state.schema, at, this.state.document);
    if (node?.kind !== 'tree') return fail(at, 'invalid-tree', 'Expected a tree.');
    this.validate(node.value, value, [...at, id]);
    this.treeEdit(at, (current, capture) => tree.insert(current, id, value, position, capture, at));
  }
  apply(changes: ChangeSet, direction: ChangeDirection): void {
    const side = direction === 'forward' ? 'after' : 'before';
    const containers = new Map<string, DocumentAddress>();
    for (const change of changes.changes) {
      if (change.kind === 'reset' || change.kind === 'members') continue;
      const node = nodeAt(this.state.schema, change.at, this.state.document);
      if (change.kind === 'order') {
        if (node?.kind !== 'table' && node?.kind !== 'list')
          return fail(change.at, 'invalid-changes', 'Order requires an ordered container.');
        this.recorder.order(change.at);
      } else {
        const current = read(this.state.document, change.at, this.state.schema);
        if (node?.kind !== 'tree' || !tree.is(current))
          return fail(change.at, 'invalid-tree', 'Tree facts require an existing tree.');
      }
    }
    for (const change of changes.changes) {
      if (change.kind === 'order') continue;
      if (change.kind === 'reset') {
        this.replace([], change[side]);
      } else if (change.kind === 'members') {
        const container = this.resolve(change.at);
        for (const member of change.members) {
          const present = side === 'after' ? member.kind !== 'removed' : member.kind !== 'added';
          const value =
            side === 'after'
              ? member.kind !== 'removed'
                ? member.after
                : undefined
              : member.kind !== 'added'
                ? member.before
                : undefined;
          const membershipChanged = this.writeMember(
            container,
            member.key,
            value,
            present ? 'set' : 'remove'
          );
          if (membershipChanged && container.node.kind === 'table')
            containers.set(JSON.stringify(change.at), change.at);
        }
      } else {
        this.treeEdit(change.at, (current, capture) => {
          capture(change.nodes.map(n => n.id));
          const root = change[side];
          if (root === null) delete current.rootId;
          else current.rootId = root;
          for (const item of change.nodes) {
            const next =
              side === 'after'
                ? item.kind !== 'removed'
                  ? item.after
                  : undefined
                : item.kind !== 'added'
                  ? item.before
                  : undefined;
            installMember(
              current.nodes,
              item.id,
              next !== undefined,
              next && { ...next, children: [...next.children] }
            );
          }
          this.validate(
            nodeAt(this.state.schema, change.at, this.state.document)!,
            current,
            change.at
          );
        });
      }
    }
    for (const change of changes.changes)
      if (change.kind === 'order') {
        const node = nodeAt(this.state.schema, change.at, this.state.document);
        const current = read(this.state.document, change.at, this.state.schema);
        const keys =
          node?.kind === 'table'
            ? Object.keys((current as { byId: object }).byId)
            : orderOf(this.state, change.at);
        const next = change[side];
        if (!anchor.matches(next, keys))
          return fail(
            change.at,
            'invalid-changes',
            'Order must contain exactly the resulting keys.'
          );
        installOrder(this.state, change.at, next);
        containers.delete(JSON.stringify(change.at));
      }
    for (const at of containers.values()) {
      const table = read(this.state.document, at, this.state.schema) as {
        ids: string[];
        byId: object;
      };
      if (!anchor.matches(table.ids, Object.keys(table.byId)))
        return fail(at, 'invalid-changes', 'Table membership changes require a matching order.');
    }
    this.invalidate();
  }
  finish(): ChangeSet {
    return this.recorder.seal();
  }
  rollback(): void {
    this.recorder.rollback();
    this.invalidate();
  }
}
