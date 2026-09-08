import { schemaRoot } from '../schema';
import type {
  DictNode,
  DocumentAddress,
  DocumentNode,
  DocumentSchema,
  Infer,
  DocumentTreeValue,
  EntitySchemaNode,
  ListNode,
  MapNode,
  ObjectNode,
  TableNode,
  TreeNode,
  VariantNode,
} from '../schema';
import type { DocumentAnchor, DocumentOperation } from '../operations';
import type { Synchronous } from '../runtime/contract';

export type FieldWriter<T, Optional extends boolean = false> = {
  readonly set: (value: T) => void;
  readonly update: (transform: (value: T) => Synchronous<T>) => void;
} & (Optional extends true ? { readonly clear: () => void } : {});
export type DictionaryWriter<TKey extends string, TValue> = {
  readonly set: (key: TKey, value: TValue) => void;
  readonly delete: (key: TKey) => void;
  readonly replace: (value: Readonly<Partial<Record<TKey, TValue>>>) => void;
};
export type CollectionWriter<TId extends string, TNode extends EntitySchemaNode> = {
  readonly create: (
    entry:
      | { readonly id: TId; readonly value: Exclude<Infer<TNode>, undefined> }
      | readonly { readonly id: TId; readonly value: Exclude<Infer<TNode>, undefined> }[],
    anchor?: DocumentAnchor<TId>
  ) => void;
  readonly item: (id: TId) => WriterOfNode<TNode>;
  readonly remove: (id: TId | readonly TId[]) => void;
  readonly move: (id: TId, anchor?: DocumentAnchor<TId>) => void;
};
export type MapWriter<TId, TNode extends EntitySchemaNode> = {
  readonly create: (
    entry:
      | { readonly id: TId; readonly value: Exclude<Infer<TNode>, undefined> }
      | readonly { readonly id: TId; readonly value: Exclude<Infer<TNode>, undefined> }[]
  ) => void;
  readonly item: (id: TId) => WriterOfNode<TNode>;
  readonly remove: (id: TId | readonly TId[]) => void;
};
export type ListWriter<T> = {
  readonly insert: (value: T, anchor?: DocumentAnchor) => void;
  readonly move: (key: string, anchor?: DocumentAnchor) => void;
  readonly remove: (key: string) => void;
  readonly replace: (value: readonly T[]) => void;
};
export type TreeWriter<T> = {
  readonly insert: (
    id: string,
    value: T,
    position?: { readonly parentId?: string; readonly index?: number }
  ) => void;
  readonly move: (
    id: string,
    position?: { readonly parentId?: string; readonly index?: number }
  ) => void;
  readonly remove: (id: string) => void;
  readonly set: (id: string, value: T) => void;
  readonly replace: (value: DocumentTreeValue<T>) => void;
};
type OptionalClear<TNode extends DocumentNode, TWriter> = TNode extends { readonly optional: true }
  ? TWriter & { readonly clear: () => void }
  : TWriter;
export type WriterOfNode<TNode extends DocumentNode> = TNode extends {
  kind: 'field';
}
  ? TNode extends { readonly optional: true }
    ? FieldWriter<Infer<TNode>, true>
    : FieldWriter<Infer<TNode>>
  : TNode extends ObjectNode<infer TShape>
    ? { readonly [K in keyof TShape]: WriterOfNode<TShape[K]> }
    : TNode extends VariantNode<string, infer _TVariants>
      ? OptionalClear<
          TNode,
          { readonly replace: (value: Exclude<Infer<TNode>, undefined>) => void }
        >
      : TNode extends TableNode<infer TValue, infer K>
        ? CollectionWriter<K, TValue>
        : TNode extends MapNode<infer TValue, infer K>
          ? MapWriter<K, TValue>
          : TNode extends DictNode<infer TKey, infer TValue>
            ? OptionalClear<TNode, DictionaryWriter<TKey, TValue>>
            : TNode extends ListNode<infer TItem>
              ? OptionalClear<TNode, ListWriter<TItem>>
              : TNode extends TreeNode<infer TValue>
                ? OptionalClear<TNode, TreeWriter<TValue>>
                : FieldWriter<Infer<TNode>>;
export type DocumentWriter<TSchema extends DocumentSchema> = WriterOfNode<
  ObjectNode<TSchema['shape']>
>;

export type WriterSession = {
  apply(operation: DocumentOperation): void;
  set(address: DocumentAddress, value: unknown): void;
  update(address: DocumentAddress, transform: (value: unknown) => unknown): void;
};

const emit = (sink: WriterSession, operation: DocumentOperation): void => sink.apply(operation);

class FieldAccess {
  private setter?: (value: unknown) => void;
  private updater?: (transform: (value: unknown) => unknown) => void;
  constructor(
    readonly address: DocumentAddress,
    readonly session: WriterSession
  ) {}
  get set() {
    return (this.setter ??= (value: unknown) => this.session.set(this.address, value));
  }
  get update() {
    return (this.updater ??= (transform: (value: unknown) => unknown) =>
      this.session.update(this.address, transform));
  }
}
class OptionalFieldAccess extends FieldAccess {
  readonly clear = (): void => {
    this.session.apply({ type: 'field.clear', at: this.address });
  };
}
const writerAddress = Symbol('writer-address');
const writerSession = Symbol('writer-session');
const writerChildren = Symbol('writer-children');
class ObjectAccess {
  readonly [writerChildren]: unknown[] = [];
  readonly [writerAddress]: DocumentAddress;
  readonly [writerSession]: WriterSession;
  constructor(address: DocumentAddress, session: WriterSession) {
    this[writerAddress] = address;
    this[writerSession] = session;
  }
}
const objectWriters = new WeakMap<object, typeof ObjectAccess>();

export const writerFor = (
  node: DocumentNode,
  inputAddress: DocumentAddress,
  sink: WriterSession
): unknown => {
  const address = Object.freeze(inputAddress);
  if (node.kind === 'field')
    return node.optional ? new OptionalFieldAccess(address, sink) : new FieldAccess(address, sink);
  if (node.kind === 'dict')
    return {
      set: (key: string, value: unknown) =>
        emit(sink, { type: 'dict.set', at: address, key, value }),
      delete: (key: string) => emit(sink, { type: 'dict.delete', at: address, key }),
      replace: (value: Readonly<Record<string, unknown>>) =>
        emit(sink, { type: 'dict.replace', at: address, value }),
      ...(node.optional ? { clear: () => emit(sink, { type: 'value.clear', at: address }) } : {}),
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
      ...(node.optional ? { clear: () => emit(sink, { type: 'value.clear', at: address }) } : {}),
    };
  if (node.kind === 'tree')
    return {
      insert: (
        treeNodeId: string,
        value: unknown,
        position?: { parentId?: string; index?: number }
      ) =>
        emit(sink, {
          type: 'tree.insert',
          at: address,
          treeNodeId,
          value,
          parentId: position?.parentId,
          index: position?.index,
        }),
      move: (treeNodeId: string, position?: { parentId?: string; index?: number }) =>
        emit(sink, {
          type: 'tree.move',
          at: address,
          treeNodeId,
          parentId: position?.parentId,
          index: position?.index,
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
      ...(node.optional ? { clear: () => emit(sink, { type: 'value.clear', at: address }) } : {}),
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
  if (node.kind === 'variant')
    return {
      replace: (value: unknown) => emit(sink, { type: 'variant.replace', at: address, value }),
      ...(node.optional ? { clear: () => emit(sink, { type: 'value.clear', at: address }) } : {}),
    };

  let Access = objectWriters.get(node);
  if (!Access) {
    Access = class extends ObjectAccess {};
    for (const [index, key] of Object.keys(node.shape).entries())
      Object.defineProperty(Access.prototype, key, {
        configurable: true,
        get(this: ObjectAccess) {
          return (this[writerChildren][index] ??= writerFor(
            node.shape[key],
            [...this[writerAddress], key],
            this[writerSession]
          ));
        },
      });
    objectWriters.set(node, Access);
  }
  return new Access(address, sink);
};

export const documentWriter = <TSchema extends DocumentSchema>(
  schema: TSchema,
  sink: WriterSession
): DocumentWriter<TSchema> => writerFor(schemaRoot(schema), [], sink) as DocumentWriter<TSchema>;
