import type { DocumentAddress, DocumentNode, DocumentSchema, ObjectShape } from './schema';
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

const unwrap = (node: DocumentNode | undefined): DocumentNode | undefined => {
  let current = node;
  while (current?.kind === 'single') current = current.value;
  return current;
};

const variantNode = (
  node: Extract<DocumentNode, { kind: 'variant' }>,
  value: unknown
): DocumentNode | undefined => {
  const tag = isRecord(value) && typeof value[node.tag] === 'string' ? value[node.tag] : undefined;
  return node.variants[String(tag ?? Object.keys(node.variants)[0] ?? '')];
};

const schemaRoot = (schema: DocumentSchema): DocumentNode => ({
  kind: 'object',
  shape: schema.shape,
});

type Step = {
  readonly node: DocumentNode | undefined;
  readonly dynamic: boolean;
};

const step = (nodeInput: DocumentNode | undefined, value: unknown, segment: string): Step => {
  let node = unwrap(nodeInput);
  if (!node) return { node: undefined, dynamic: false };
  if (node.kind === 'variant') {
    node = unwrap(variantNode(node, value));
  }
  if (!node) return { node: undefined, dynamic: false };
  if (node.kind === 'object') return { node: node.shape[segment], dynamic: false };
  if (node.kind === 'table' || node.kind === 'map') return { node: node.value, dynamic: true };
  // These nodes use operation-specific keys rather than address segments, but
  // accepting a dynamic step keeps address resolution total for user targets.
  if (
    node.kind === 'record' ||
    node.kind === 'dict' ||
    node.kind === 'list' ||
    node.kind === 'tree'
  )
    return { node, dynamic: true };
  return { node: undefined, dynamic: false };
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
    if (!resolved.node) return undefined;
    const next = resolved.dynamic
      ? (trie.dynamic ??= registryNode())
      : (() => {
          const existing = trie.static.get(segment);
          if (existing) return existing;
          const created = registryNode();
          trie.static.set(segment, created);
          return created;
        })();
    trie = next;
    node = resolved.node;
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
    node = resolved.node;
    value = readSegment(value, segment);
    if (!node) return undefined;
  }
  return unwrap(node);
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
  readonly parent?: ResolvedCollection;
};

export type ResolvedAddress = Located & {
  readonly addressHash: number;
  readonly node: DocumentNode;
  readonly collection?: ResolvedCollection;
};

/** Resolves schema and document location in one address traversal. */
export const resolveLocated = (
  schema: DocumentSchema,
  root: unknown,
  address: DocumentAddress
): ResolvedAddress | undefined => {
  if (address.length === 0) return undefined;
  let node: DocumentNode | undefined = schemaRoot(schema);
  let current: unknown = root;
  let collection: ResolvedCollection | undefined;
  let addressHash = 2_166_136_261;
  for (let index = 0; index < address.length - 1; index += 1) {
    profile.address.schemaStep();
    profile.address.documentStep();
    const resolved = step(node, current, address[index]);
    if (!resolved.node) return undefined;
    if (node?.kind === 'table' || node?.kind === 'map')
      collection = {
        address: address.slice(0, index),
        addressHash,
        id: address[index],
        ...(collection ? { parent: collection } : {}),
      };
    addressHash = appendAddressHash(addressHash, address[index]);
    node = resolved.node;
    current = readSegment(current, address[index]);
    if (!node) return undefined;
  }
  profile.address.schemaStep();
  profile.address.documentStep();
  const last = address[address.length - 1];
  const resolved = step(node, current, last);
  if (!resolved.node || (!isRecord(current) && !Array.isArray(current))) return undefined;
  if (node?.kind === 'table' || node?.kind === 'map')
    collection = {
      address: address.slice(0, -1),
      addressHash,
      id: last,
      ...(collection ? { parent: collection } : {}),
    };
  addressHash = appendAddressHash(addressHash, last);
  if (isRecord(current) && 'byId' in current && isRecord(current.byId) && last in current.byId)
    return {
      addressHash,
      node: resolved.node,
      parent: current.byId,
      key: last,
      value: current.byId[last],
      ...(collection ? { collection } : {}),
    };
  return {
    addressHash,
    node: resolved.node,
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
