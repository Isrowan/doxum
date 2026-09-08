import type { DocumentAddress, DocumentTreeNode } from './schema';

export type Presence<T = unknown> =
  { readonly present: false } | { readonly present: true; readonly value: T };
export type Change =
  | {
      readonly kind: 'value';
      readonly at: DocumentAddress;
      readonly before: Presence;
      readonly after: Presence;
    }
  | {
      readonly kind: 'order';
      readonly at: DocumentAddress;
      readonly before: readonly string[];
      readonly after: readonly string[];
    }
  | {
      readonly kind: 'tree';
      readonly at: DocumentAddress;
      readonly before: Presence<string>;
      readonly after: Presence<string>;
      readonly nodes: readonly {
        readonly id: string;
        readonly before: Presence<DocumentTreeNode<unknown>>;
        readonly after: Presence<DocumentTreeNode<unknown>>;
      }[];
    };
/** One reversible, normalized state transition. Addresses are schema addresses. */
export type ChangeSet = { readonly changes: readonly Change[] };
export type ChangeDirection = 'forward' | 'backward';
