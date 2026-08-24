import type { DocumentAddress, DocumentSchema } from './schema';

export type DocumentAnchor =
  { readonly before: string } | { readonly after: string } | { readonly at: 'start' | 'end' };

type OperationBase = { readonly at: DocumentAddress };
export type FieldSetOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'field.set';
  readonly value: unknown;
};
export type FieldClearOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'field.clear';
};
export type VariantReplaceOperation<TSchema extends DocumentSchema = DocumentSchema> =
  OperationBase & {
    readonly type: 'variant.replace';
    readonly value: unknown;
  };
export type DictSetOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'dict.set';
  readonly key: string;
  readonly value: unknown;
};
export type DictDeleteOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'dict.delete';
  readonly key: string;
};
export type DictReplaceOperation<TSchema extends DocumentSchema = DocumentSchema> =
  OperationBase & {
    readonly type: 'dict.replace';
    readonly value: Readonly<Record<string, unknown>>;
  };
export type EntityCreateOperation<TSchema extends DocumentSchema = DocumentSchema> =
  OperationBase & {
    readonly type: 'entity.create';
    readonly entries: readonly EntityEntry[];
    readonly anchor?: DocumentAnchor;
    /** Generated inverse metadata with strictly increasing final indices. Normal creates omit it. */
    readonly positions?: readonly number[];
  };
export type EntityEntry = {
  readonly id: string;
  readonly value: unknown;
};
export type EntityRemoveOperation<TSchema extends DocumentSchema = DocumentSchema> =
  OperationBase & {
    readonly type: 'entity.remove';
    readonly ids: readonly string[];
  };
export type EntityMoveOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'entity.move';
  readonly id: string;
  readonly anchor?: DocumentAnchor;
};
export type ListInsertOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'list.insert';
  readonly key: string;
  readonly value: unknown;
  readonly anchor?: DocumentAnchor;
};
export type ListMoveOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'list.move';
  readonly key: string;
  readonly anchor?: DocumentAnchor;
};
export type ListRemoveOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'list.remove';
  readonly key: string;
};
export type ListReplaceOperation<TSchema extends DocumentSchema = DocumentSchema> =
  OperationBase & {
    readonly type: 'list.replace';
    readonly value: readonly unknown[];
    readonly keys: readonly string[];
  };
export type TreeInsertOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'tree.insert';
  readonly treeNodeId: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly value?: unknown;
};
export type TreeMoveOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'tree.move';
  readonly treeNodeId: string;
  readonly parentId?: string;
  readonly index?: number;
};
export type TreeRemoveOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'tree.remove';
  readonly treeNodeId: string;
};
export type TreeSetOperation<TSchema extends DocumentSchema = DocumentSchema> = OperationBase & {
  readonly type: 'tree.set';
  readonly treeNodeId: string;
  readonly value: unknown;
};
export type TreeReplaceOperation<TSchema extends DocumentSchema = DocumentSchema> =
  OperationBase & { readonly type: 'tree.replace'; readonly value: unknown };

export type DocumentOperationUnion<TSchema extends DocumentSchema = DocumentSchema> =
  | FieldSetOperation<TSchema>
  | FieldClearOperation<TSchema>
  | VariantReplaceOperation<TSchema>
  | DictSetOperation<TSchema>
  | DictDeleteOperation<TSchema>
  | DictReplaceOperation<TSchema>
  | EntityCreateOperation<TSchema>
  | EntityRemoveOperation<TSchema>
  | EntityMoveOperation<TSchema>
  | ListInsertOperation<TSchema>
  | ListMoveOperation<TSchema>
  | ListRemoveOperation<TSchema>
  | ListReplaceOperation<TSchema>
  | TreeInsertOperation<TSchema>
  | TreeMoveOperation<TSchema>
  | TreeRemoveOperation<TSchema>
  | TreeSetOperation<TSchema>
  | TreeReplaceOperation<TSchema>;

export type DocumentOperation<TSchema extends DocumentSchema = DocumentSchema> =
  DocumentOperationUnion<TSchema>;
