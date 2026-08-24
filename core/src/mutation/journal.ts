import { locate, read } from '../address';
import type { ResolvedAddress } from '../address';
import type { DocumentAnchor, DocumentOperationUnion } from '../operations';
import type { DocumentAddress, DocumentNode } from '../schema';
import { profile } from '../profile';
import { isRecord, ownPayload, sameStructuralValue } from '../value/ownership';
import * as anchor from './anchor';
import type { MutationCollectionChange } from './contract';
import {
  resolveEntityCollection,
  type EntityCollection,
  type EntityCollectionResolution,
} from './execute-entity';
import * as tree from './tree';

type CollectionContext = NonNullable<ResolvedAddress['collection']>;
type ListNode = Extract<DocumentNode, { readonly kind: 'list' }>;
type EntityNode = Extract<DocumentNode, { readonly kind: 'table' | 'map' }>;

type Presence =
  { readonly status: 'absent' } | { readonly status: 'present'; readonly value: unknown };

type SubjectBase = {
  readonly address: DocumentAddress;
  readonly addressHash: number;
  readonly collection?: CollectionContext;
};

type ValueSubject = SubjectBase & {
  readonly kind: 'value';
  readonly before: Presence;
};

type VariantSubject = SubjectBase & {
  readonly kind: 'variant';
  readonly before: unknown;
};

type DictState =
  | { readonly mode: 'incremental'; readonly entries: Map<string, Presence> }
  | { readonly mode: 'whole'; readonly value: Readonly<Record<string, unknown>> };

type DictSubject = SubjectBase & {
  readonly kind: 'dict';
  state: DictState;
};

type EntityOrderInverse =
  | { readonly kind: 'remove'; readonly ids: readonly string[] }
  | {
      readonly kind: 'restore';
      readonly ids: readonly string[];
      readonly positions: readonly number[];
    }
  | { readonly kind: 'move'; readonly id: string; readonly anchor?: DocumentAnchor };

type EntityOrder =
  | { readonly kind: 'unordered' }
  | { readonly kind: 'stable'; readonly inverses: EntityOrderInverse[] }
  | { readonly kind: 'tracked'; readonly before: readonly string[] };

type EntitySubject = SubjectBase & {
  readonly kind: 'entity';
  readonly node: EntityNode;
  readonly entries: Map<string, Presence>;
  order: EntityOrder;
};

type ListState =
  | {
      readonly mode: 'incremental';
      readonly items: Map<string, Presence>;
      readonly order: readonly string[];
    }
  | { readonly mode: 'whole'; readonly value: readonly unknown[] };

type ListSubject = SubjectBase & {
  readonly kind: 'list';
  readonly node: ListNode;
  state: ListState;
};

type TreeSubject = SubjectBase & {
  readonly kind: 'tree';
  state: tree.TreeChange;
};

type ChangeSubject =
  ValueSubject | VariantSubject | DictSubject | EntitySubject | ListSubject | TreeSubject;

type EntityAnalysis = {
  readonly changed: boolean;
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
  readonly updated: ReadonlySet<string>;
  readonly orderChanged: boolean;
};

type JournalFinish =
  | { readonly status: 'unchanged' }
  | {
      readonly status: 'changed';
      readonly paths: readonly DocumentAddress[];
      readonly collections: readonly MutationCollectionChange[];
    };

type ChangeJournal = {
  readonly record: (
    resolved: ResolvedAddress,
    operation: DocumentOperationUnion,
    inverse: readonly DocumentOperationUnion[]
  ) => void;
  readonly finish: () => JournalFinish;
};

type AddressIndexNode = {
  readonly children: Map<string, AddressIndexNode>;
  subject?: ChangeSubject;
};

const indexNode = (): AddressIndexNode => ({ children: new Map() });
const hasOwn = (value: object, key: string | number): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const sameAddress = (left: DocumentAddress, right: DocumentAddress): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

const sameOrder = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

const replaceArray = <T>(target: T[], value: readonly T[]): void => {
  target.length = value.length;
  for (let index = 0; index < value.length; index += 1) target[index] = value[index];
};

const present = (value: unknown): Presence => ({ status: 'present', value });
const absent: Presence = Object.freeze({ status: 'absent' });
const inverseMismatch = (operation: DocumentOperationUnion): never => {
  throw new Error(`Mutation inverse does not match '${operation.type}'.`);
};

const ownsDescendant = (subject: ChangeSubject, address: DocumentAddress): boolean => {
  if (subject.address.length >= address.length) return false;
  if (subject.kind === 'variant') return true;
  if (subject.kind !== 'entity') return false;
  return subject.entries.has(address[subject.address.length]);
};

const nodeAt = (root: AddressIndexNode, address: DocumentAddress): AddressIndexNode | undefined => {
  let node: AddressIndexNode | undefined = root;
  for (const segment of address) {
    node = node.children.get(segment);
    if (!node) return undefined;
  }
  return node;
};

const indexedSubjects = (root: AddressIndexNode, address: DocumentAddress): ChangeSubject[] => {
  const start = nodeAt(root, address);
  if (!start) return [];
  const subjects: ChangeSubject[] = [];
  const stack = [start];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    if (node.subject) subjects.push(node.subject);
    for (const child of node.children.values()) stack.push(child);
  }
  return subjects;
};

const writePresence = (root: unknown, address: DocumentAddress, before: Presence): void => {
  const target = locate(root, address);
  if (!target) return;
  if (before.status === 'present')
    (target.parent as Record<string | number, unknown>)[target.key] = before.value;
  else if (Array.isArray(target.parent)) target.parent.splice(Number(target.key), 1);
  else delete target.parent[String(target.key)];
};

const writeContainer = (root: unknown, address: DocumentAddress, value: unknown): void => {
  const target = locate(root, address);
  if (!target) return;
  (target.parent as Record<string | number, unknown>)[target.key] = value;
};

const restoreDict = (value: Record<string, unknown>, state: DictState): void => {
  if (state.mode === 'whole') {
    for (const key of Object.keys(value)) delete value[key];
    for (const [key, entry] of Object.entries(state.value)) value[key] = entry;
    return;
  }
  for (const [key, before] of state.entries) {
    if (before.status === 'present') value[key] = before.value;
    else delete value[key];
  }
};

const restoreList = (value: unknown[], subject: ListSubject): void => {
  if (subject.state.mode === 'whole') {
    replaceArray(value, subject.state.value);
    return;
  }
  const entries = new Map<string, unknown>();
  for (const entry of value) entries.set(subject.node.keyOf(entry), entry);
  for (const [key, before] of subject.state.items) {
    if (before.status === 'present') entries.set(key, before.value);
    else entries.delete(key);
  }
  const restored = new Array<unknown>(subject.state.order.length);
  for (let index = 0; index < subject.state.order.length; index += 1)
    restored[index] = entries.get(subject.state.order[index]);
  replaceArray(value, restored);
};

const entityCollection = (subject: EntitySubject, value: unknown): EntityCollectionResolution =>
  resolveEntityCollection(subject.node, value);

const restoreEntity = (value: unknown, subject: EntitySubject): void => {
  const resolution = entityCollection(subject, value);
  if (resolution.status === 'invalid') return;
  const collection = resolution.collection;
  for (const [id, before] of subject.entries) {
    if (before.status === 'present') collection.byId[id] = before.value;
    else delete collection.byId[id];
  }
  if (collection.kind !== 'table') return;
  if (subject.order.kind === 'tracked') {
    replaceArray(collection.ids, subject.order.before);
    return;
  }
  if (subject.order.kind === 'stable') restoreEntityOrder(collection.ids, subject.order.inverses);
};

const restoreRootSubject = (value: unknown, subject: ChangeSubject): unknown => {
  if (subject.kind === 'value')
    return subject.before.status === 'present' ? subject.before.value : undefined;
  if (subject.kind === 'variant') return subject.before;
  if (subject.kind === 'dict') {
    if (isRecord(value)) restoreDict(value, subject.state);
    return value;
  }
  if (subject.kind === 'entity') {
    restoreEntity(value, subject);
    return value;
  }
  if (subject.kind === 'list') {
    if (Array.isArray(value)) restoreList(value, subject);
    return value;
  }
  return tree.restoreChange(value, subject.state);
};

const restoreSubject = (
  value: unknown,
  prefix: DocumentAddress,
  subject: ChangeSubject
): unknown => {
  if (sameAddress(prefix, subject.address)) return restoreRootSubject(value, subject);
  const address = subject.address.slice(prefix.length);
  if (subject.kind === 'value') {
    writePresence(value, address, subject.before);
    return value;
  }
  if (subject.kind === 'variant') {
    writeContainer(value, address, subject.before);
    return value;
  }
  const current = read(value, address);
  if (subject.kind === 'dict') {
    if (isRecord(current)) restoreDict(current, subject.state);
    return value;
  }
  if (subject.kind === 'entity') {
    restoreEntity(current, subject);
    return value;
  }
  if (subject.kind === 'list') {
    if (Array.isArray(current)) restoreList(current, subject);
    return value;
  }
  const restored = tree.restoreChange(current, subject.state);
  if (restored !== current) writeContainer(value, address, restored);
  return value;
};

const valueChanged = (root: unknown, subject: ValueSubject): boolean => {
  const target = locate(root, subject.address);
  const exists = !!target && hasOwn(target.parent, target.key);
  if (subject.before.status === 'absent') return exists;
  return !exists || !Object.is(subject.before.value, target?.value);
};

const dictChanged = (root: unknown, subject: DictSubject): boolean => {
  const value = read(root, subject.address);
  if (!isRecord(value)) return true;
  if (subject.state.mode === 'whole') return !sameStructuralValue(subject.state.value, value);
  for (const [key, before] of subject.state.entries) {
    const exists = hasOwn(value, key);
    if (before.status === 'absent' ? exists : !exists || !Object.is(before.value, value[key]))
      return true;
  }
  return false;
};

const listChanged = (root: unknown, subject: ListSubject): boolean => {
  const value = read(root, subject.address);
  if (!Array.isArray(value)) return true;
  if (subject.state.mode === 'whole') return !sameStructuralValue(subject.state.value, value);
  const positions = new Map<string, number>();
  const order = new Array<string>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const key = subject.node.keyOf(value[index]);
    order[index] = key;
    positions.set(key, index);
  }
  if (!sameOrder(subject.state.order, order)) return true;
  for (const [key, before] of subject.state.items) {
    const position = positions.get(key);
    if (before.status === 'absent') {
      if (position !== undefined) return true;
    } else if (position === undefined || !sameStructuralValue(before.value, value[position]))
      return true;
  }
  return false;
};

const commonOrderChanged = (before: readonly string[], after: readonly string[]): boolean => {
  const finalPositions = new Map<string, number>();
  for (let index = 0; index < after.length; index += 1) finalPositions.set(after[index], index);
  let previous = -1;
  for (const id of before) {
    const position = finalPositions.get(id);
    if (position === undefined) continue;
    if (position < previous) return true;
    previous = position;
  }
  return false;
};

const analyzeEntity = (root: unknown, subject: EntitySubject): EntityAnalysis => {
  const resolution = entityCollection(subject, read(root, subject.address));
  const added = new Set<string>();
  const removed = new Set<string>();
  const updated = new Set<string>();
  if (resolution.status === 'invalid')
    return { changed: true, added, removed, updated, orderChanged: false };
  const collection = resolution.collection;
  for (const [id, before] of subject.entries) {
    const exists = hasOwn(collection.byId, id);
    if (before.status === 'absent') {
      if (exists) added.add(id);
    } else if (!exists) removed.add(id);
    else if (!sameStructuralValue(before.value, collection.byId[id])) updated.add(id);
  }
  const beforeOrder = subject.order.kind === 'tracked' ? subject.order.before : undefined;
  const finalOrder = collection.kind === 'table' ? collection.ids : [];
  const netOrderChanged = beforeOrder !== undefined && !sameOrder(beforeOrder, finalOrder);
  return {
    changed: added.size > 0 || removed.size > 0 || updated.size > 0 || netOrderChanged,
    added,
    removed,
    updated,
    orderChanged: beforeOrder !== undefined && commonOrderChanged(beforeOrder, finalOrder),
  };
};

const subjectChanged = (root: unknown, subject: Exclude<ChangeSubject, EntitySubject>): boolean => {
  if (subject.kind === 'value') return valueChanged(root, subject);
  if (subject.kind === 'variant')
    return !sameStructuralValue(subject.before, read(root, subject.address));
  if (subject.kind === 'dict') return dictChanged(root, subject);
  if (subject.kind === 'list') return listChanged(root, subject);
  return tree.changeChanged(subject.state, read(root, subject.address));
};

const listOrderBefore = (
  value: readonly unknown[],
  node: ListNode,
  inverse: DocumentOperationUnion
): readonly string[] => {
  const order = value.map(node.keyOf);
  if (inverse.type === 'list.remove') return order.filter(key => key !== inverse.key);
  if (inverse.type === 'list.insert') {
    order.splice(anchor.index(order, inverse.anchor), 0, inverse.key);
    return order;
  }
  if (inverse.type === 'list.move') {
    const position = order.indexOf(inverse.key);
    if (position >= 0) order.splice(position, 1);
    order.splice(anchor.index(order, inverse.anchor), 0, inverse.key);
  }
  return order;
};

const recordListPresence = (
  state: Extract<ListState, { readonly mode: 'incremental' }>,
  inverse: DocumentOperationUnion
): void => {
  if (inverse.type === 'list.remove' && !state.items.has(inverse.key))
    state.items.set(inverse.key, absent);
  else if (inverse.type === 'list.insert' && !state.items.has(inverse.key))
    state.items.set(inverse.key, present(inverse.value));
};

const entityOrderInverse = (
  operation: DocumentOperationUnion,
  inverse: DocumentOperationUnion
): EntityOrderInverse => {
  if (inverse.type === 'entity.remove') return { kind: 'remove', ids: inverse.ids };
  if (inverse.type === 'entity.create') {
    if (!inverse.positions || inverse.positions.length !== inverse.entries.length)
      return inverseMismatch(operation);
    return {
      kind: 'restore',
      ids: inverse.entries.map(entry => entry.id),
      positions: inverse.positions,
    };
  }
  if (inverse.type === 'entity.move')
    return {
      kind: 'move',
      id: inverse.id,
      ...(inverse.anchor ? { anchor: inverse.anchor } : {}),
    };
  return inverseMismatch(operation);
};

const removeEntityIds = (order: string[], ids: readonly string[]): void => {
  const removed = new Set(ids);
  let writeIndex = 0;
  for (const id of order) if (!removed.has(id)) order[writeIndex++] = id;
  order.length = writeIndex;
};

const restoreEntityOrder = (order: string[], inverses: readonly EntityOrderInverse[]): void => {
  for (let index = inverses.length - 1; index >= 0; index -= 1) {
    const inverse = inverses[index];
    if (inverse.kind === 'remove') {
      removeEntityIds(order, inverse.ids);
      continue;
    }
    if (inverse.kind === 'restore') {
      anchor.restore(order, inverse.ids, inverse.positions);
      continue;
    }
    const position = order.indexOf(inverse.id);
    if (position < 0 || !anchor.valid(order, inverse.anchor))
      throw new Error(`Entity order inverse cannot restore '${inverse.id}'.`);
    const nextIndex = anchor.afterRemove(order, position, inverse.anchor);
    order.splice(position, 1);
    order.splice(nextIndex, 0, inverse.id);
  }
};

const treeOperation = (
  operation: DocumentOperationUnion
): operation is Extract<
  DocumentOperationUnion,
  {
    readonly type: 'tree.insert' | 'tree.move' | 'tree.remove' | 'tree.set' | 'tree.replace';
  }
> => operation.type.startsWith('tree.');

export const createChangeJournal = (root: unknown): ChangeJournal => {
  const active = new Set<ChangeSubject>();
  const index = indexNode();
  const buckets = new Map<number, ChangeSubject[]>();

  const add = <TSubject extends ChangeSubject>(subject: TSubject): TSubject => {
    active.add(subject);
    const candidates = buckets.get(subject.addressHash);
    if (candidates) candidates.push(subject);
    else buckets.set(subject.addressHash, [subject]);
    let node = index;
    for (const segment of subject.address) {
      const existing = node.children.get(segment);
      if (existing) node = existing;
      else {
        const created = indexNode();
        node.children.set(segment, created);
        node = created;
      }
    }
    if (node.subject)
      throw new Error(`Change journal already owns '${subject.address.join('.')}'.`);
    node.subject = subject;
    profile.journal.subject();
    return subject;
  };

  const remove = (subject: ChangeSubject): void => {
    if (!active.delete(subject)) return;
    const candidates = buckets.get(subject.addressHash);
    if (candidates) {
      const position = candidates.indexOf(subject);
      if (position >= 0) candidates.splice(position, 1);
      if (candidates.length === 0) buckets.delete(subject.addressHash);
    }
    const nodes: AddressIndexNode[] = [index];
    let node = index;
    for (const segment of subject.address) {
      const child = node.children.get(segment);
      if (!child) return;
      nodes.push(child);
      node = child;
    }
    if (node.subject === subject) delete node.subject;
    for (let position = subject.address.length - 1; position >= 0; position -= 1) {
      const child = nodes[position + 1];
      if (child.subject || child.children.size > 0) break;
      nodes[position].children.delete(subject.address[position]);
    }
  };

  function find(
    kind: 'value',
    address: DocumentAddress,
    addressHash: number
  ): ValueSubject | undefined;
  function find(
    kind: 'variant',
    address: DocumentAddress,
    addressHash: number
  ): VariantSubject | undefined;
  function find(
    kind: 'dict',
    address: DocumentAddress,
    addressHash: number
  ): DictSubject | undefined;
  function find(
    kind: 'entity',
    address: DocumentAddress,
    addressHash: number
  ): EntitySubject | undefined;
  function find(
    kind: 'list',
    address: DocumentAddress,
    addressHash: number
  ): ListSubject | undefined;
  function find(
    kind: 'tree',
    address: DocumentAddress,
    addressHash: number
  ): TreeSubject | undefined;
  function find(
    kind: ChangeSubject['kind'],
    address: DocumentAddress,
    addressHash: number
  ): ChangeSubject | undefined {
    const candidates = buckets.get(addressHash) ?? [];
    for (const subject of candidates) {
      profile.journal.comparison();
      if (subject.kind === kind && sameAddress(subject.address, address)) return subject;
    }
    return undefined;
  }

  const ownerOf = (address: DocumentAddress): ChangeSubject | undefined => {
    let node = index;
    for (let position = 0; position < address.length; position += 1) {
      if (node.subject && ownsDescendant(node.subject, address)) return node.subject;
      const child = node.children.get(address[position]);
      if (!child) return undefined;
      node = child;
    }
    return undefined;
  };

  const absorb = (value: unknown, address: DocumentAddress): unknown => {
    const subjects = indexedSubjects(index, address);
    if (subjects.length === 0) return value;
    subjects.sort((left, right) => left.address.length - right.address.length);
    let before = ownPayload(value, 'journal');
    for (const subject of subjects) before = restoreSubject(before, address, subject);
    for (const subject of subjects) {
      remove(subject);
      profile.journal.absorbed();
    }
    return before;
  };

  const base = (resolved: ResolvedAddress, operation: DocumentOperationUnion): SubjectBase => ({
    address: operation.at,
    addressHash: resolved.addressHash,
    ...(resolved.collection ? { collection: resolved.collection } : {}),
  });

  const recordValue = (
    resolved: ResolvedAddress,
    operation: Extract<DocumentOperationUnion, { readonly type: 'field.set' | 'field.clear' }>,
    inverse: readonly DocumentOperationUnion[]
  ): void => {
    if (find('value', operation.at, resolved.addressHash)) return;
    const first = inverse[0];
    if (first?.type !== 'field.set' && first?.type !== 'field.clear')
      return inverseMismatch(operation);
    add<ValueSubject>({
      ...base(resolved, operation),
      kind: 'value',
      before: first.type === 'field.set' ? present(first.value) : absent,
    });
  };

  const recordVariant = (
    resolved: ResolvedAddress,
    operation: Extract<DocumentOperationUnion, { readonly type: 'variant.replace' }>,
    inverse: readonly DocumentOperationUnion[]
  ): void => {
    if (find('variant', operation.at, resolved.addressHash)) return;
    const first = inverse[0];
    if (first?.type !== 'variant.replace') return inverseMismatch(operation);
    add<VariantSubject>({
      ...base(resolved, operation),
      kind: 'variant',
      before: absorb(first.value, operation.at),
    });
  };

  const recordDict = (
    resolved: ResolvedAddress,
    operation: Extract<
      DocumentOperationUnion,
      { readonly type: 'dict.set' | 'dict.delete' | 'dict.replace' }
    >,
    inverse: readonly DocumentOperationUnion[]
  ): void => {
    const first = inverse[0];
    if (!first) return inverseMismatch(operation);
    const subject =
      find('dict', operation.at, resolved.addressHash) ??
      add<DictSubject>({
        ...base(resolved, operation),
        kind: 'dict',
        state: { mode: 'incremental', entries: new Map() },
      });
    if (subject.state.mode === 'whole') return;
    if (first.type === 'dict.replace') {
      const value = ownPayload(first.value, 'journal');
      restoreDict(value, subject.state);
      subject.state = { mode: 'whole', value };
      return;
    }
    if (first.type !== 'dict.set' && first.type !== 'dict.delete')
      return inverseMismatch(operation);
    if (!subject.state.entries.has(first.key))
      subject.state.entries.set(
        first.key,
        first.type === 'dict.set' ? present(first.value) : absent
      );
  };

  const recordList = (
    resolved: ResolvedAddress,
    operation: Extract<
      DocumentOperationUnion,
      { readonly type: 'list.insert' | 'list.move' | 'list.remove' | 'list.replace' }
    >,
    inverse: readonly DocumentOperationUnion[]
  ): void => {
    if (resolved.node.kind !== 'list') return inverseMismatch(operation);
    const first = inverse[0];
    if (!first) return inverseMismatch(operation);
    let subject = find('list', operation.at, resolved.addressHash);
    if (!subject) {
      if (first.type === 'list.replace') {
        add<ListSubject>({
          ...base(resolved, operation),
          kind: 'list',
          node: resolved.node,
          state: { mode: 'whole', value: first.value },
        });
        return;
      }
      const value = read(root, operation.at);
      if (!Array.isArray(value)) return inverseMismatch(operation);
      subject = add<ListSubject>({
        ...base(resolved, operation),
        kind: 'list',
        node: resolved.node,
        state: {
          mode: 'incremental',
          items: new Map(),
          order: listOrderBefore(value, resolved.node, first),
        },
      });
    }
    if (subject.state.mode === 'whole') return;
    if (first.type === 'list.replace') {
      const value = Array.from(ownPayload(first.value, 'journal'));
      restoreList(value, subject);
      subject.state = { mode: 'whole', value };
      return;
    }
    if (first.type !== 'list.insert' && first.type !== 'list.move' && first.type !== 'list.remove')
      return inverseMismatch(operation);
    recordListPresence(subject.state, first);
  };

  const trackEntityOrder = (
    subject: EntitySubject,
    collection: Extract<EntityCollection, { readonly kind: 'table' }>
  ): void => {
    if (subject.order.kind !== 'stable') return;
    profile.journal.orderSnapshot(collection.ids.length);
    const before = [...collection.ids];
    restoreEntityOrder(before, subject.order.inverses);
    subject.order = { kind: 'tracked', before };
  };

  const recordEntity = (
    resolved: ResolvedAddress,
    operation: Extract<
      DocumentOperationUnion,
      { readonly type: 'entity.create' | 'entity.remove' | 'entity.move' }
    >,
    inverse: readonly DocumentOperationUnion[]
  ): void => {
    if (resolved.node.kind !== 'table' && resolved.node.kind !== 'map')
      return inverseMismatch(operation);
    const resolution = resolveEntityCollection(resolved.node, read(root, operation.at));
    if (resolution.status === 'invalid') return inverseMismatch(operation);
    const collection = resolution.collection;
    const subject =
      find('entity', operation.at, resolved.addressHash) ??
      add<EntitySubject>({
        ...base(resolved, operation),
        kind: 'entity',
        node: resolved.node,
        entries: new Map(),
        order:
          collection.kind === 'table' ? { kind: 'stable', inverses: [] } : { kind: 'unordered' },
      });
    const first = inverse[0];
    if (!first) return inverseMismatch(operation);

    if (collection.kind === 'table' && subject.order.kind === 'stable')
      subject.order.inverses.push(entityOrderInverse(operation, first));

    if (first.type === 'entity.remove') {
      for (const id of first.ids) if (!subject.entries.has(id)) subject.entries.set(id, absent);
      if (
        collection.kind === 'table' &&
        first.ids.some(id => subject.entries.get(id)?.status === 'present')
      )
        trackEntityOrder(subject, collection);
      return;
    }

    if (first.type === 'entity.create') {
      for (const entry of first.entries) {
        if (subject.entries.has(entry.id)) continue;
        const address = [...operation.at, entry.id];
        subject.entries.set(entry.id, present(absorb(entry.value, address)));
      }
      return;
    }

    if (first.type === 'entity.move') {
      if (collection.kind === 'table' && subject.entries.get(first.id)?.status !== 'absent')
        trackEntityOrder(subject, collection);
      return;
    }
    return inverseMismatch(operation);
  };

  const recordTree = (
    resolved: ResolvedAddress,
    operation: Extract<
      DocumentOperationUnion,
      {
        readonly type: 'tree.insert' | 'tree.move' | 'tree.remove' | 'tree.set' | 'tree.replace';
      }
    >,
    inverse: readonly DocumentOperationUnion[]
  ): void => {
    const current = read(root, operation.at);
    if (!tree.is(current)) return inverseMismatch(operation);
    const inverses = inverse.filter(treeOperation);
    if (inverses.length === 0 || inverses.length !== inverse.length)
      return inverseMismatch(operation);
    const subject = find('tree', operation.at, resolved.addressHash);
    const state = tree.recordChange(subject?.state, current, operation, inverses);
    if (subject) subject.state = state;
    else add<TreeSubject>({ ...base(resolved, operation), kind: 'tree', state });
  };

  return {
    record: (resolved, operation, inverse) => {
      profile.batch.journalRecord();
      if (ownerOf(operation.at)) return;
      if (operation.type === 'field.set' || operation.type === 'field.clear') {
        recordValue(resolved, operation, inverse);
        return;
      }
      if (operation.type === 'variant.replace') {
        recordVariant(resolved, operation, inverse);
        return;
      }
      if (
        operation.type === 'dict.set' ||
        operation.type === 'dict.delete' ||
        operation.type === 'dict.replace'
      ) {
        recordDict(resolved, operation, inverse);
        return;
      }
      if (
        operation.type === 'entity.create' ||
        operation.type === 'entity.remove' ||
        operation.type === 'entity.move'
      ) {
        recordEntity(resolved, operation, inverse);
        return;
      }
      if (
        operation.type === 'list.insert' ||
        operation.type === 'list.move' ||
        operation.type === 'list.remove' ||
        operation.type === 'list.replace'
      ) {
        recordList(resolved, operation, inverse);
        return;
      }
      recordTree(resolved, operation, inverse);
    },
    finish: () => {
      const changed: ChangeSubject[] = [];
      const entityChanges = new Map<EntitySubject, EntityAnalysis>();
      for (const subject of active) {
        profile.journal.comparison();
        if (subject.kind === 'entity') {
          const analysis = analyzeEntity(root, subject);
          if (!analysis.changed) continue;
          entityChanges.set(subject, analysis);
          changed.push(subject);
        } else if (subjectChanged(root, subject)) changed.push(subject);
      }
      if (changed.length === 0) return { status: 'unchanged' };

      const collections: Array<{
        address: DocumentAddress;
        added: Set<string>;
        removed: Set<string>;
        updated: Set<string>;
        orderChanged: boolean;
      }> = [];
      const collectionBuckets = new Map<number, (typeof collections)[number][]>();
      const changeAt = (address: DocumentAddress, addressHash: number) => {
        const candidates = collectionBuckets.get(addressHash) ?? [];
        collectionBuckets.set(addressHash, candidates);
        let change = candidates.find(entry => sameAddress(entry.address, address));
        if (!change) {
          change = {
            address,
            added: new Set(),
            removed: new Set(),
            updated: new Set(),
            orderChanged: false,
          };
          candidates.push(change);
          collections.push(change);
        }
        return change;
      };

      for (const subject of changed) {
        if (subject.kind === 'entity') {
          const analysis = entityChanges.get(subject);
          if (analysis) {
            const change = changeAt(subject.address, subject.addressHash);
            analysis.added.forEach(id => change.added.add(id));
            analysis.removed.forEach(id => change.removed.add(id));
            analysis.updated.forEach(id => change.updated.add(id));
            if (analysis.orderChanged) change.orderChanged = true;
          }
        }
        for (let collection = subject.collection; collection; collection = collection.parent)
          changeAt(collection.address, collection.addressHash).updated.add(collection.id);
      }
      for (const change of collections) {
        change.added.forEach(id => change.updated.delete(id));
        change.removed.forEach(id => change.updated.delete(id));
      }

      return {
        status: 'changed',
        paths: Object.freeze(changed.map(subject => subject.address)),
        collections,
      };
    },
  };
};
