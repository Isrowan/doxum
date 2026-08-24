import { object } from '../schema';
import type {
  DictNode,
  DocumentAddress,
  DocumentNode,
  DocumentSchema,
  DocumentValueOfNode,
  ListNode,
  MapNode,
  ObjectNode,
  SingleNode,
  TableNode,
  TreeNode,
  VariantNode,
} from '../schema';
import type { DocumentAnchor, DocumentOperationUnion } from '../operations';

export type FieldWriter<T> = {
  readonly set: (value: T) => void;
  readonly clear?: () => void;
};
export type DictionaryWriter<TKey extends string, TValue> = {
  readonly set: (key: TKey, value: TValue) => void;
  readonly delete: (key: TKey) => void;
  readonly replace: (value: Readonly<Partial<Record<TKey, TValue>>>) => void;
};
export type CollectionWriter<TId, TEntry> = {
  readonly create: (
    entry:
      | { readonly id: TId; readonly value: TEntry }
      | readonly { readonly id: TId; readonly value: TEntry }[],
    anchor?: DocumentAnchor
  ) => void;
  readonly item: (id: TId) => EntityWriter<TEntry>;
  readonly remove: (id: TId | readonly TId[]) => void;
  readonly move: (id: TId, anchor?: DocumentAnchor) => void;
};
export type MapWriter<TId, TEntry> = {
  readonly create: (
    entry:
      | { readonly id: TId; readonly value: TEntry }
      | readonly { readonly id: TId; readonly value: TEntry }[]
  ) => void;
  readonly item: (id: TId) => EntityWriter<TEntry>;
  readonly remove: (id: TId | readonly TId[]) => void;
};
export type ListWriter<T> = {
  readonly insert: (value: T, anchor?: DocumentAnchor) => void;
  readonly move: (key: string, anchor?: DocumentAnchor) => void;
  readonly remove: (key: string) => void;
  readonly replace: (value: readonly T[]) => void;
};
export type TreeWriter<T> = {
  readonly insert: (id: string, value: T, parentId?: string, index?: number) => void;
  readonly move: (id: string, parentId?: string, index?: number) => void;
  readonly remove: (id: string) => void;
  readonly set: (id: string, value: T) => void;
  readonly replace: (value: unknown) => void;
};
export type EntityWriter<T> = T extends object
  ? { readonly [K in keyof T]: WriterValue<T[K]> }
  : FieldWriter<T>;
export type WriterValue<T> = T extends readonly (infer TItem)[]
  ? ListWriter<TItem>
  : T extends object
    ? EntityWriter<T>
    : FieldWriter<T>;
export type WriterOfNode<TNode extends DocumentNode> = TNode extends {
  kind: 'field';
}
  ? FieldWriter<DocumentValueOfNode<TNode>>
  : TNode extends ObjectNode<infer TShape>
    ? { readonly [K in keyof TShape]: WriterOfNode<TShape[K]> }
    : TNode extends VariantNode<string, infer _TVariants>
      ? { readonly replace: (value: DocumentValueOfNode<TNode>) => void }
      : TNode extends SingleNode<infer TValue>
        ? WriterOfNode<TValue>
        : TNode extends TableNode<infer TValue>
          ? CollectionWriter<string, DocumentValueOfNode<TValue>>
          : TNode extends MapNode<infer TValue>
            ? MapWriter<string, DocumentValueOfNode<TValue>>
            : TNode extends DictNode<infer TKey, infer TValue>
              ? DictionaryWriter<TKey, TValue>
              : TNode extends ListNode<infer TItem>
                ? ListWriter<TItem>
                : TNode extends TreeNode<infer TValue>
                  ? TreeWriter<TValue>
                  : FieldWriter<DocumentValueOfNode<TNode>>;
export type DocumentWriter<TSchema extends DocumentSchema> = WriterOfNode<
  ObjectNode<TSchema['shape']>
>;

export type OperationSink = (operation: DocumentOperationUnion) => void;

const schemaRoot = (schema: DocumentSchema): DocumentNode => object(schema.shape);

const emit = (sink: OperationSink, operation: DocumentOperationUnion): void => sink(operation);

export const writerFor = (
  node: DocumentNode,
  inputAddress: DocumentAddress,
  sink: OperationSink
): unknown => {
  const address = Object.freeze(inputAddress);
  if (node.kind === 'field')
    return {
      set: (value: unknown) => emit(sink, { type: 'field.set', at: address, value }),
      clear: node.optional ? () => emit(sink, { type: 'field.clear', at: address }) : undefined,
    };
  if (node.kind === 'dict' || node.kind === 'record')
    return {
      set: (key: string, value: unknown) =>
        emit(sink, { type: 'dict.set', at: address, key, value }),
      delete: (key: string) => emit(sink, { type: 'dict.delete', at: address, key }),
      replace: (value: Readonly<Record<string, unknown>>) =>
        emit(sink, { type: 'dict.replace', at: address, value }),
    };
  if (node.kind === 'list')
    return {
      insert: (value: unknown, anchor?: DocumentAnchor) =>
        emit(sink, {
          type: 'list.insert',
          at: address,
          key: node.keyOf(value),
          value,
          anchor,
        }),
      move: (key: string, anchor?: DocumentAnchor) =>
        emit(sink, { type: 'list.move', at: address, key, anchor }),
      remove: (key: string) => emit(sink, { type: 'list.remove', at: address, key }),
      replace: (value: readonly unknown[]) =>
        emit(sink, {
          type: 'list.replace',
          at: address,
          value,
          keys: value.map(node.keyOf),
        }),
    };
  if (node.kind === 'tree')
    return {
      insert: (treeNodeId: string, value: unknown, parentId?: string, index?: number) =>
        emit(sink, {
          type: 'tree.insert',
          at: address,
          treeNodeId,
          value,
          parentId,
          index,
        }),
      move: (treeNodeId: string, parentId?: string, index?: number) =>
        emit(sink, {
          type: 'tree.move',
          at: address,
          treeNodeId,
          parentId,
          index,
        }),
      remove: (treeNodeId: string) => emit(sink, { type: 'tree.remove', at: address, treeNodeId }),
      set: (treeNodeId: string, value: unknown) =>
        emit(sink, {
          type: 'tree.set',
          at: address,
          treeNodeId,
          value,
        }),
      replace: (value: unknown) => emit(sink, { type: 'tree.replace', at: address, value }),
    };
  if (node.kind === 'table') {
    let items: Map<string, unknown> | undefined;
    return {
      create: (
        input:
          | { readonly id: string; readonly value: unknown }
          | readonly { readonly id: string; readonly value: unknown }[],
        anchor?: DocumentAnchor
      ) => {
        const entries = Array.isArray(input) ? input : [input];
        emit(sink, {
          type: 'entity.create',
          at: address,
          entries: entries.map(({ id, value }) => ({ id, value })),
          anchor,
        });
      },
      item: (id: string) => {
        const cached = items?.get(id);
        if (cached) return cached;
        const writer = writerFor(node.value, [...address, id], sink);
        (items ??= new Map()).set(id, writer);
        return writer;
      },
      remove: (input: string | readonly string[]) =>
        emit(sink, {
          type: 'entity.remove',
          at: address,
          ids: Array.isArray(input) ? [...input] : [input],
        }),
      move: (id: string, anchor?: DocumentAnchor) =>
        emit(sink, { type: 'entity.move', at: address, id, anchor }),
    };
  }
  if (node.kind === 'map') {
    let items: Map<string, unknown> | undefined;
    return {
      create: (
        input:
          | { readonly id: string; readonly value: unknown }
          | readonly { readonly id: string; readonly value: unknown }[]
      ) => {
        const entries = Array.isArray(input) ? input : [input];
        emit(sink, {
          type: 'entity.create',
          at: address,
          entries: entries.map(({ id, value }) => ({ id, value })),
        });
      },
      item: (id: string) => {
        const cached = items?.get(id);
        if (cached) return cached;
        const writer = writerFor(node.value, [...address, id], sink);
        (items ??= new Map()).set(id, writer);
        return writer;
      },
      remove: (input: string | readonly string[]) =>
        emit(sink, {
          type: 'entity.remove',
          at: address,
          ids: Array.isArray(input) ? [...input] : [input],
        }),
    };
  }
  if (node.kind === 'single') return writerFor(node.value, address, sink);
  if (node.kind === 'variant')
    return {
      replace: (value: unknown) => emit(sink, { type: 'variant.replace', at: address, value }),
    };

  let children: Map<string, unknown> | undefined;
  return new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        if (typeof property !== 'string' || !node.shape[property]) return undefined;
        const cached = children?.get(property);
        if (cached) return cached;
        const writer = writerFor(node.shape[property], [...address, property], sink);
        (children ??= new Map()).set(property, writer);
        return writer;
      },
    }
  );
};

export const documentWriter = <TSchema extends DocumentSchema>(
  schema: TSchema,
  sink: OperationSink
): DocumentWriter<TSchema> => writerFor(schemaRoot(schema), [], sink) as DocumentWriter<TSchema>;
