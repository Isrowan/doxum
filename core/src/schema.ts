import type { Validator } from './schema-value';
export type DocumentAddress = readonly string[];

export type DocumentListConfig<TItem> = {
  readonly keyOf: (item: TItem) => string;
};
export type DocumentTreeNode<TValue> = {
  readonly parentId?: string;
  readonly children: readonly string[];
  readonly value?: TValue;
};
export type DocumentTreeValue<TValue> = {
  readonly rootId?: string;
  readonly nodes: Readonly<Record<string, DocumentTreeNode<TValue>>>;
};

type BaseNode<K extends string> = {
  readonly kind: K;
  readonly optional?: boolean;
};
export type FieldNode<T, Optional extends boolean = false> = BaseNode<'field'> & {
  readonly __value?: T;
  readonly validator?: Validator<T>;
  snapshot?(value: T): T;
} & (Optional extends true ? { readonly optional: true } : { readonly optional?: false });
/** A node with optional presence. The marker replaces, rather than intersects, a field marker. */
export type OptionalNode<TNode extends DocumentNode> =
  TNode extends FieldNode<infer TValue, boolean>
    ? FieldNode<TValue, true>
    : TNode & { readonly optional: true };
export interface ObjectShape {
  readonly [key: string]: DocumentNode;
}
export type ObjectNode<TShape extends ObjectShape> = BaseNode<'object'> & {
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
  TValue extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>,
  TKey extends string = string,
> = BaseNode<'map'> & {
  readonly value: TValue;
  readonly key?: Validator<TKey>;
};
export type DictNode<TKey extends string, TValue> = BaseNode<'dict'> & {
  readonly __key?: TKey;
  readonly __value?: TValue;
  readonly key?: Validator<TKey>;
  readonly validator?: Validator<TValue>;
};
export type ListNode<TItem> = BaseNode<'list'> & {
  readonly __item?: TItem;
  keyOf(item: TItem): string;
  readonly validator?: Validator<TItem>;
};
export type TreeNode<TValue> = BaseNode<'tree'> & {
  readonly __value?: TValue;
  readonly validator?: Validator<TValue>;
};

export type DocumentNode =
  | FieldNode<unknown, false>
  | FieldNode<unknown, true>
  | ObjectNode<ObjectShape>
  | VariantNode<string, VariantShape>
  | TableNode<ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>
  | MapNode<ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>
  | DictNode<string, unknown>
  | ListNode<unknown>
  | TreeNode<unknown>;

// Flatten only schema-generated objects; user-supplied field values stay opaque.
type SchemaObject<T> = { [K in keyof T]: T[K] } & {};

/** Infer a document or node value, including optional node presence. */
export type Infer<T extends DocumentNode | DocumentSchema> =
  T extends DocumentSchema<infer S>
    ? ShapeValue<S>
    : T extends { readonly optional: true }
      ? NodeValue<T> | undefined
      : NodeValue<T>;

type NodeValue<N> =
  N extends FieldNode<infer T, infer O>
    ? O extends true
      ? T | undefined
      : T
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
            : N extends DictNode<infer K, infer T>
              ? Readonly<Partial<Record<K, T>>>
              : N extends ListNode<infer I>
                ? readonly I[]
                : N extends TreeNode<infer T>
                  ? DocumentTreeValue<T>
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

export type CollectionSelector<
  TId extends string = string,
  TNode extends EntitySchemaNode = EntitySchemaNode,
> = {
  readonly kind: 'collection';
  readonly schema: DocumentSchema;
  readonly address: DocumentAddress;
  readonly __id?: TId;
  /** Compile-time entry schema carried by schema selectors. */
  readonly __node?: TNode;
};
export type ValueSelector<TResult = unknown> = {
  readonly kind: 'value';
  readonly schema: DocumentSchema;
  readonly address: DocumentAddress;
  readonly __value?: TResult;
};
export type ImpactTarget<T = unknown> =
  | { readonly kind: 'value'; readonly at: DocumentAddress }
  | ValueSelector<T>
  | {
      readonly kind: 'collection';
      readonly at: DocumentAddress;
      readonly id?: string;
    }
  | CollectionSelector<string>;
declare const pathValue: unique symbol;
declare const collectionNode: unique symbol;
declare const collectionKey: unique symbol;
type PathMarker<TValue> = { readonly [pathValue]: TValue };

type SchemaPathFor<S extends ObjectShape = ObjectShape, TValue = unknown> = {
  readonly [K in keyof S]: PathValue<S[K]>;
} & PathMarker<TValue>;

export type DocumentSchema<TShape extends ObjectShape = {}> = {
  readonly kind: 'schema';
  readonly shape: TShape;
  collection<TPath extends CollectionPath>(
    pick: (path: SchemaPath<TShape>) => TPath
  ): CollectionSelector<CollectionId<TPath>, CollectionNode<TPath>>;
  value<TPath extends PathMarker<unknown>>(
    pick: (path: SchemaPath<TShape>) => TPath
  ): ValueSelector<PathValueResult<TPath>>;
};

export type SchemaPath<S extends ObjectShape = {}> = SchemaPathFor<S, ShapeValue<S>>;

type VariantKeys<V extends VariantShape> = {
  [K in keyof V & string]: keyof (V[K] extends ObjectNode<infer S> ? S : {});
}[keyof V & string] &
  string;
type VariantFieldPath<V extends VariantShape, K extends string> = {
  [P in keyof V & string]: V[P] extends ObjectNode<infer S>
    ? K extends keyof S
      ? PathValue<S[K]>
      : never
    : never;
}[keyof V & string];
type VariantPath<T extends string, V extends VariantShape, TValue> = {
  readonly [K in VariantKeys<V>]: VariantFieldPath<V, K>;
} & { readonly [K in T]: PathMarker<keyof V & string> } & PathMarker<TValue>;
type EntityPath<N extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> =
  N extends ObjectNode<infer S>
    ? SchemaPathFor<S, Infer<N>>
    : N extends VariantNode<infer T, infer V>
      ? VariantPath<T, V, Infer<N>>
      : never;
export type CollectionPath<
  N extends EntitySchemaNode = EntitySchemaNode,
  TValue = unknown,
  K extends string = string,
> = PathMarker<TValue> & {
  item(id: K): EntityPath<N>;
  readonly [collectionNode]: N;
  readonly [collectionKey]: K;
};

type PathValue<N extends DocumentNode> =
  N extends ObjectNode<infer S>
    ? SchemaPathFor<S, Infer<N>>
    : N extends VariantNode<infer TTag, infer V>
      ? VariantPath<TTag, V, Infer<N>>
      : N extends TableNode<infer V, infer K> | MapNode<infer V, infer K>
        ? CollectionPath<V, Infer<N>, K>
        : PathMarker<Infer<N>>;
type CollectionInfo<T> = T extends {
  readonly [collectionNode]: infer TNode extends EntitySchemaNode;
  readonly [collectionKey]: infer K extends string;
}
  ? { readonly id: K; readonly node: TNode }
  : never;
export type CollectionId<T> =
  CollectionInfo<T> extends { readonly id: infer TId extends string } ? TId : string;
export type CollectionNode<T> =
  CollectionInfo<T> extends { readonly node: infer TNode extends EntitySchemaNode }
    ? TNode
    : EntitySchemaNode;
export type CollectionValue<T> = PathValueResult<T>;
type PathValueResult<T> = T extends PathMarker<infer TValue> ? TValue : unknown;

const node = <T extends DocumentNode>(value: T): T => Object.freeze(value);
const roots = new WeakMap<object, ObjectNode<ObjectShape>>();
export const schemaRoot = (schema: DocumentSchema): ObjectNode<ObjectShape> => {
  let root = roots.get(schema);
  if (!root) {
    root = object(schema.shape);
    roots.set(schema, root);
  }
  return root;
};
export const field = <T>(
  validator?: Validator<T>,
  options?: { snapshot(value: T): T }
): FieldNode<T> => node({ kind: 'field', ...(validator ? { validator } : {}), ...options });
type OptionalLeaf =
  | FieldNode<unknown, boolean>
  | VariantNode<string, VariantShape>
  | DictNode<string, unknown>
  | ListNode<unknown>
  | TreeNode<unknown>;
export const optional = <T extends OptionalLeaf>(value: T): OptionalNode<T> => {
  if (!['field', 'variant', 'dict', 'list', 'tree'].includes(value.kind))
    throw new TypeError(
      'Only field, variant, dict, list and tree nodes support optional presence.'
    );
  return node({ ...value, optional: true } as OptionalNode<T>);
};
export const object = <S extends ObjectShape>(shape: S): ObjectNode<S> =>
  node({ kind: 'object', shape });
export const variant = <T extends string, V extends VariantShape>(
  tag: T,
  variants: V
): VariantNode<T, V> => node({ kind: 'variant', tag, variants });
export const table = <V extends EntitySchemaNode, K extends string = string>(
  value: V,
  options?: { readonly key: Validator<K> }
): TableNode<V, K> => node({ kind: 'table', value, ...options });
export const map = <V extends EntitySchemaNode, K extends string = string>(
  value: V,
  options?: { readonly key: Validator<K> }
): MapNode<V, K> => node({ kind: 'map', value, ...options });
export const dict = <TKey extends string = string, TValue = unknown>(options?: {
  readonly key?: Validator<TKey>;
  readonly value?: Validator<TValue>;
}): DictNode<TKey, TValue> => node({ kind: 'dict', key: options?.key, validator: options?.value });
export const list = <TItem>(
  config: DocumentListConfig<TItem> & { readonly value?: Validator<TItem> }
): ListNode<TItem> =>
  ({ kind: 'list', keyOf: config.keyOf, validator: config.value }) as ListNode<TItem>;
export const tree = <TValue = unknown>(validator?: Validator<TValue>): TreeNode<TValue> =>
  node({ kind: 'tree', validator });

const paths = new WeakMap<
  object,
  {
    readonly address: DocumentAddress;
    readonly nodes: readonly DocumentNode[];
    readonly owner: object;
  }
>();
const collectionSchemas = new WeakMap<
  object,
  TableNode<EntitySchemaNode> | MapNode<EntitySchemaNode>
>();
export const collectionSchema = (
  selector: CollectionSelector
): TableNode<EntitySchemaNode> | MapNode<EntitySchemaNode> => {
  const node = collectionSchemas.get(selector);
  if (!node) throw new TypeError('Expected a schema-owned collection selector.');
  return node;
};

const pathProxy = (
  nodes: readonly DocumentNode[],
  address: DocumentAddress,
  owner: object
): object => {
  const proxy = new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        if (typeof property !== 'string') return undefined;
        const collection = nodes.every(node => node.kind === 'table' || node.kind === 'map');
        if (collection && property === 'item')
          return (id: string) => {
            if (typeof id !== 'string') throw new TypeError('Collection keys must be strings.');
            return pathProxy(
              nodes.map(node => (node as TableNode<EntitySchemaNode>).value),
              [...address, id],
              owner
            );
          };
        const children = nodes.flatMap(node => {
          if (node.kind === 'object') return node.shape[property] ? [node.shape[property]] : [];
          if (node.kind !== 'variant') return [];
          if (property === node.tag) return [field<string>()];
          return Object.values(node.variants).flatMap(branch =>
            branch.shape[property] ? [branch.shape[property]] : []
          );
        });
        if (!children.length) throw new TypeError(`Invalid schema path segment: ${property}`);
        return pathProxy(children, [...address, property], owner);
      },
    }
  );
  paths.set(proxy, { nodes, address, owner });
  return proxy;
};

const select = <S extends ObjectShape>(
  owner: DocumentSchema<S>,
  kind: 'collection' | 'value',
  pick: (path: SchemaPath<S>) => unknown
): CollectionSelector | ValueSelector => {
  const scope = {};
  const value = pick(pathProxy([object(owner.shape)], [], scope) as SchemaPath<S>);
  const selected = typeof value === 'object' && value !== null ? paths.get(value) : undefined;
  if (!selected || selected.owner !== scope)
    throw new TypeError('Selector must return a path from its callback.');
  if (
    kind === 'collection' &&
    !selected.nodes.every(node => node.kind === 'table' || node.kind === 'map')
  )
    throw new TypeError('Collection selectors require a table or map path.');
  const result = Object.freeze({
    kind,
    schema: owner,
    address: Object.freeze([...selected.address]),
  }) as CollectionSelector | ValueSelector;
  if (kind === 'collection')
    collectionSchemas.set(
      result,
      selected.nodes[0] as TableNode<EntitySchemaNode> | MapNode<EntitySchemaNode>
    );
  return result;
};

export const schema = <S extends ObjectShape>(shape: S): DocumentSchema<S> => {
  const result: DocumentSchema<S> = {
    kind: 'schema',
    shape,
    collection: <TPath extends CollectionPath>(pick: (path: SchemaPath<S>) => TPath) =>
      select(result, 'collection', pick) as CollectionSelector<
        CollectionId<TPath>,
        CollectionNode<TPath>
      >,
    value: <TPath extends PathMarker<unknown>>(pick: (path: SchemaPath<S>) => TPath) =>
      select(result, 'value', pick) as ValueSelector<PathValueResult<TPath>>,
  };
  return Object.freeze(result);
};
