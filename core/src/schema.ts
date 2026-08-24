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

type BaseNode<K extends string> = { readonly kind: K };
export type FieldNode<T, Optional extends boolean = false> = BaseNode<'field'> & {
  readonly __value?: T;
  readonly optional?: Optional;
};
export type OptionalNode<TNode extends DocumentNode> = TNode & {
  readonly optional: true;
};
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
export type SingleNode<TValue extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> =
  BaseNode<'single'> & {
    readonly value: TValue;
  };
export type TableNode<TValue extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> =
  BaseNode<'table'> & {
    readonly value: TValue;
  };
export type MapNode<TValue extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> =
  BaseNode<'map'> & {
    readonly value: TValue;
  };
export type RecordNode<TId extends string, TValue> = BaseNode<'record'> & {
  readonly __id?: TId;
  readonly __value?: TValue;
};
export type DictNode<TKey extends string, TValue> = BaseNode<'dict'> & {
  readonly __key?: TKey;
  readonly __value?: TValue;
};
export type ListNode<TItem> = BaseNode<'list'> & {
  readonly __item?: TItem;
  keyOf(item: TItem): string;
};
export type TreeNode<TValue> = BaseNode<'tree'> & {
  readonly __value?: TValue;
};

export type DocumentNode =
  | FieldNode<unknown, boolean>
  | ObjectNode<ObjectShape>
  | VariantNode<string, VariantShape>
  | SingleNode<ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>
  | TableNode<ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>
  | MapNode<ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>
  | RecordNode<string, unknown>
  | DictNode<string, unknown>
  | ListNode<unknown>
  | TreeNode<unknown>;

type EntityValue<N extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> =
  N extends ObjectNode<infer S>
    ? DocumentValueOfShape<S>
    : N extends VariantNode<infer T, infer V>
      ? {
          [K in keyof V & string]: { [P in T]: K } & DocumentValueOfShape<
            V[K] extends ObjectNode<infer S> ? S : never
          >;
        }[keyof V & string]
      : never;

export type DocumentValueOfNode<N> =
  N extends FieldNode<infer T, infer O>
    ? O extends true
      ? T | undefined
      : T
    : N extends ObjectNode<infer S>
      ? DocumentValueOfShape<S>
      : N extends VariantNode<infer T, infer V>
        ? EntityValue<VariantNode<T, V>>
        : N extends SingleNode<infer V>
          ? EntityValue<V>
          : N extends TableNode<infer V>
            ? {
                readonly ids: readonly string[];
                readonly byId: Readonly<Record<string, EntityValue<V>>>;
              }
            : N extends MapNode<infer V>
              ? Readonly<Record<string, EntityValue<V>>>
              : N extends RecordNode<infer I, infer T>
                ? Readonly<Record<I, T>>
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
export type DocumentValueOfShape<S extends ObjectShape> = {
  readonly [K in RequiredKeys<S>]: DocumentValueOfNode<S[K]>;
} & { readonly [K in OptionalKeys<S>]?: DocumentValueOfNode<S[K]> };
export type ReadonlyDocument<S extends DocumentSchema> = DocumentValueOfShape<S['shape']>;

export type CollectionSelector<TId extends string = string, TEntry = unknown> = {
  readonly kind: 'collection';
  readonly schema: DocumentSchema;
  readonly address: DocumentAddress;
  readonly __id?: TId;
  readonly __entry?: TEntry;
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
  | CollectionSelector<string, T>;
type PathMarker<TValue> = { readonly __value?: TValue };

type SchemaPathFor<S extends ObjectShape = ObjectShape, TValue = unknown> = {
  readonly [K in keyof S]: PathValue<S[K]>;
} & {
  readonly item: (id: string) => SchemaPathFor<{}, unknown>;
} & PathMarker<TValue>;

export type DocumentSchema<TShape extends ObjectShape = {}> = {
  readonly kind: 'schema';
  readonly shape: TShape;
  collection<TPath extends PathMarker<unknown>>(
    pick: (path: SchemaPath<TShape>) => TPath
  ): CollectionSelector<CollectionId<TPath>, CollectionEntry<TPath>>;
  value<TPath extends PathMarker<unknown>>(
    pick: (path: SchemaPath<TShape>) => TPath
  ): ValueSelector<PathValueResult<TPath>>;
};

export type SchemaPath<S extends ObjectShape = {}> = SchemaPathFor<S, DocumentValueOfShape<S>>;

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
type VariantPath<V extends VariantShape> = {
  readonly [K in VariantKeys<V>]: VariantFieldPath<V, K>;
} & {
  readonly item: (id: string) => SchemaPathFor<{}, unknown>;
} & PathMarker<EntityValue<VariantNode<string, V>>>;
type PathNodeValue<N extends DocumentNode> = N extends { readonly optional: true }
  ? DocumentValueOfNode<N> | undefined
  : DocumentValueOfNode<N>;
type EntityPath<N extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> =
  N extends ObjectNode<infer S>
    ? SchemaPathFor<S, PathNodeValue<N>>
    : N extends VariantNode<string, infer V>
      ? VariantPath<V>
      : never;
type CollectionPath<N extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>> = Omit<
  EntityPath<N>,
  'item'
> & {
  readonly item: (id: string) => EntityPath<N>;
  readonly __collection?: {
    readonly id: string;
    readonly entry: DocumentValueOfNode<N>;
  };
};

type PathValue<N extends DocumentNode> =
  N extends ObjectNode<infer S>
    ? SchemaPathFor<S, PathNodeValue<N>>
    : N extends VariantNode<infer _TTag, infer V>
      ? VariantPath<V>
      : N extends TableNode<infer V> | MapNode<infer V>
        ? CollectionPath<V>
        : N extends SingleNode<infer V>
          ? EntityPath<V>
          : SchemaPathFor<{}, PathNodeValue<N>>;
type CollectionInfo<T> = T extends {
  readonly __collection?: {
    readonly id: infer TId;
    readonly entry: infer TEntry;
  };
}
  ? { readonly id: TId; readonly entry: TEntry }
  : never;
type CollectionId<T> =
  CollectionInfo<T> extends { readonly id: infer TId extends string } ? TId : string;
type CollectionEntry<T> =
  CollectionInfo<T> extends { readonly entry: infer TEntry } ? TEntry : never;
type PathValueResult<T> = T extends PathMarker<infer TValue> ? TValue : unknown;

const node = <T extends DocumentNode>(value: T): T => Object.freeze(value);
export const field = <T>(): FieldNode<T> => node({ kind: 'field' });
export const optional = <T extends DocumentNode>(value: T): OptionalNode<T> =>
  node({ ...value, optional: true } as OptionalNode<T>);
export const object = <S extends ObjectShape>(shape: S): ObjectNode<S> =>
  node({ kind: 'object', shape });
export const variant = <T extends string, V extends VariantShape>(
  tag: T,
  variants: V
): VariantNode<T, V> => node({ kind: 'variant', tag, variants });
export const single = <V extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>(
  value: V
): SingleNode<V> => node({ kind: 'single', value });
export const table = <V extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>(
  value: V
): TableNode<V> => node({ kind: 'table', value });
export const map = <V extends ObjectNode<ObjectShape> | VariantNode<string, VariantShape>>(
  value: V
): MapNode<V> => node({ kind: 'map', value });
export const record = <TId extends string = string, TValue = unknown>(): RecordNode<TId, TValue> =>
  node({ kind: 'record' });
export const dict = <TKey extends string = string, TValue = unknown>(): DictNode<TKey, TValue> =>
  node({ kind: 'dict' });
export const list = <TItem>(config: DocumentListConfig<TItem>): ListNode<TItem> =>
  ({ kind: 'list', keyOf: config.keyOf }) as ListNode<TItem>;
export const tree = <TValue = unknown>(): TreeNode<TValue> => node({ kind: 'tree' });

const pathProxy = (address: DocumentAddress): SchemaPath & { readonly address: DocumentAddress } =>
  new Proxy({ address } as SchemaPath & { readonly address: DocumentAddress }, {
    get: (_target, property: string | symbol) => {
      if (property === 'address') return address;
      if (property === 'item') return (id: string) => pathProxy([...address, id]);
      if (typeof property === 'symbol') return undefined;
      return pathProxy([...address, property]);
    },
  });

const select = <S extends ObjectShape>(
  owner: DocumentSchema<S>,
  kind: 'collection' | 'value',
  pick: (path: SchemaPath<S>) => unknown
): CollectionSelector | ValueSelector => {
  const value = pick(pathProxy([]) as unknown as SchemaPath<S>);
  const selected = value as { readonly address?: DocumentAddress };
  return Object.freeze({
    kind,
    schema: owner,
    address: Object.freeze([...(selected.address ?? [])]),
  }) as CollectionSelector | ValueSelector;
};

export const schema = <S extends ObjectShape>(shape: S): DocumentSchema<S> => {
  const result: DocumentSchema<S> = {
    kind: 'schema',
    shape,
    collection: <TPath extends PathMarker<unknown>>(pick: (path: SchemaPath<S>) => TPath) =>
      select(result, 'collection', pick) as CollectionSelector<
        CollectionId<TPath>,
        CollectionEntry<TPath>
      >,
    value: <TPath extends PathMarker<unknown>>(pick: (path: SchemaPath<S>) => TPath) =>
      select(result, 'value', pick) as ValueSelector<PathValueResult<TPath>>,
  };
  return Object.freeze(result);
};
