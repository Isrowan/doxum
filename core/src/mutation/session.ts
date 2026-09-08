import type { ChangeDirection, ChangeSet, Presence } from '../changes';
import type { DocumentAddress, DocumentAnchor, DocumentNode } from '../schema';
import { createAddressResolver, nodeAt, read } from '../address';
import { checkKey, checkValue, copyValue } from '../schema-value';
import { cloneValue } from '../value/ownership';
import {
  ChangeRecorder,
  installOrder,
  installValue,
  orderOf,
  presence,
  type CanonicalState,
} from './recorder';
import { fail } from './issue';
import * as anchor from './anchor';
import * as tree from './tree';

export class MutationSession {
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
  set(at: DocumentAddress, value: unknown, present = true, replacement = false): void {
    const location = this.resolver.resolve(at);
    const node = at.length ? location?.node : this.state.schema;
    if (!node || (at.length && !location))
      return fail(at, 'invalid-address', 'Address does not exist.');
    const parentNode = location?.parentNode;
    if (parentNode?.kind === 'variant' && parentNode.tag === at[at.length - 1])
      return fail(at, 'invalid-value', 'Variant discriminants are read-only.');
    const entry =
      parentNode?.kind === 'map' || parentNode?.kind === 'table' || parentNode?.kind === 'list';
    if (
      !replacement &&
      !entry &&
      node.kind !== 'field' &&
      node.kind !== 'variant' &&
      !node.optional
    )
      return fail(
        at,
        'invalid-value',
        'Replace fields, variants, or collection entries; edit object members individually.'
      );
    if (!present && !node.optional && !entry)
      return fail(at, 'required-field', 'A required value cannot be removed.');
    if (parentNode?.kind === 'map' || parentNode?.kind === 'table') {
      const issue = checkKey(parentNode.key, at[at.length - 1], at);
      if (issue) return fail(at, 'invalid-key', issue.message);
    }
    const before = location
      ? presence(location.parent, location.key)
      : ({ present: true, value: this.state.document } as const);
    if (present) {
      this.validate(node, value, at);
      if (parentNode?.kind === 'list' && parentNode.keyOf(value) !== at[at.length - 1])
        return fail(at, 'invalid-list-key', 'Replacing an item must retain its addressed key.');
    }
    if (
      before.present === present &&
      (!present || (before.present && Object.is(before.value, value)))
    )
      return;
    this.recorder.value(at, node, location);
    const next: Presence = present
      ? { present: true, value: copyValue(node, value) }
      : { present: false };
    if (node.kind === 'field' && location && !Array.isArray(location.parent)) {
      if (next.present) {
        if (Object.hasOwn(location.parent, location.key))
          location.parent[location.key] = next.value;
        else
          Object.defineProperty(location.parent, location.key, {
            value: next.value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
      } else delete location.parent[location.key];
    } else installValue(this.state, at, next);
    if (node.kind !== 'field' || entry) this.invalidate();
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
    for (const entry of entries) this.set([...at, entry.id], entry.value);
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
    for (const id of removed) this.set([...at, id], undefined, false);
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
    const [item] = items.splice(index, 1);
    items.splice(next, 0, item);
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
    this.recorder.value([...at, id], node.value);
    items.splice(anchor.index(keys, position), 0, value);
    this.invalidate();
  }
  listSet(at: DocumentAddress, id: string, value: unknown): void {
    const { node, value: items } = this.container(at);
    if (node.kind !== 'list') return fail(at, 'invalid-list-key', 'Expected a list.');
    if (anchor.keys(items as unknown[], node.keyOf).index(id) < 0)
      return fail(at, 'missing-list-item', 'List key does not exist.');
    if (node.keyOf(value) !== id)
      return fail(at, 'invalid-list-key', 'Replacing an item must retain its key.');
    this.set([...at, id], value);
  }
  listRemove(at: DocumentAddress, id: string): void {
    const { node, value } = this.container(at);
    if (node.kind !== 'list' || anchor.keys(value as unknown[], node.keyOf).index(id) < 0)
      return fail(at, 'missing-list-item', 'List key does not exist.');
    this.recorder.order(at);
    this.set([...at, id], undefined, false);
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
      const node = nodeAt(this.state.schema, change.at, this.state.document);
      if (change.kind === 'order') {
        if (node?.kind !== 'table' && node?.kind !== 'list')
          return fail(change.at, 'invalid-changes', 'Order requires an ordered container.');
        this.recorder.order(change.at);
      } else if (change.kind === 'tree') {
        const current = read(this.state.document, change.at, this.state.schema);
        if (node?.kind !== 'tree' || !tree.is(current))
          return fail(change.at, 'invalid-tree', 'Tree facts require an existing tree.');
      }
    }
    for (const change of changes.changes) {
      if (change.kind === 'order') continue;
      if (change.kind === 'value') {
        const next = change[side];
        const parentAt = change.at.slice(0, -1),
          parentNode = nodeAt(this.state.schema, parentAt, this.state.document);
        if (parentNode?.kind === 'list' || parentNode?.kind === 'table') {
          this.recorder.order(parentAt);
          containers.set(JSON.stringify(parentAt), parentAt);
        }
        this.set(change.at, next.present ? cloneValue(next.value) : undefined, next.present, true);
      } else {
        this.treeEdit(change.at, (current, capture) => {
          capture(change.nodes.map(n => n.id));
          const root = change[side];
          if (root.present) current.rootId = root.value;
          else delete current.rootId;
          for (const item of change.nodes) {
            const next = item[side];
            if (next.present)
              Object.defineProperty(current.nodes, item.id, {
                value: cloneValue(next.value),
                writable: true,
                enumerable: true,
                configurable: true,
              });
            else delete current.nodes[item.id];
          }
          const node = nodeAt(this.state.schema, change.at, this.state.document)!;
          this.validate(node, current, change.at);
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
        const nextKeys = new Set(next);
        if (keys.length !== next.length || keys.some(id => !nextKeys.has(id)))
          return fail(
            change.at,
            'invalid-changes',
            'Order must contain exactly the resulting keys.'
          );
        installOrder(this.state, change.at, next);
        containers.set(JSON.stringify(change.at), change.at);
      }
    for (const at of containers.values())
      this.validate(
        nodeAt(this.state.schema, at, this.state.document)!,
        read(this.state.document, at, this.state.schema),
        at
      );
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
