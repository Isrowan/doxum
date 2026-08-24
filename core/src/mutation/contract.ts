import type { DocumentAddress, DocumentSchema } from '../schema';
import type { DocumentOperationUnion } from '../operations';
import type { MutationIssue } from './issue';

export type MutationOutcome =
  | {
      readonly status: 'changed';
      readonly inverse: readonly DocumentOperationUnion[];
    }
  | { readonly status: 'unchanged' }
  | { readonly status: 'rejected'; readonly issue: MutationIssue };

export type MutationCollectionChange = {
  readonly address: DocumentAddress;
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
  readonly updated: ReadonlySet<string>;
  readonly orderChanged: boolean;
};

export type MutationBatch<TSchema extends DocumentSchema = DocumentSchema> =
  | {
      readonly status: 'rejected';
      readonly issues: readonly MutationIssue[];
    }
  | { readonly status: 'unchanged' }
  | {
      readonly status: 'changed';
      readonly operations: readonly DocumentOperationUnion<TSchema>[];
      readonly inverse: readonly DocumentOperationUnion<TSchema>[];
      readonly paths: readonly DocumentAddress[];
      readonly collections: readonly MutationCollectionChange[];
    };
