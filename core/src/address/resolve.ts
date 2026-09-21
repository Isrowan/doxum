import * as sequence from '@/order/sequence';
import { profile } from '@/profile';
import type { DocumentAddress, DocumentNode } from '@/schema/model';
import { compiledLayout, variantBranch, type MemberLayout } from '@/schema/layout';
import * as tree from '@/tree/topology';
import { isRecord } from '@/value/record';

const step = (
  nodeInput: DocumentNode | undefined,
  value: unknown,
  segment: string
): DocumentNode | undefined => {
  let node = nodeInput;
  if (!node) return undefined;
  if (node.kind === 'variant') {
    const rawTag = isRecord(value) ? value[node.tag] : undefined;
    const tag = typeof rawTag === 'string' ? rawTag : undefined;
    node = variantBranch(node, tag);
  }
  if (!node) return undefined;
  if (node.kind === 'object')
    return Object.hasOwn(node.shape, segment) ? node.shape[segment] : undefined;
  if (node.kind === 'table' || node.kind === 'map') return node.value;
  // List items use stable keys; tree topology remains a structural unit.
  if (node.kind === 'list') return node.value;
  return undefined;
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

const readSegment = (value: unknown, segment: string, node?: DocumentNode): unknown => {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (node?.kind === 'list' && Array.isArray(value))
    return value[sequence.indexedKeys(value, node.keyOf).index(segment)];
  if (node?.kind === 'table' && isRecord(value) && isRecord(value.byId)) {
    return Object.hasOwn(value.byId, segment) ? value.byId[segment] : undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, segment)
    ? (value as Record<string, unknown>)[segment]
    : undefined;
};

type ResolvedAddress = {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string | number;
  readonly node: DocumentNode;
};

/** Immutable location facts, valid only for the resolving session generation. */
export type ResolvedContainer = {
  readonly owner: object;
  readonly generation: number;
  readonly at: DocumentAddress;
  readonly node: Exclude<DocumentNode, { kind: 'tree' }>;
  readonly parent: Record<string, unknown> | unknown[];
  readonly value: unknown;
  readonly layout: MemberLayout;
};
export type ResolvedTreeContainer = {
  readonly owner: object;
  readonly generation: number;
  readonly at: DocumentAddress;
  readonly node: Extract<DocumentNode, { kind: 'tree' }>;
  readonly value: tree.MutableTree;
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
  if (node.kind === 'tree') return undefined;
  const layout = compiledLayout(node, value);
  if (!layout) return undefined;
  return { owner, generation, at, node, parent, value, layout };
};
export const resolveTreeContainer = (
  owner: object,
  generation: number,
  at: DocumentAddress,
  node: DocumentNode | undefined,
  value: unknown
): ResolvedTreeContainer | undefined =>
  node?.kind === 'tree' && tree.is(value) ? { owner, generation, at, node, value } : undefined;
export const memberKey = (
  container: { readonly node: DocumentNode; readonly parent: Record<string, unknown> | unknown[] },
  key: string
): string | number =>
  container.node.kind === 'list'
    ? sequence.indexedKeys(container.parent as unknown[], container.node.keyOf).index(key)
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
      parent: current.byId,
      key: last,
    };
  return {
    node: resolved,
    parent: current,
    key:
      node?.kind === 'list' && Array.isArray(current)
        ? sequence.indexedKeys(current, node.keyOf).index(last)
        : last,
  };
};
