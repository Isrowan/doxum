export type DocumentAddress = readonly string[];

/** Pure synchronous validation. Successful output is ignored; input is never transformed. */
export type Validator<T> =
  | ((value: unknown) => value is T)
  | ((value: unknown) => asserts value is T)
  | {
      readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: { readonly input: unknown; readonly output: T };
        validate(value: unknown):
          | { readonly value: T; readonly issues?: undefined }
          | {
              readonly issues: readonly {
                readonly message: string;
                readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
              }[];
            }
          | PromiseLike<unknown>;
      };
    };

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

declare const schemaType: unique symbol;
declare const objectSchema: unique symbol;

/** Portable public schema handle. The definition parameter carries compile-time shape only. */
export type Schema<T = unknown, Definition = unknown> = {
  readonly [schemaType]: {
    readonly value: T;
    readonly definition: Definition;
  };
};

type PublicSchemaShape = { readonly [key: string]: Schema<unknown, unknown> };

export type ObjectSchema<
  T extends object = object,
  Shape extends PublicSchemaShape = PublicSchemaShape,
> = Schema<T, { readonly kind: 'object'; readonly shape: Shape }> & {
  readonly [objectSchema]: true;
};

type SchemaDefinitionOf<S extends Schema<unknown, unknown>> =
  S extends Schema<unknown, infer Definition> ? Definition : unknown;

type Optionalized<N extends DocumentNode, Optional extends boolean> = Optional extends true
  ? OptionalNode<N>
  : N;
type FieldNodeFor<TValue, Optional extends boolean> = Optional extends true
  ? FieldNode<TValue, true>
  : FieldNode<TValue, false>;
type TreeNodeFor<TValue, ValueOptional extends boolean> = ValueOptional extends true
  ? TreeNode<TValue, true>
  : TreeNode<TValue, false>;

type SchemaNodeFromDefinition<Definition> = Definition extends {
  readonly kind: 'field';
  readonly value: infer TValue;
  readonly optional: infer Optional extends boolean;
}
  ? FieldNodeFor<TValue, Optional>
  : Definition extends {
        readonly kind: 'object';
        readonly shape: infer Shape extends PublicSchemaShape;
      }
    ? ObjectNode<NodeShapeOf<Shape>>
    : Definition extends {
          readonly kind: 'variant';
          readonly tag: infer Tag extends string;
          readonly variants: infer Variants extends PublicVariantShape;
          readonly optional: infer Optional extends boolean;
        }
      ? Optionalized<VariantNode<Tag, VariantNodeShapeOf<Variants>>, Optional>
      : Definition extends {
            readonly kind: 'table';
            readonly value: infer Value extends Schema<unknown, unknown>;
            readonly key: infer Key extends string;
          }
        ? TableNode<Extract<SchemaNodeOf<Value>, EntitySchemaNode>, Key>
        : Definition extends {
              readonly kind: 'map';
              readonly value: infer Value extends Schema<unknown, unknown>;
              readonly key: infer Key extends string;
              readonly optional: infer Optional extends boolean;
            }
          ? Optionalized<MapNode<Extract<SchemaNodeOf<Value>, ValueSchemaNode>, Key>, Optional>
          : Definition extends {
                readonly kind: 'list';
                readonly value: infer TValue;
                readonly optional: infer Optional extends boolean;
              }
            ? Optionalized<ListNode<TValue>, Optional>
            : Definition extends {
                  readonly kind: 'tree';
                  readonly value: infer TValue;
                  readonly valueOptional: infer ValueOptional extends boolean;
                  readonly optional: infer Optional extends boolean;
                }
              ? Optionalized<TreeNodeFor<TValue, ValueOptional>, Optional>
              : DocumentNode;

export type SchemaNodeOf<S extends Schema<unknown, unknown>> = SchemaNodeFromDefinition<
  SchemaDefinitionOf<S>
>;

export const schemaNodeOf = <S extends Schema<unknown, unknown>>(schema: S): SchemaNodeOf<S> =>
  schema as unknown as SchemaNodeOf<S>;

// Flatten only schema-generated objects; user-supplied field values stay opaque.
type SchemaObject<T> = { [K in keyof T]: T[K] } & {};

/** Infer a document or node value, including optional node presence. */
type InferNode<T extends DocumentNode> = T extends { readonly optional: true }
  ? NodeValue<T> | undefined
  : NodeValue<T>;

export type Infer<T extends Schema<unknown, unknown> | DocumentNode> =
  T extends Schema<infer TValue, unknown> ? TValue : T extends DocumentNode ? InferNode<T> : never;

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

export type RootNodeOf<S extends ObjectSchema<object>> = Extract<SchemaNodeOf<S>, ObjectNode>;
export type EntitySchemaNode = ObjectNode<ObjectShape> | VariantNode<string, VariantShape>;
export type ValueSchemaNode = EntitySchemaNode | FieldNode<unknown, boolean>;
export type DocumentAnchor<K extends string = string> =
  { readonly at: 'start' | 'end' } | { readonly before: K } | { readonly after: K };

type NodeShapeOf<S extends PublicSchemaShape> = {
  readonly [K in keyof S]: SchemaNodeOf<S[K]>;
};
type PublicOptionalKeys<S extends PublicSchemaShape> = {
  [K in keyof S]: SchemaNodeOf<S[K]> extends { readonly optional: true } ? K : never;
}[keyof S];
type PublicRequiredKeys<S extends PublicSchemaShape> = Exclude<keyof S, PublicOptionalKeys<S>>;
type PublicShapeValue<S extends PublicSchemaShape> = SchemaObject<
  { readonly [K in PublicRequiredKeys<S>]: Infer<S[K]> } & {
    readonly [K in PublicOptionalKeys<S>]?: Infer<S[K]>;
  }
>;
type PublicVariantShape = { readonly [key: string]: ObjectSchema<object> };
type VariantNodeShapeOf<V extends PublicVariantShape> = {
  readonly [K in keyof V]: Extract<SchemaNodeOf<V[K]>, ObjectNode>;
};
export const collectionEntryNode = (node: DocumentNode): ValueSchemaNode | undefined =>
  node.kind === 'map' || node.kind === 'table' || node.kind === 'list' ? node.value : undefined;

const node = <T extends DocumentNode>(value: T): T => Object.freeze(value);
type OptionalLeaf =
  | FieldNode<unknown, boolean>
  | VariantNode<string, VariantShape>
  | MapNode<ValueSchemaNode>
  | ListNode<unknown>
  | TreeNode<unknown, false>
  | TreeNode<unknown, true>;
type FieldSchema<T, Optional extends boolean = boolean> = Schema<
  ReadonlyValue<T> | (Optional extends true ? undefined : never),
  { readonly kind: 'field'; readonly value: T; readonly optional: Optional }
>;
type VariantSchema = Schema<
  unknown,
  {
    readonly kind: 'variant';
    readonly tag: string;
    readonly variants: PublicVariantShape;
    readonly optional: boolean;
  }
>;
type MapSchema = Schema<
  unknown,
  {
    readonly kind: 'map';
    readonly value: Schema<unknown, unknown>;
    readonly key: string;
    readonly optional: boolean;
  }
>;
type ListSchema = Schema<
  unknown,
  { readonly kind: 'list'; readonly value: unknown; readonly optional: boolean }
>;
type TreeSchema = Schema<
  unknown,
  {
    readonly kind: 'tree';
    readonly value: unknown;
    readonly valueOptional: boolean;
    readonly optional: boolean;
  }
>;
type OptionalSchema = FieldSchema<unknown> | VariantSchema | MapSchema | ListSchema | TreeSchema;
type EntitySchema = ObjectSchema<object> | VariantSchema;
type ValueSchema = EntitySchema | FieldSchema<unknown>;
type EntityNodeOf<V extends EntitySchema> = Extract<SchemaNodeOf<V>, EntitySchemaNode>;
type ValueNodeOf<V extends ValueSchema> = Extract<SchemaNodeOf<V>, ValueSchemaNode>;

export const field = <T>(
  validator?: Validator<T>
): Schema<
  ReadonlyValue<T>,
  { readonly kind: 'field'; readonly value: T; readonly optional: false }
> =>
  node({ kind: 'field', ...(validator ? { validator } : {}) }) as unknown as Schema<
    ReadonlyValue<T>,
    { readonly kind: 'field'; readonly value: T; readonly optional: false }
  >;

export function optional<T, Optional extends boolean>(
  value: Schema<
    ReadonlyValue<T> | (Optional extends true ? undefined : never),
    { readonly kind: 'field'; readonly value: T; readonly optional: Optional }
  >
): Schema<
  ReadonlyValue<T> | undefined,
  { readonly kind: 'field'; readonly value: T; readonly optional: true }
>;
export function optional<
  TValue,
  Tag extends string,
  Variants extends PublicVariantShape,
  Optional extends boolean,
>(
  value: Schema<
    TValue,
    {
      readonly kind: 'variant';
      readonly tag: Tag;
      readonly variants: Variants;
      readonly optional: Optional;
    }
  >
): Schema<
  TValue | undefined,
  {
    readonly kind: 'variant';
    readonly tag: Tag;
    readonly variants: Variants;
    readonly optional: true;
  }
>;
export function optional<
  TValue,
  Value extends Schema<unknown, unknown>,
  Key extends string,
  Optional extends boolean,
>(
  value: Schema<
    TValue,
    {
      readonly kind: 'map';
      readonly value: Value;
      readonly key: Key;
      readonly optional: Optional;
    }
  >
): Schema<
  TValue | undefined,
  { readonly kind: 'map'; readonly value: Value; readonly key: Key; readonly optional: true }
>;
export function optional<TValue, TItem, Optional extends boolean>(
  value: Schema<
    TValue,
    { readonly kind: 'list'; readonly value: TItem; readonly optional: Optional }
  >
): Schema<
  TValue | undefined,
  { readonly kind: 'list'; readonly value: TItem; readonly optional: true }
>;
export function optional<
  TValue,
  TNodeValue,
  ValueOptional extends boolean,
  Optional extends boolean,
>(
  value: Schema<
    TValue,
    {
      readonly kind: 'tree';
      readonly value: TNodeValue;
      readonly valueOptional: ValueOptional;
      readonly optional: Optional;
    }
  >
): Schema<
  TValue | undefined,
  {
    readonly kind: 'tree';
    readonly value: TNodeValue;
    readonly valueOptional: ValueOptional;
    readonly optional: true;
  }
>;
export function optional(value: OptionalSchema): Schema<unknown, unknown> {
  const concrete = schemaNodeOf(value) as OptionalLeaf;
  if (!['field', 'variant', 'map', 'list', 'tree'].includes(concrete.kind))
    throw new TypeError('Only field, variant, map, list and tree nodes support optional presence.');
  return node({ ...concrete, optional: true } as OptionalNode<
    typeof concrete
  >) as unknown as Schema<unknown, unknown>;
}

export const object = <S extends PublicSchemaShape>(
  shape: S
): ObjectSchema<PublicShapeValue<S>, S> =>
  node({
    kind: 'object',
    shape: Object.freeze(
      Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, schemaNodeOf(value)]))
    ) as NodeShapeOf<S>,
  }) as unknown as ObjectSchema<PublicShapeValue<S>, S>;
export const variant = <T extends string, V extends PublicVariantShape>(
  tag: T,
  variants: V
): Schema<
  {
    [K in keyof V & string]: SchemaObject<{ readonly [P in T]: K } & Infer<V[K]>>;
  }[keyof V & string],
  {
    readonly kind: 'variant';
    readonly tag: T;
    readonly variants: V;
    readonly optional: false;
  }
> =>
  node({
    kind: 'variant',
    tag,
    variants: Object.freeze(
      Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, schemaNodeOf(value)]))
    ) as VariantNodeShapeOf<V>,
  }) as unknown as Schema<
    {
      [K in keyof V & string]: SchemaObject<{ readonly [P in T]: K } & Infer<V[K]>>;
    }[keyof V & string],
    {
      readonly kind: 'variant';
      readonly tag: T;
      readonly variants: V;
      readonly optional: false;
    }
  >;
export const table = <V extends EntitySchema, K extends string = string>(
  value: V,
  options?: { readonly key: Validator<K> }
): Schema<
  {
    readonly ids: readonly K[];
    readonly byId: Readonly<Record<K, Exclude<Infer<V>, undefined>>>;
  },
  { readonly kind: 'table'; readonly value: V; readonly key: K }
> =>
  node({
    kind: 'table',
    value: schemaNodeOf(value) as EntityNodeOf<V>,
    ...options,
  }) as unknown as Schema<
    {
      readonly ids: readonly K[];
      readonly byId: Readonly<Record<K, Exclude<Infer<V>, undefined>>>;
    },
    { readonly kind: 'table'; readonly value: V; readonly key: K }
  >;
export const map = <V extends ValueSchema, K extends string = string>(
  value: V,
  options?: { readonly key: Validator<K> }
): Schema<
  Readonly<
    Record<
      K,
      V extends Schema<infer TValue, infer Definition>
        ? Definition extends { readonly kind: 'field' }
          ? TValue
          : Exclude<TValue, undefined>
        : never
    >
  >,
  {
    readonly kind: 'map';
    readonly value: V;
    readonly key: K;
    readonly optional: false;
  }
> =>
  node({
    kind: 'map',
    value: schemaNodeOf(value) as ValueNodeOf<V>,
    ...options,
  }) as unknown as Schema<
    Readonly<
      Record<
        K,
        V extends Schema<infer TValue, infer Definition>
          ? Definition extends { readonly kind: 'field' }
            ? TValue
            : Exclude<TValue, undefined>
          : never
      >
    >,
    {
      readonly kind: 'map';
      readonly value: V;
      readonly key: K;
      readonly optional: false;
    }
  >;
export const list = <TItem>(
  value: Schema<
    ReadonlyValue<TItem>,
    { readonly kind: 'field'; readonly value: TItem; readonly optional: false }
  >,
  config: DocumentListConfig<TItem>
): Schema<
  readonly ReadonlyValue<TItem>[],
  { readonly kind: 'list'; readonly value: TItem; readonly optional: false }
> =>
  node({
    kind: 'list',
    keyOf: config.keyOf,
    value: schemaNodeOf(value),
  }) as unknown as Schema<
    readonly ReadonlyValue<TItem>[],
    { readonly kind: 'list'; readonly value: TItem; readonly optional: false }
  >;
export function tree<TValue>(
  value: Schema<
    ReadonlyValue<TValue>,
    { readonly kind: 'field'; readonly value: TValue; readonly optional: false }
  >
): Schema<
  DocumentTreeValue<TValue, false>,
  {
    readonly kind: 'tree';
    readonly value: TValue;
    readonly valueOptional: false;
    readonly optional: false;
  }
>;
export function tree<TValue>(
  value: Schema<
    ReadonlyValue<TValue> | undefined,
    { readonly kind: 'field'; readonly value: TValue; readonly optional: true }
  >
): Schema<
  DocumentTreeValue<TValue, true>,
  {
    readonly kind: 'tree';
    readonly value: TValue;
    readonly valueOptional: true;
    readonly optional: false;
  }
>;
export function tree(
  value: FieldSchema<unknown>
): Schema<DocumentTreeValue<unknown, boolean>, unknown> {
  return Object.freeze({
    kind: 'tree' as const,
    value: schemaNodeOf(value),
  }) as unknown as Schema<DocumentTreeValue<unknown, boolean>, unknown>;
}
