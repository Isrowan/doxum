import type { DocumentAddress } from './schema';

export type DocumentAnchor<K extends string = string> =
  { readonly before: K } | { readonly after: K } | { readonly at: 'start' | 'end' };

type OperationBase = { readonly at: DocumentAddress };
export type FieldSetOperation = OperationBase & {
  readonly type: 'field.set';
  readonly value: unknown;
};
export type FieldClearOperation = OperationBase & {
  readonly type: 'field.clear';
};
export type ValueClearOperation = OperationBase & {
  readonly type: 'value.clear';
};
export type VariantReplaceOperation = OperationBase & {
  readonly type: 'variant.replace';
  readonly value: unknown;
};
export type DictSetOperation = OperationBase & {
  readonly type: 'dict.set';
  readonly key: string;
  readonly value: unknown;
};
export type DictDeleteOperation = OperationBase & {
  readonly type: 'dict.delete';
  readonly key: string;
};
export type DictReplaceOperation = OperationBase & {
  readonly type: 'dict.replace';
  readonly value: Readonly<Record<string, unknown>>;
};
export type EntityCreateOperation = OperationBase & {
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
export type EntityRemoveOperation = OperationBase & {
  readonly type: 'entity.remove';
  readonly ids: readonly string[];
};
export type EntityMoveOperation = OperationBase & {
  readonly type: 'entity.move';
  readonly id: string;
  readonly anchor?: DocumentAnchor;
};
export type ListInsertOperation = OperationBase & {
  readonly type: 'list.insert';
  readonly key: string;
  readonly value: unknown;
  readonly anchor?: DocumentAnchor;
};
export type ListMoveOperation = OperationBase & {
  readonly type: 'list.move';
  readonly key: string;
  readonly anchor?: DocumentAnchor;
};
export type ListRemoveOperation = OperationBase & {
  readonly type: 'list.remove';
  readonly key: string;
};
export type ListReplaceOperation = OperationBase & {
  readonly type: 'list.replace';
  readonly value: readonly unknown[];
  readonly keys: readonly string[];
};
export type TreeInsertOperation = OperationBase & {
  readonly type: 'tree.insert';
  readonly treeNodeId: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly value?: unknown;
};
export type TreeMoveOperation = OperationBase & {
  readonly type: 'tree.move';
  readonly treeNodeId: string;
  readonly parentId?: string;
  readonly index?: number;
};
export type TreeRemoveOperation = OperationBase & {
  readonly type: 'tree.remove';
  readonly treeNodeId: string;
};
export type TreeSetOperation = OperationBase & {
  readonly type: 'tree.set';
  readonly treeNodeId: string;
  readonly value: unknown;
};
export type TreeReplaceOperation = OperationBase & {
  readonly type: 'tree.replace';
  readonly value: unknown;
};

export type DocumentOperation =
  | FieldSetOperation
  | FieldClearOperation
  | ValueClearOperation
  | VariantReplaceOperation
  | DictSetOperation
  | DictDeleteOperation
  | DictReplaceOperation
  | EntityCreateOperation
  | EntityRemoveOperation
  | EntityMoveOperation
  | ListInsertOperation
  | ListMoveOperation
  | ListRemoveOperation
  | ListReplaceOperation
  | TreeInsertOperation
  | TreeMoveOperation
  | TreeRemoveOperation
  | TreeSetOperation
  | TreeReplaceOperation;
