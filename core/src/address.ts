import type { DocumentAddress, DocumentNode, ObjectNode, ObjectShape } from './schema';
import * as anchor from './mutation/anchor';
import { profile } from './profile';

/** The only resolved address representation used inside the runtime. */
export type AddressRef = {
  readonly path: number;
  readonly address: DocumentAddress;
};

type RegistryNode = {
  readonly static: Map<string, RegistryNode>;
  dynamic?: RegistryNode;
  path?: number;
};

type Registry = {
  readonly root: RegistryNode;
  nextPath: number;
};

const registries = new WeakMap<object, Registry>();
const registryNode = (): RegistryNode => ({ static: new Map() });
const registryFor = (schema: ObjectNode): Registry => {
  const cached = registries.get(schema as object);
  if (cached) return cached;
  const registry: Registry = { root: registryNode(), nextPath: 0 };
  registries.set(schema as object, registry);
  return registry;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const variantNode = (
  node: Extract<DocumentNode, { kind: 'variant' }>,
  value: unknown
): DocumentNode | undefined => {
  const tag = isRecord(value) && typeof value[node.tag] === 'string' ? value[node.tag] : undefined;
  return node.variants[String(tag ?? Object.keys(node.variants)[0] ?? '')];
};

const step = (
  nodeInput: DocumentNode | undefined,
  value: unknown,
  segment: string
): DocumentNode | undefined => {
  let node = nodeInput;
  if (!node) return undefined;
  if (node.kind === 'variant') {
    node = variantNode(node, value);
  }
  if (!node) return undefined;
  if (node.kind === 'object')
    return Object.hasOwn(node.shape, segment) ? node.shape[segment] : undefined;
  if (node.kind === 'table' || node.kind === 'map') return node.value;
  // List items use stable keys; tree topology remains a structural unit.
  if (node.kind === 'list') return node.value;
  return undefined;
};

const pathFor = (
  schema: ObjectNode,
  address: DocumentAddress,
  document?: unknown
): number | undefined => {
  const registry = registryFor(schema);
  let trie = registry.root;
  let node: DocumentNode | undefined = schema;
  let value: unknown = document;
  for (const segment of address) {
    profile.address.schemaStep();
    profile.address.documentStep();
    const resolved = step(node, value, segment);
    if (!resolved) return undefined;
    const next =
      node &&
      (node.kind === 'table' || node.kind === 'map' || node.kind === 'list' || node.kind === 'tree')
        ? (trie.dynamic ??= registryNode())
        : (() => {
            const existing = trie.static.get(segment);
            if (existing) return existing;
            const created = registryNode();
            trie.static.set(segment, created);
            return created;
          })();
    trie = next;
    value = readSegment(value, segment, node);
    node = resolved;
  }
  if (trie.path === undefined) trie.path = registry.nextPath++;
  return trie.path;
};

export const resolveAddress = (
  schema: ObjectNode,
  address: DocumentAddress,
  document?: unknown
): AddressRef | undefined => {
  if (!Array.isArray(address)) return undefined;
  for (const segment of address) if (typeof segment !== 'string') return undefined;
  profile.address.arrayCopied();
  const owned = Object.freeze(address.slice()) as DocumentAddress;
  const path = pathFor(schema, owned, document);
  return path === undefined ? undefined : { path, address: owned };
};

export const nodeAt = (
  schema: DocumentNode,
  address: DocumentAddress,
  document?: unknown
): DocumentNode | undefined => {
  let node: DocumentNode | undefined = schema;
  let value = document;
  for (const segment of address) {
    const resolved = step(node, value, segment);
    value = readSegment(value, segment, node);
    node = resolved;
    if (!node) return undefined;
  }
  return node;
};

export const readSegment = (value: unknown, segment: string, node?: DocumentNode): unknown => {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (node?.kind === 'list' && Array.isArray(value))
    return value[anchor.indexedKeys(value, node.keyOf).index(segment)];
  if (node?.kind === 'table' && isRecord(value) && isRecord(value.byId)) {
    return Object.hasOwn(value.byId, segment) ? value.byId[segment] : undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, segment)
    ? (value as Record<string, unknown>)[segment]
    : undefined;
};

export const read = (root: unknown, address: DocumentAddress, schema: DocumentNode): unknown => {
  let value = root;
  let node: DocumentNode | undefined = schema;
  for (const segment of address) {
    const next = step(node, value, segment);
    value = readSegment(value, segment, node);
    node = next;
    if (value === undefined) return undefined;
  }
  return value;
};

export type ResolvedAddress = {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string | number;
  readonly node: DocumentNode;
  readonly parentNode: DocumentNode;
};

type MemberDefinition = {
  readonly node: DocumentNode;
  readonly field: boolean;
};
export type FixedMember = MemberDefinition & {
  readonly kind: 'fixed';
  readonly key: string;
  readonly slot: number;
};
type CollectionMember = MemberDefinition & { readonly kind: 'entry' };
export type CompiledMember = FixedMember | CollectionMember;
export type FixedLayout = {
  readonly kind: 'fixed';
  readonly members: ReadonlyMap<string, FixedMember>;
};
type DynamicLayout = { readonly kind: 'dynamic'; readonly entry: CollectionMember };
export type MemberLayout = FixedLayout | DynamicLayout;
const compiledObjects = new WeakMap<object, FixedLayout>();
const compiledEntries = new WeakMap<DocumentNode, DynamicLayout>();
export const compiledShape = (node: DocumentNode, value: unknown): FixedLayout | undefined => {
  const branch = node.kind === 'variant' ? variantNode(node, value) : node;
  if (branch?.kind !== 'object') return undefined;
  const shape: ObjectShape = branch.shape;
  let layout = compiledObjects.get(shape);
  if (!layout) {
    const compiled = new Map<string, FixedMember>();
    for (const key of Object.keys(shape).sort()) {
      profile.address.schemaStep();
      compiled.set(key, {
        kind: 'fixed',
        key,
        node: shape[key],
        field: shape[key].kind === 'field',
        slot: compiled.size,
      });
    }
    layout = { kind: 'fixed', members: compiled };
    compiledObjects.set(shape, layout);
  }
  return layout;
};

/** Immutable location facts, valid only for the resolving session generation. */
export type ResolvedContainer = {
  readonly owner: object;
  readonly generation: number;
  readonly at: DocumentAddress;
  readonly node: DocumentNode;
  readonly parent: Record<string, unknown> | unknown[];
  readonly value: unknown;
  readonly layout: MemberLayout;
};
export const resolveContainer = (
  owner: object,
  generation: number,
  at: DocumentAddress,
  node: DocumentNode | undefined,
  value: unknown
): ResolvedContainer | undefined => {
  if (!node || (!isRecord(value) && !Array.isArray(value))) return undefined;
  const parent = node.kind === 'table' && isRecord(value) ? value.byId : value;
  if (!isRecord(parent) && !Array.isArray(parent)) return undefined;
  let layout: MemberLayout;
  if (node.kind === 'map' || node.kind === 'table' || node.kind === 'list') {
    let dynamic = compiledEntries.get(node);
    if (!dynamic) {
      dynamic = {
        kind: 'dynamic',
        entry: { kind: 'entry', node: node.value, field: node.value.kind === 'field' },
      };
      compiledEntries.set(node, dynamic);
    }
    layout = dynamic;
  } else {
    const fixed = compiledShape(node, value);
    if (!fixed) return undefined;
    layout = fixed;
  }
  return { owner, generation, at, node, parent, value, layout };
};
export const memberKey = (container: ResolvedContainer, key: string): string | number =>
  container.node.kind === 'list'
    ? anchor.indexedKeys(container.parent as unknown[], container.node.keyOf).index(key)
    : key;

type ResolutionPrefix = {
  segment: string;
  node: DocumentNode;
  value: unknown;
};

/** One recent path per transaction; structural writes invalidate all retained locations. */
export const createAddressResolver = (schema: DocumentNode, root: unknown) => {
  const prefix: ResolutionPrefix[] = [];
  return {
    container: (owner: object, generation: number, at: DocumentAddress) => {
      if (!at.length) return resolveContainer(owner, generation, at, schema, root);
      const location = resolveWithPrefix(schema, root, at, prefix);
      if (!location || !Object.hasOwn(location.parent, location.key)) return undefined;
      return resolveContainer(
        owner,
        generation,
        at,
        location.node,
        (location.parent as Record<string | number, unknown>)[location.key]
      );
    },
    read: (address: DocumentAddress) => resolveValue(schema, root, address, prefix),
    invalidate: () => {
      prefix.length = 0;
    },
  };
};

/** A subtree root is a value, not a fabricated member of an ObjectNode. */
export const resolveValue = (
  schema: DocumentNode,
  root: unknown,
  address: DocumentAddress,
  prefix?: ResolutionPrefix[]
): { node: DocumentNode; value: unknown } | undefined => {
  if (!address.length) return { node: schema, value: root };
  const location = resolveWithPrefix(schema, root, address, prefix);
  return (
    location && {
      node: location.node,
      value: Object.hasOwn(location.parent, location.key)
        ? (location.parent as Record<string | number, unknown>)[location.key]
        : undefined,
    }
  );
};

/** Resolves schema and document location in one address traversal. */
export const resolveLocated = (
  schema: DocumentNode,
  root: unknown,
  address: DocumentAddress
): ResolvedAddress | undefined => resolveWithPrefix(schema, root, address);

const resolveWithPrefix = (
  schema: DocumentNode,
  root: unknown,
  address: DocumentAddress,
  prefix?: ResolutionPrefix[]
): ResolvedAddress | undefined => {
  if (address.length === 0) return undefined;
  let node: DocumentNode | undefined = schema;
  let current: unknown = root;
  let start = 0;
  if (prefix) {
    while (
      start < prefix.length &&
      start < address.length - 1 &&
      prefix[start].segment === address[start]
    )
      start++;
    prefix.length = start;
    if (start) {
      const retained = prefix[start - 1];
      node = retained.node;
      current = retained.value;
    }
  }
  let cacheable = true;
  for (let index = start; index < address.length - 1; index += 1) {
    profile.address.schemaStep();
    profile.address.documentStep();
    const resolved = step(node, current, address[index]);
    if (!resolved) return undefined;
    if (node?.kind !== 'object' && node?.kind !== 'table' && node?.kind !== 'map')
      cacheable = false;
    current = readSegment(current, address[index], node);
    node = resolved;
    if (prefix && cacheable)
      prefix.push({
        segment: address[index],
        node: resolved,
        value: current,
      });
    if (!node) return undefined;
  }
  const last = address[address.length - 1];
  return resolveChild(node, current, last);
};

/** Resolves one member from an already current schema/container pair. */
export const resolveChild = (
  node: DocumentNode | undefined,
  current: unknown,
  last: string
): ResolvedAddress | undefined => {
  profile.address.schemaStep();
  profile.address.documentStep();
  const resolved = step(node, current, last);
  if (!resolved || (!isRecord(current) && !Array.isArray(current))) return undefined;
  if (node?.kind === 'table' && isRecord(current) && isRecord(current.byId))
    return {
      node: resolved,
      parentNode: node!,
      parent: current.byId,
      key: last,
    };
  return {
    node: resolved,
    parentNode: node!,
    parent: current,
    key:
      node?.kind === 'list' && Array.isArray(current)
        ? anchor.indexedKeys(current, node.keyOf).index(last)
        : last,
  };
};

export const contains = (parent: DocumentAddress, child: DocumentAddress): boolean => {
  profile.address.prefixComparison();
  if (parent.length > child.length) return false;
  for (let index = 0; index < parent.length; index += 1) {
    profile.address.segmentCompared();
    if (parent[index] !== child[index]) return false;
  }
  return true;
};

export const overlaps = (a: DocumentAddress, b: DocumentAddress): boolean =>
  contains(a, b) || contains(b, a);

export const debugKey = (address: DocumentAddress): string => {
  let result = '';
  for (let index = 0; index < address.length; index += 1) {
    if (index > 0) result += '/';
    result += address[index].replaceAll('~', '~~').replaceAll('/', '~/');
  }
  return result;
};

export const same = (a: AddressRef, b: AddressRef): boolean => {
  if (a.path !== b.path || a.address.length !== b.address.length) return false;
  for (let index = 0; index < a.address.length; index += 1) {
    profile.address.segmentCompared();
    if (a.address[index] !== b.address[index]) return false;
  }
  return true;
};

export type { DocumentAddress } from './schema';

type AddressIndexNode<T> = {
  readonly children: Map<string, AddressIndexNode<T>>;
  readonly values: Set<T>;
};

/** An index over canonical address segments, shared by impact and subscriptions. */
export class AddressIndex<T> {
  private readonly root: AddressIndexNode<T> = { children: new Map(), values: new Set() };

  add(address: DocumentAddress, value: T, member?: string): void {
    let node = this.root;
    for (let i = 0; i < address.length + (member === undefined ? 0 : 1); i++) {
      const segment = i < address.length ? address[i] : member!;
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map(), values: new Set() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.values.add(value);
  }

  delete(address: DocumentAddress, value: T): void {
    const parents: AddressIndexNode<T>[] = [];
    let node = this.root;
    for (const segment of address) {
      const child = node.children.get(segment);
      if (!child) return;
      parents.push(node);
      node = child;
    }
    node.values.delete(value);
    for (let i = address.length - 1; i >= 0 && !node.values.size && !node.children.size; i--) {
      node = parents[i];
      node.children.delete(address[i]);
    }
  }

  exact(address: DocumentAddress): ReadonlySet<T> | undefined {
    let node = this.root;
    for (const segment of address) {
      const child = node.children.get(segment);
      if (!child) return undefined;
      node = child;
    }
    return node.values;
  }

  hasAncestor(address: DocumentAddress, strict = false): boolean {
    let node = this.root;
    for (let i = 0; i < address.length; i++) {
      if (node.values.size) return true;
      const child = node.children.get(address[i]);
      if (!child) return false;
      node = child;
    }
    return !strict && node.values.size > 0;
  }

  someAncestor(address: DocumentAddress, predicate: (value: T) => boolean): boolean {
    let node = this.root;
    for (let i = 0; ; i++) {
      for (const value of node.values) if (predicate(value)) return true;
      if (i === address.length) return false;
      const child = node.children.get(address[i]);
      if (!child) return false;
      node = child;
    }
  }

  overlaps(address: DocumentAddress): boolean {
    let node = this.root;
    for (const segment of address) {
      if (node.values.size) return true;
      const child = node.children.get(segment);
      if (!child) return false;
      node = child;
    }
    return node.values.size > 0 || node.children.size > 0;
  }

  hasDescendant(address: DocumentAddress): boolean {
    let node = this.root;
    for (const segment of address) {
      const child = node.children.get(segment);
      if (!child) return false;
      node = child;
    }
    return node.values.size > 0 || node.children.size > 0;
  }

  query(
    visit: (value: T) => void,
    relation: 'overlap' | 'ancestors' | 'descendants' = 'overlap'
  ): (address: DocumentAddress, members?: readonly { readonly key: string }[]) => void {
    const visited = new Set<AddressIndexNode<T>>();
    const subtrees = new Set<AddressIndexNode<T>>();
    const values = (node: AddressIndexNode<T>) => {
      if (visited.has(node)) return;
      visited.add(node);
      node.values.forEach(visit);
    };
    const descend = (current: AddressIndexNode<T>): void => {
      if (subtrees.has(current)) return;
      subtrees.add(current);
      values(current);
      current.children.forEach(descend);
    };
    const terminal = (node: AddressIndexNode<T>) =>
      relation === 'ancestors' ? values(node) : descend(node);
    return (address, members) => {
      let node = this.root;
      for (const segment of address) {
        if (subtrees.has(node)) return;
        if (relation !== 'descendants') values(node);
        const child = node.children.get(segment);
        if (!child) return;
        node = child;
      }
      if (!members) terminal(node);
      else {
        if (relation !== 'descendants') values(node);
        for (const member of members) {
          const child = node.children.get(member.key);
          if (child) terminal(child);
        }
      }
    };
  }

  clear(): void {
    this.root.values.clear();
    this.root.children.clear();
  }
}
