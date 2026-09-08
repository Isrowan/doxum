import type { DocumentAddress, DocumentNode, DocumentSchema, ObjectShape } from './schema';
import { schemaRoot } from './schema';
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
const registryFor = (schema: DocumentSchema): Registry => {
  const cached = registries.get(schema as object);
  if (cached) return cached;
  const registry: Registry = { root: registryNode(), nextPath: 0 };
  registries.set(schema as object, registry);
  return registry;
};

const hashText = (value: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return hash >>> 0;
};

const appendAddressHash = (hash: number, segment: string): number =>
  hashText(segment, hashText('/', hash));

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
  if (node.kind === 'object') return node.shape[segment];
  if (node.kind === 'table' || node.kind === 'map') return node.value;
  // These nodes use operation-specific keys rather than address segments, but
  // accepting a dynamic step keeps address resolution total for user targets.
  if (node.kind === 'dict' || node.kind === 'list' || node.kind === 'tree') return node;
  return undefined;
};

const pathFor = (
  schema: DocumentSchema,
  address: DocumentAddress,
  document?: unknown
): number | undefined => {
  const registry = registryFor(schema);
  let trie = registry.root;
  let node: DocumentNode | undefined = schemaRoot(schema);
  let value: unknown = document;
  for (const segment of address) {
    profile.address.schemaStep();
    profile.address.documentStep();
    const resolved = step(node, value, segment);
    if (!resolved) return undefined;
    const next =
      node &&
      (node.kind === 'table' ||
        node.kind === 'map' ||
        node.kind === 'dict' ||
        node.kind === 'list' ||
        node.kind === 'tree')
        ? (trie.dynamic ??= registryNode())
        : (() => {
            const existing = trie.static.get(segment);
            if (existing) return existing;
            const created = registryNode();
            trie.static.set(segment, created);
            return created;
          })();
    trie = next;
    node = resolved;
    value = readSegment(value, segment);
  }
  if (trie.path === undefined) trie.path = registry.nextPath++;
  return trie.path;
};

export const resolveAddress = (
  schema: DocumentSchema,
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
  schema: DocumentSchema,
  address: DocumentAddress,
  document?: unknown
): DocumentNode | undefined => {
  let node: DocumentNode | undefined = schemaRoot(schema);
  let value = document;
  for (const segment of address) {
    const resolved = step(node, value, segment);
    node = resolved;
    value = readSegment(value, segment);
    if (!node) return undefined;
  }
  return node;
};

export const readSegment = (value: unknown, segment: string): unknown => {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (isRecord(value) && 'byId' in value && isRecord(value.byId)) {
    const entity = value.byId[segment];
    if (entity !== undefined || Object.prototype.hasOwnProperty.call(value.byId, segment))
      return entity;
  }
  return (value as Record<string, unknown>)[segment];
};

export const read = (root: unknown, address: DocumentAddress): unknown => {
  let value = root;
  for (const segment of address) {
    value = readSegment(value, segment);
    if (value === undefined) return undefined;
  }
  return value;
};

export type Located = {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string | number;
  readonly value: unknown;
};

type ResolvedCollection = {
  readonly address: DocumentAddress;
  readonly addressHash: number;
  readonly id: string;
  readonly node: Extract<DocumentNode, { kind: 'table' | 'map' }>;
  readonly parent?: ResolvedCollection;
};

export type ResolvedAddress = Located & {
  readonly addressHash: number;
  readonly node: DocumentNode;
  readonly collection?: ResolvedCollection;
};

type ResolutionPrefix = {
  segment: string;
  node: DocumentNode;
  value: unknown;
  hash: number;
  collection: ResolvedCollection | undefined;
};

/** One recent path per transaction; structural writes invalidate all retained locations. */
export const createAddressResolver = (schema: DocumentSchema, root: unknown) => {
  const prefix: ResolutionPrefix[] = [];
  return {
    resolve: (address: DocumentAddress) => resolveWithPrefix(schema, root, address, prefix),
    invalidate: () => {
      prefix.length = 0;
    },
  };
};

/** Resolves schema and document location in one address traversal. */
export const resolveLocated = (
  schema: DocumentSchema,
  root: unknown,
  address: DocumentAddress
): ResolvedAddress | undefined => resolveWithPrefix(schema, root, address);

const resolveWithPrefix = (
  schema: DocumentSchema,
  root: unknown,
  address: DocumentAddress,
  prefix?: ResolutionPrefix[]
): ResolvedAddress | undefined => {
  if (address.length === 0) return undefined;
  let node: DocumentNode | undefined = schemaRoot(schema);
  let current: unknown = root;
  let collection: ResolvedCollection | undefined;
  let addressHash = 2_166_136_261;
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
      addressHash = retained.hash;
      collection = retained.collection;
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
    if (node?.kind === 'table' || node?.kind === 'map')
      collection = {
        address: address.slice(0, index),
        addressHash,
        id: address[index],
        node,
        ...(collection ? { parent: collection } : {}),
      };
    addressHash = appendAddressHash(addressHash, address[index]);
    node = resolved;
    current = readSegment(current, address[index]);
    if (prefix && cacheable)
      prefix.push({
        segment: address[index],
        node: resolved,
        value: current,
        hash: addressHash,
        collection,
      });
    if (!node) return undefined;
  }
  profile.address.schemaStep();
  profile.address.documentStep();
  const last = address[address.length - 1];
  const resolved = step(node, current, last);
  if (!resolved || (!isRecord(current) && !Array.isArray(current))) return undefined;
  if (node?.kind === 'table' || node?.kind === 'map')
    collection = {
      address: address.slice(0, -1),
      addressHash,
      id: last,
      node,
      ...(collection ? { parent: collection } : {}),
    };
  addressHash = appendAddressHash(addressHash, last);
  if (isRecord(current) && 'byId' in current && isRecord(current.byId) && last in current.byId)
    return {
      addressHash,
      node: resolved,
      parent: current.byId,
      key: last,
      value: current.byId[last],
      ...(collection ? { collection } : {}),
    };
  return {
    addressHash,
    node: resolved,
    parent: current,
    key: Array.isArray(current) && /^\d+$/.test(last) ? Number(last) : last,
    value: readSegment(current, last),
    ...(collection ? { collection } : {}),
  };
};

export const locate = (root: unknown, address: DocumentAddress): Located | undefined => {
  if (address.length === 0) return undefined;
  let current: unknown = root;
  for (let index = 0; index < address.length - 1; index += 1)
    current = readSegment(current, address[index]);
  if (!isRecord(current) && !Array.isArray(current)) return undefined;
  const last = address[address.length - 1];
  if (isRecord(current) && 'byId' in current && isRecord(current.byId) && last in current.byId)
    return { parent: current.byId, key: last, value: current.byId[last] };
  return {
    parent: current,
    key: Array.isArray(current) && /^\d+$/.test(last) ? Number(last) : last,
    value: readSegment(current, last),
  };
};

export const set = (root: unknown, address: DocumentAddress, value: unknown): boolean => {
  const target = locate(root, address);
  if (!target) return false;
  (target.parent as Record<string | number, unknown>)[target.key] = value;
  return true;
};

export const remove = (root: unknown, address: DocumentAddress): boolean => {
  const target = locate(root, address);
  if (!target || !Object.prototype.hasOwnProperty.call(target.parent, target.key)) return false;
  if (Array.isArray(target.parent)) target.parent.splice(Number(target.key), 1);
  else delete target.parent[String(target.key)];
  return true;
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

  add(address: DocumentAddress, value: T): void {
    let node = this.root;
    for (const segment of address) {
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

  query(visit: (value: T) => void): (address: DocumentAddress) => void {
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
    return address => {
      let node = this.root;
      for (const segment of address) {
        if (subtrees.has(node)) return;
        values(node);
        const child = node.children.get(segment);
        if (!child) return;
        node = child;
      }
      descend(node);
    };
  }

  clear(): void {
    this.root.values.clear();
    this.root.children.clear();
  }
}
