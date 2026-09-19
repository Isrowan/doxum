import { profile } from '../profile';
import type { DocumentNode, ObjectShape } from '../schema';

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

type DynamicLayout = {
  readonly kind: 'dynamic';
  readonly entry: CollectionMember;
};

export type MemberLayout = FixedLayout | DynamicLayout;

const compiledObjects = new WeakMap<object, FixedLayout>();
const compiledEntries = new WeakMap<DocumentNode, DynamicLayout>();

const objectBranch = (
  node: DocumentNode,
  value: unknown
): Extract<DocumentNode, { readonly kind: 'object' }> | undefined => {
  if (node.kind === 'object') return node;
  if (
    node.kind !== 'variant' ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  )
    return undefined;
  const record = value as Record<string, unknown>;
  const tag = typeof record[node.tag] === 'string' ? record[node.tag] : undefined;
  return node.variants[String(tag ?? Object.keys(node.variants)[0] ?? '')];
};

export const compiledShape = (node: DocumentNode, value: unknown): FixedLayout | undefined => {
  const branch = objectBranch(node, value);
  if (!branch) return undefined;
  const shape: ObjectShape = branch.shape;
  let layout = compiledObjects.get(shape);
  if (!layout) {
    const members = new Map<string, FixedMember>();
    for (const key of Object.keys(shape).sort()) {
      profile.address.schemaStep();
      members.set(key, {
        kind: 'fixed',
        key,
        node: shape[key],
        field: shape[key].kind === 'field',
        slot: members.size,
      });
    }
    layout = { kind: 'fixed', members };
    compiledObjects.set(shape, layout);
  }
  return layout;
};

export const compiledLayout = (node: DocumentNode, value: unknown): MemberLayout | undefined => {
  if (node.kind !== 'map' && node.kind !== 'table' && node.kind !== 'list')
    return compiledShape(node, value);
  let layout = compiledEntries.get(node);
  if (!layout) {
    layout = {
      kind: 'dynamic',
      entry: { kind: 'entry', node: node.value, field: node.value.kind === 'field' },
    };
    compiledEntries.set(node, layout);
  }
  return layout;
};
