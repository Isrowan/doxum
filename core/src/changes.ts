import type { DocumentAddress, DocumentTreeNode } from './schema';

export type ValueTransition<T = unknown> =
  | { readonly kind: 'added'; readonly after: T }
  | { readonly kind: 'removed'; readonly before: T }
  | { readonly kind: 'updated'; readonly before: T; readonly after: T };
export type MemberChange<T = unknown> = ValueTransition<T> & { readonly key: string };
export type Change =
  | {
      readonly kind: 'members';
      readonly at: DocumentAddress;
      readonly members: readonly MemberChange[];
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
      readonly before: string | null;
      readonly after: string | null;
      readonly nodes: readonly (ValueTransition<DocumentTreeNode<unknown>> & {
        readonly id: string;
      })[];
    }
  | { readonly kind: 'reset'; readonly before: unknown; readonly after: unknown };
/** One reversible, normalized state transition. Addresses are schema addresses. */
export type ChangeSet = { readonly changes: readonly Change[] };
export type ChangeDirection = 'forward' | 'backward';
