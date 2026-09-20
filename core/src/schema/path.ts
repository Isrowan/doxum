import { checkKey } from './value';
import {
  collectionEntryNode,
  type DocumentAddress,
  type DocumentNode,
  type DocumentTreeNode,
  type FieldNode,
  type Infer,
  type ListNode,
  type MapNode,
  type ObjectNode,
  type ObjectSchema,
  type ObjectShape,
  type ReadonlyValue,
  type RootNodeOf,
  type SchemaNodeOf,
  type TableNode,
  type TreeNode,
  type VariantNode,
  type VariantShape,
} from './model';

export type TreeTarget =
  | { readonly kind: 'root' }
  | { readonly kind: 'nodes' }
  | { readonly kind: 'node'; readonly id: string };
type TreeValueTarget = Exclude<TreeTarget, { readonly kind: 'nodes' }>;
type TreeCollectionTarget = Extract<TreeTarget, { readonly kind: 'nodes' }>;

export type CollectionSelector<TId extends string = string> = {
  readonly kind: 'collection';
  readonly schema: ObjectNode;
  readonly address: DocumentAddress;
  readonly tree?: TreeCollectionTarget;
  readonly __id?: TId;
};
export type ValueSelector<TResult = unknown> = {
  readonly kind: 'value';
  readonly schema: ObjectNode;
  readonly address: DocumentAddress;
  readonly tree?: TreeValueTarget;
  readonly __value?: TResult;
};
export type ImpactTarget<T = unknown> =
  | { readonly kind: 'value'; readonly at: DocumentAddress; readonly tree?: TreeValueTarget }
  | ValueSelector<T>
  | {
      readonly kind: 'collection';
      readonly at: DocumentAddress;
      readonly id?: string;
    }
  | CollectionSelector<string>;
declare const pathValue: unique symbol;
declare const collectionEntry: unique symbol;
declare const collectionKey: unique symbol;
type PathMarker<TValue> = { readonly [pathValue]: TValue };
export type PathValueOf<T> = T extends { readonly [pathValue]: infer TValue } ? TValue : never;

type Or<A extends boolean, B extends boolean> = A extends true ? true : B;
type NodeAbsent<N extends DocumentNode, ParentAbsent extends boolean> = Or<
  ParentAbsent,
  N extends { readonly optional: true } ? true : false
>;
type PathResult<N extends DocumentNode, ParentAbsent extends boolean> =
  Infer<N> | (ParentAbsent extends true ? undefined : never);

type SchemaPathFor<
  S extends ObjectShape = ObjectShape,
  TValue = unknown,
  Absent extends boolean = false,
> = {
  readonly [K in keyof S]: PathValue<S[K], Absent>;
} & PathMarker<TValue | (Absent extends true ? undefined : never)>;

export type SchemaPath<S extends ObjectSchema<object> = ObjectSchema<object>> =
  RootNodeOf<S> extends ObjectNode<infer Shape> ? SchemaPathFor<Shape, Infer<S>> : never;
export type PathPick<S extends ObjectSchema<object> = ObjectSchema<object>> = (
  path: SchemaPath<S>
) => PathMarker<unknown>;

type VariantKeys<V extends VariantShape> = {
  [K in keyof V & string]: keyof (V[K] extends ObjectNode<infer S> ? S : {});
}[keyof V & string] &
  string;
type VariantFieldMissing<V extends VariantShape, K extends string> = {
  [P in keyof V & string]: V[P] extends ObjectNode<infer S> ? (K extends keyof S ? never : P) : P;
}[keyof V & string] extends never
  ? false
  : true;
type VariantFieldPath<V extends VariantShape, K extends string, Absent extends boolean> = {
  [P in keyof V & string]: V[P] extends ObjectNode<infer S>
    ? K extends keyof S
      ? PathValue<S[K], Or<Absent, VariantFieldMissing<V, K>>>
      : never
    : never;
}[keyof V & string];
type VariantPath<T extends string, V extends VariantShape, TValue, Absent extends boolean> = {
  readonly [K in VariantKeys<V>]: VariantFieldPath<V, K, Absent>;
} & {
  readonly [K in T]: PathMarker<(keyof V & string) | (Absent extends true ? undefined : never)>;
} & PathMarker<TValue>;
export type CollectionPath<
  K extends string = string,
  TValue = unknown,
  TEntry = unknown,
  TItem = PathMarker<TEntry | undefined>,
> = PathMarker<TValue> & {
  item(id: K): TItem;
  readonly [collectionEntry]: TEntry;
  readonly [collectionKey]: K;
};
type TreeNodesPath<TValue, ValueOptional extends boolean> = CollectionPath<
  string,
  Readonly<Record<string, DocumentTreeNode<TValue, ValueOptional>>>,
  DocumentTreeNode<TValue, ValueOptional>,
  PathMarker<DocumentTreeNode<TValue, ValueOptional> | undefined>
>;
type TreePath<TValue, ValueOptional extends boolean, TValueResult> = PathMarker<TValueResult> & {
  readonly rootId: PathMarker<string | undefined>;
  readonly nodes: TreeNodesPath<TValue, ValueOptional>;
};

type PathValue<N extends DocumentNode, ParentAbsent extends boolean = false> =
  N extends ObjectNode<infer S>
    ? SchemaPathFor<S, PathResult<N, ParentAbsent>, NodeAbsent<N, ParentAbsent>>
    : N extends VariantNode<infer TTag, infer V>
      ? VariantPath<TTag, V, PathResult<N, ParentAbsent>, NodeAbsent<N, ParentAbsent>>
      : N extends TableNode<infer V, infer K>
        ? CollectionPath<K, PathResult<N, ParentAbsent>, Infer<V>, PathValue<V, true>>
        : N extends MapNode<infer V, infer K>
          ? CollectionPath<K, PathResult<N, ParentAbsent>, Infer<V>, PathValue<V, true>>
          : N extends ListNode<infer I>
            ? CollectionPath<
                string,
                PathResult<N, ParentAbsent>,
                ReadonlyValue<I>,
                PathMarker<ReadonlyValue<I> | undefined>
              >
            : N extends TreeNode<infer T, infer O>
              ? TreePath<T, O, PathResult<N, ParentAbsent>>
              : PathMarker<PathResult<N, ParentAbsent>>;
type CollectionInfo<T> = T extends {
  readonly [collectionEntry]: infer TEntry;
  readonly [collectionKey]: infer K extends string;
}
  ? { readonly id: K; readonly entry: TEntry }
  : never;
export type CollectionId<T> =
  CollectionInfo<T> extends { readonly id: infer TId extends string } ? TId : string;
export type CollectionEntry<T> =
  CollectionInfo<T> extends { readonly entry: infer TEntry } ? TEntry : unknown;

const paths = new WeakMap<
  object,
  {
    readonly address: DocumentAddress;
    readonly nodes: readonly DocumentNode[];
    readonly owner: object;
    readonly tree?: TreeTarget;
  }
>();

const pathProxy = (
  nodes: readonly DocumentNode[],
  address: DocumentAddress,
  owner: object,
  treeSelection?: TreeTarget
): object => {
  const proxy = new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        if (typeof property !== 'string') return undefined;
        const trees = nodes.every(node => node.kind === 'tree');
        if (!treeSelection && trees && property === 'rootId')
          return pathProxy(nodes, address, owner, { kind: 'root' });
        if (!treeSelection && trees && property === 'nodes')
          return pathProxy(nodes, address, owner, { kind: 'nodes' });
        if (treeSelection?.kind === 'nodes' && property === 'item')
          return (id: string) => {
            if (typeof id !== 'string') throw new TypeError('Tree node keys must be strings.');
            return pathProxy(nodes, address, owner, { kind: 'node', id });
          };
        if (treeSelection) throw new TypeError(`Invalid tree path segment: ${property}`);
        const collection = nodes.every(node => collectionEntryNode(node) !== undefined);
        if (collection && property === 'item')
          return (id: string) => {
            if (typeof id !== 'string') throw new TypeError('Collection keys must be strings.');
            for (const node of nodes)
              if (node.kind === 'table' || node.kind === 'map') {
                const invalid = checkKey(node.key, id, [...address, id]);
                if (invalid) throw new TypeError(invalid.message);
              }
            return pathProxy(
              nodes.map(node => collectionEntryNode(node)!),
              [...address, id],
              owner
            );
          };
        const children = nodes.flatMap(node => {
          if (node.kind === 'object')
            return Object.hasOwn(node.shape, property) ? [node.shape[property]] : [];
          if (node.kind !== 'variant') return [];
          if (property === node.tag)
            return [Object.freeze({ kind: 'field' as const }) as FieldNode<string>];
          return Object.values(node.variants).flatMap(branch =>
            Object.hasOwn(branch.shape, property) ? [branch.shape[property]] : []
          );
        });
        if (!children.length) throw new TypeError(`Invalid schema path segment: ${property}`);
        return pathProxy(children, [...address, property], owner);
      },
    }
  );
  paths.set(proxy, { nodes, address, owner, ...(treeSelection ? { tree: treeSelection } : {}) });
  return proxy;
};

export const compilePath = <S extends ObjectSchema<object>>(
  owner: RootNodeOf<S>,
  kind: 'collection' | 'value' | 'auto',
  pick: (path: SchemaPath<S>) => unknown
): CollectionSelector | ValueSelector => {
  const scope = {};
  const value = pick(pathProxy([owner], [], scope) as SchemaPath<S>);
  const selected = typeof value === 'object' && value !== null ? paths.get(value) : undefined;
  if (!selected || selected.owner !== scope)
    throw new TypeError('Selector must return a path from its callback.');
  const collection =
    selected.tree?.kind === 'nodes' ||
    selected.nodes.every(node => collectionEntryNode(node) !== undefined);
  if (kind === 'collection' && !collection)
    throw new TypeError('Collection selectors require a map, table, list or tree nodes path.');
  const resolvedKind = kind === 'auto' ? (collection ? 'collection' : 'value') : kind;
  const result = Object.freeze({
    kind: resolvedKind,
    schema: owner,
    address: Object.freeze([...selected.address]),
    ...(selected.tree ? { tree: Object.freeze({ ...selected.tree }) } : {}),
  }) as CollectionSelector | ValueSelector;
  return result;
};
