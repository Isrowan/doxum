import type { Validator } from './schema-value';
import { checkKey } from './schema-value';
export type DocumentAddress = readonly string[];

/** Shared payloads are immutable through every alias, including builtin methods. */
export type ReadonlyValue<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<ReadonlyValue<K>, ReadonlyValue<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<ReadonlyValue<V>>
      : T extends Date
        ? Omit<Date, `set${string}`>
        : T extends object
          ? { readonly [K in keyof T]: ReadonlyValue<T[K]> }
          : T;

export type DocumentListConfig<TItem> = {
  readonly keyOf: (item: ReadonlyValue<TItem>) => string;
};
export type DocumentTreeNode<TValue, ValueOptional extends boolean = false> = {
  readonly parentId?: string;
  readonly children: readonly string[];
} & (ValueOptional extends true
  ? { readonly value?: ReadonlyValue<TValue> }
  : { readonly value: ReadonlyValue<TValue> });
export type DocumentTreeValue<TValue, ValueOptional extends boolean = false> = {
  readonly rootId?: string;
  readonly nodes: Readonly<Record<string, DocumentTreeNode<TValue, ValueOptional>>>;
};

type BaseNode<K extends string> = {
  readonly kind: K;
  readonly optional?: boolean;
};
export type FieldNode<T, Optional extends boolean = false> = BaseNode<'field'> & {
  readonly __value?: T;
  readonly validator?: Validator<T>;
} & (Optional extends true ? { readonly optional: true } : { readonly optional?: false });
/** A node with optional presence. The marker replaces, rather than intersects, a field marker. */
export type OptionalNode<TNode extends DocumentNode> =
  TNode extends FieldNode<infer TValue, boolean>
    ? FieldNode<TValue, true>
    : TNode & { readonly optional: true };
export interface ObjectShape {
  readonly [key: string]: DocumentNode;
}
export type ObjectNode<TShape extends ObjectShape = ObjectShape> = BaseNode<'object'> & {
  readonly shape: TShape;
};
export interface VariantShape {
  readonly [key: string]: ObjectNode<ObjectShape>;
}
export type VariantNode<
  TTag extends string,
  TVariants extends VariantShape,
> = BaseNode<'variant'> & {
  readonly tag: TTag;
  readonly variants: TVariants;
};
export type TableNode<
  TValue extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>,
  TKey extends string = string,
> = BaseNode<'table'> & {
  readonly value: TValue;
  readonly key?: Validator<TKey>;
};
export type MapNode<
  TValue extends ValueSchemaNode,
  TKey extends string = string,
> = BaseNode<'map'> & {
  readonly value: TValue;
  readonly key?: Validator<TKey>;
};
export type ListNode<TItem> = BaseNode<'list'> & {
  readonly value: FieldNode<TItem, false>;
  keyOf(item: ReadonlyValue<TItem>): string;
};
export type TreeNode<TValue, ValueOptional extends boolean = false> = BaseNode<'tree'> & {
  readonly value: FieldNode<TValue, ValueOptional>;
};

export type DocumentNode =
  | FieldNode<unknown, false>
  | FieldNode<unknown, true>
  | ObjectNode<ObjectShape>
  | VariantNode<string, VariantShape>
  | TableNode<ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>
  | MapNode<ValueSchemaNode>
  | ListNode<unknown>
  | TreeNode<unknown, false>
  | TreeNode<unknown, true>;

// Flatten only schema-generated objects; user-supplied field values stay opaque.
type SchemaObject<T> = { [K in keyof T]: T[K] } & {};

/** Infer a document or node value, including optional node presence. */
export type Infer<T extends DocumentNode> = T extends { readonly optional: true }
  ? NodeValue<T> | undefined
  : NodeValue<T>;

type NodeValue<N> =
  N extends FieldNode<infer T, infer O>
    ? O extends true
      ? ReadonlyValue<T> | undefined
      : ReadonlyValue<T>
    : N extends ObjectNode<infer S>
      ? ShapeValue<S>
      : N extends VariantNode<infer T, infer V>
        ? {
            [K in keyof V & string]: SchemaObject<{ readonly [P in T]: K } & NodeValue<V[K]>>;
          }[keyof V & string]
        : N extends TableNode<infer V, infer K>
          ? {
              readonly ids: readonly K[];
              readonly byId: Readonly<Record<K, NodeValue<V>>>;
            }
          : N extends MapNode<infer V, infer K>
            ? Readonly<Record<K, NodeValue<V>>>
            : N extends ListNode<infer I>
              ? readonly ReadonlyValue<I>[]
              : N extends TreeNode<infer T, infer O>
                ? DocumentTreeValue<T, O>
                : never;

type OptionalKeys<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends ObjectShape> = Exclude<keyof S, OptionalKeys<S>>;
type ShapeValue<S extends ObjectShape> = SchemaObject<
  { readonly [K in RequiredKeys<S>]: NodeValue<S[K]> } & {
    readonly [K in OptionalKeys<S>]?: NodeValue<S[K]>;
  }
>;

export type EntitySchemaNode = ObjectNode<ObjectShape> | VariantNode<string, VariantShape>;
export type ValueSchemaNode = EntitySchemaNode | FieldNode<unknown, boolean>;
export type DocumentAnchor<K extends string = string> =
  { readonly at: 'start' | 'end' } | { readonly before: K } | { readonly after: K };

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

export type SchemaPath<S extends ObjectShape = ObjectShape> = SchemaPathFor<S, ShapeValue<S>>;
export type PathPick<S extends ObjectNode = ObjectNode> = (
  path: SchemaPath<S['shape']>
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

export const collectionEntryNode = (node: DocumentNode): ValueSchemaNode | undefined =>
  node.kind === 'map' || node.kind === 'table' || node.kind === 'list' ? node.value : undefined;

const node = <T extends DocumentNode>(value: T): T => Object.freeze(value);
export const field = <T>(validator?: Validator<T>): FieldNode<T> =>
  node({ kind: 'field', ...(validator ? { validator } : {}) });
type OptionalLeaf =
  | FieldNode<unknown, boolean>
  | VariantNode<string, VariantShape>
  | MapNode<ValueSchemaNode>
  | ListNode<unknown>
  | TreeNode<unknown, false>
  | TreeNode<unknown, true>;
export const optional = <T extends OptionalLeaf>(value: T): OptionalNode<T> => {
  if (!['field', 'variant', 'map', 'list', 'tree'].includes(value.kind))
    throw new TypeError('Only field, variant, map, list and tree nodes support optional presence.');
  return node({ ...value, optional: true } as OptionalNode<T>);
};
export const object = <S extends ObjectShape>(shape: S): ObjectNode<S> =>
  node({ kind: 'object', shape: Object.freeze({ ...shape }) });
export const variant = <T extends string, V extends VariantShape>(
  tag: T,
  variants: V
): VariantNode<T, V> => node({ kind: 'variant', tag, variants: Object.freeze({ ...variants }) });
export const table = <V extends EntitySchemaNode, K extends string = string>(
  value: V,
  options?: { readonly key: Validator<K> }
): TableNode<V, K> => node({ kind: 'table', value, ...options });
export const map = <V extends ValueSchemaNode, K extends string = string>(
  value: V,
  options?: { readonly key: Validator<K> }
): MapNode<V, K> => node({ kind: 'map', value, ...options });
export const list = <TItem>(
  value: FieldNode<TItem, false>,
  config: DocumentListConfig<TItem>
): ListNode<TItem> => node({ kind: 'list', keyOf: config.keyOf, value });
export const tree = <TValue, ValueOptional extends boolean>(
  value: FieldNode<TValue, ValueOptional>
): TreeNode<TValue, ValueOptional> => Object.freeze({ kind: 'tree' as const, value });

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
          if (property === node.tag) return [field<string>()];
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

export const compilePath = <S extends ObjectShape>(
  owner: ObjectNode<S>,
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
