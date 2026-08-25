import type { DocumentAddress } from '../schema';
import type { DocumentOperationUnion } from '../operations';

export type CommandFootprintTarget =
  | { readonly kind: 'value'; readonly at: DocumentAddress }
  | { readonly kind: 'dictionary'; readonly at: DocumentAddress }
  | { readonly kind: 'dictionary-key'; readonly at: DocumentAddress; readonly key: string }
  | { readonly kind: 'collection'; readonly at: DocumentAddress }
  | { readonly kind: 'entity'; readonly at: DocumentAddress; readonly id: string }
  | { readonly kind: 'list'; readonly at: DocumentAddress }
  | { readonly kind: 'list-item'; readonly at: DocumentAddress; readonly key: string }
  | { readonly kind: 'tree'; readonly at: DocumentAddress }
  | { readonly kind: 'tree-node'; readonly at: DocumentAddress; readonly id: string };

export type CommandFootprint = readonly CommandFootprintTarget[];

const sameAddress = (left: DocumentAddress, right: DocumentAddress): boolean =>
  left.length === right.length && left.every((segment, index) => segment === right[index]);

const containsAddress = (parent: DocumentAddress, child: DocumentAddress): boolean =>
  parent.length <= child.length && parent.every((segment, index) => segment === child[index]);

const address = (value: unknown): DocumentAddress | undefined =>
  Array.isArray(value) && value.every(segment => typeof segment === 'string')
    ? Object.freeze(value.slice())
    : undefined;

const targetKey = (target: CommandFootprintTarget): string => {
  const at = target.at.join('\u0000');
  if (target.kind === 'dictionary-key' || target.kind === 'list-item')
    return `${target.kind}:${at}:${target.key}`;
  if (target.kind === 'entity' || target.kind === 'tree-node')
    return `${target.kind}:${at}:${target.id}`;
  return `${target.kind}:${at}`;
};

const freezeTarget = (target: CommandFootprintTarget): CommandFootprintTarget =>
  Object.freeze({ ...target, at: Object.freeze(target.at.slice()) }) as CommandFootprintTarget;

const add = (
  targets: Map<string, CommandFootprintTarget>,
  target: CommandFootprintTarget
): void => {
  const stable = freezeTarget(target);
  targets.set(targetKey(stable), stable);
};

export const commandFootprint = (
  operations: readonly DocumentOperationUnion[]
): CommandFootprint => {
  const targets = new Map<string, CommandFootprintTarget>();
  for (const operation of operations) {
    switch (operation.type) {
      case 'field.set':
      case 'field.clear':
      case 'variant.replace':
        add(targets, { kind: 'value', at: operation.at });
        break;
      case 'dict.replace':
        add(targets, { kind: 'dictionary', at: operation.at });
        break;
      case 'dict.set':
      case 'dict.delete':
        add(targets, { kind: 'dictionary-key', at: operation.at, key: operation.key });
        break;
      case 'entity.create':
        add(targets, { kind: 'collection', at: operation.at });
        for (const entry of operation.entries)
          add(targets, { kind: 'entity', at: operation.at, id: entry.id });
        break;
      case 'entity.remove':
        add(targets, { kind: 'collection', at: operation.at });
        for (const id of operation.ids) add(targets, { kind: 'entity', at: operation.at, id });
        break;
      case 'entity.move':
        add(targets, { kind: 'collection', at: operation.at });
        add(targets, { kind: 'entity', at: operation.at, id: operation.id });
        break;
      case 'list.insert':
      case 'list.move':
      case 'list.remove':
        add(targets, { kind: 'list', at: operation.at });
        add(targets, { kind: 'list-item', at: operation.at, key: operation.key });
        break;
      case 'list.replace':
        add(targets, { kind: 'list', at: operation.at });
        for (const key of operation.keys)
          add(targets, { kind: 'list-item', at: operation.at, key });
        break;
      case 'tree.insert':
      case 'tree.move':
      case 'tree.remove':
      case 'tree.set':
        add(targets, { kind: 'tree', at: operation.at });
        add(targets, { kind: 'tree-node', at: operation.at, id: operation.treeNodeId });
        break;
      case 'tree.replace':
        add(targets, { kind: 'tree', at: operation.at });
        break;
    }
  }
  return Object.freeze(Array.from(targets.values()));
};

const overlapsValueAndEntity = (
  value: Extract<CommandFootprintTarget, { readonly kind: 'value' }>,
  entity: Extract<CommandFootprintTarget, { readonly kind: 'entity' }>
): boolean =>
  containsAddress([...entity.at, entity.id], value.at) ||
  containsAddress(value.at, [...entity.at, entity.id]);

const targetsOverlap = (left: CommandFootprintTarget, right: CommandFootprintTarget): boolean => {
  if (left.kind === 'value' && right.kind === 'value')
    return containsAddress(left.at, right.at) || containsAddress(right.at, left.at);
  if (left.kind === 'value' && right.kind === 'entity') return overlapsValueAndEntity(left, right);
  if (left.kind === 'entity' && right.kind === 'value') return overlapsValueAndEntity(right, left);
  if (left.kind === 'dictionary' && right.kind === 'dictionary')
    return sameAddress(left.at, right.at);
  if (left.kind === 'dictionary' && right.kind === 'dictionary-key')
    return sameAddress(left.at, right.at);
  if (left.kind === 'dictionary-key' && right.kind === 'dictionary')
    return sameAddress(left.at, right.at);
  if (left.kind === 'dictionary-key' && right.kind === 'dictionary-key')
    return sameAddress(left.at, right.at) && left.key === right.key;
  if (left.kind === 'collection' && right.kind === 'collection')
    return sameAddress(left.at, right.at);
  if (left.kind === 'collection' && right.kind === 'entity') return sameAddress(left.at, right.at);
  if (left.kind === 'entity' && right.kind === 'collection') return sameAddress(left.at, right.at);
  if (left.kind === 'entity' && right.kind === 'entity')
    return sameAddress(left.at, right.at) && left.id === right.id;
  if (left.kind === 'list' && (right.kind === 'list' || right.kind === 'list-item'))
    return sameAddress(left.at, right.at);
  if (right.kind === 'list' && left.kind === 'list-item') return sameAddress(left.at, right.at);
  if (left.kind === 'list-item' && right.kind === 'list-item')
    return sameAddress(left.at, right.at) && left.key === right.key;
  if (left.kind === 'tree' && (right.kind === 'tree' || right.kind === 'tree-node'))
    return sameAddress(left.at, right.at);
  if (right.kind === 'tree' && left.kind === 'tree-node') return sameAddress(left.at, right.at);
  if (left.kind === 'tree-node' && right.kind === 'tree-node')
    return sameAddress(left.at, right.at) && left.id === right.id;
  return false;
};

export const footprintsOverlap = (left: CommandFootprint, right: CommandFootprint): boolean =>
  left.some(leftTarget => right.some(rightTarget => targetsOverlap(leftTarget, rightTarget)));

const decodedTarget = (value: unknown): CommandFootprintTarget | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const at = address(record.at);
  if (!at || typeof record.kind !== 'string') return undefined;
  switch (record.kind) {
    case 'value':
    case 'dictionary':
    case 'collection':
    case 'list':
    case 'tree':
      return freezeTarget({ kind: record.kind, at });
    case 'dictionary-key':
    case 'list-item':
      return typeof record.key === 'string'
        ? freezeTarget({ kind: record.kind, at, key: record.key })
        : undefined;
    case 'entity':
    case 'tree-node':
      return typeof record.id === 'string'
        ? freezeTarget({ kind: record.kind, at, id: record.id })
        : undefined;
    default:
      return undefined;
  }
};

export const decodeCommandFootprint = (value: unknown): CommandFootprint | undefined => {
  if (!Array.isArray(value)) return undefined;
  const targets = new Map<string, CommandFootprintTarget>();
  for (const entry of value) {
    const target = decodedTarget(entry);
    if (!target) return undefined;
    targets.set(targetKey(target), target);
  }
  return Object.freeze(Array.from(targets.values()));
};
