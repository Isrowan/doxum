import { createAddressResolver, resolveLocated, type ResolvedAddress } from '../address';
import type { DocumentSchema, DocumentAddress } from '../schema';
import { snapshotValue } from '../schema-value';
import * as issue from './issue';
import type { DocumentOperation } from '../operations';
import { profile } from '../profile';
import type { MutationBatch } from './contract';
import type { MutationIssue } from './issue';
import { execute } from './execute';
import { executeField } from './execute-value';
import { createChangeJournal } from './journal';
import * as operation from './operation';

export type MutationSession<TSchema extends DocumentSchema> = {
  readonly apply: (input: unknown) => MutationIssue | undefined;
  readonly set: (address: DocumentAddress, value: unknown) => MutationIssue | undefined;
  readonly update: (
    address: DocumentAddress,
    transform: (value: unknown) => unknown
  ) => MutationIssue | undefined;
  readonly finish: () => MutationBatch<TSchema>;
  readonly rollback: () => void;
};

export const createMutationSession = <TSchema extends DocumentSchema>(
  root: unknown,
  schema: TSchema,
  options: { readonly copyPayload?: boolean } = {}
): MutationSession<TSchema> => {
  const forwards: DocumentOperation[] = [];
  const inverseOps: DocumentOperation[] = [];
  const journal = createChangeJournal(root);
  const resolver = createAddressResolver(schema, root);
  let state: 'active' | 'finished' | 'rolled-back' = 'active';
  let updating = false;

  const writeField = (
    address: DocumentAddress,
    value: unknown,
    clear: boolean,
    located?: ResolvedAddress,
    normalized?: Extract<DocumentOperation, { type: 'field.set' | 'field.clear' }>
  ): MutationIssue | undefined => {
    if (state !== 'active') throw new Error('Mutation session is closed.');
    if (updating) throw new Error('Field update callbacks cannot perform nested writes.');
    const resolved = located ?? resolver.resolve(address);
    profile.batch.operation();
    profile.batch.entry(1);
    let invalid: MutationIssue | undefined;
    updating = true;
    try {
      invalid = operation.validateField(address, resolved, value, clear);
    } finally {
      updating = false;
    }
    if (invalid) {
      profile.batch.rejected();
      return invalid;
    }
    if (!resolved) throw new Error('Validated field has no location.');
    if (resolved.collection) profile.batch.collectionResolved();
    profile.mutation.executed();
    const existed = Object.prototype.hasOwnProperty.call(resolved.parent, resolved.key);
    if (clear ? !existed : existed && Object.is(resolved.value, value)) return undefined;
    const forward =
      normalized ?? (clear ? operation.fieldClear(address) : operation.fieldSet(address, value));
    const inverse = operation.inverse(
      existed
        ? { type: 'field.set', at: forward.at, value: resolved.value }
        : { type: 'field.clear', at: forward.at }
    );
    const published = operation.publish(forward);
    journal.field(resolved, forward.at, existed);
    executeField(resolved, value, clear);
    forwards.push(published);
    inverseOps.push(inverse);
    profile.mutation.inverse();
    profile.batch.inverse();
    return undefined;
  };

  const rollback = (): void => {
    if (state === 'rolled-back') return;
    for (let inverseIndex = inverseOps.length - 1; inverseIndex >= 0; inverseIndex -= 1) {
      const inverse = inverseOps[inverseIndex];
      const target = resolveLocated(schema, root, inverse.at);
      const result = execute(root, inverse, target, true);
      if (result.status === 'rejected')
        throw new Error(`Document rollback failed: ${result.issue.message}`);
    }
    state = 'rolled-back';
  };

  const applyNormalized = (normalized: DocumentOperation): MutationIssue | undefined => {
    if (state !== 'active') throw new Error('Mutation session is closed.');
    if (updating) throw new Error('Field update callbacks cannot perform nested writes.');
    profile.batch.operation();
    profile.batch.entry(
      normalized.type === 'entity.create'
        ? normalized.entries.length
        : normalized.type === 'entity.remove'
          ? normalized.ids.length
          : 1
    );
    const resolved = resolver.resolve(normalized.at);
    let invalid: MutationIssue | undefined;
    updating = true;
    try {
      invalid = operation.validate(normalized, resolved);
    } finally {
      updating = false;
    }
    if (invalid) {
      profile.batch.rejected();
      return invalid;
    }
    if (resolved?.collection) profile.batch.collectionResolved();
    profile.mutation.executed();
    const result = execute(
      root,
      normalized,
      resolved,
      options.copyPayload === true || operation.requiresPayloadCopy(normalized)
    );
    if (result.status === 'rejected') {
      profile.batch.rejected();
      return result.issue;
    }
    if (result.status === 'unchanged') return undefined;
    resolver.invalidate();

    const published = operation.publish(normalized);
    // Reverse each group on append so reversing the log preserves its internal order.
    for (let index = result.inverse.length - 1; index >= 0; index--) {
      const rawInverse = result.inverse[index];
      const inverse = operation.inverse(rawInverse);
      inverseOps.push(inverse);
      profile.mutation.inverse();
      profile.batch.inverse();
    }
    forwards.push(published);
    try {
      if (!resolved) throw new Error(`Changed operation '${normalized.type}' was not resolved.`);
      journal.record(resolved, normalized, result.inverse);
    } catch (error) {
      rollback();
      throw error;
    }
    return undefined;
  };
  return {
    apply: input => {
      const decoded = operation.decode(input);
      if (decoded.status === 'rejected') {
        profile.batch.operation();
        profile.batch.rejected();
        return decoded.issue;
      }
      const normalized = operation.normalize(decoded.operation);
      if (normalized.type === 'field.set' || normalized.type === 'field.clear')
        return writeField(
          normalized.at,
          normalized.type === 'field.set' ? normalized.value : undefined,
          normalized.type === 'field.clear',
          undefined,
          normalized
        );
      return applyNormalized(normalized);
    },
    set: (address, value) => writeField(address, value, false),
    update: (address, transform) => {
      if (state !== 'active') throw new Error('Mutation session is closed.');
      if (updating) throw new Error('Field update callbacks cannot perform nested writes.');
      const resolved = resolver.resolve(address);
      if (!resolved || resolved.node.kind !== 'field')
        return issue.at(
          address,
          'invalid-address',
          'Field update requires an existing field location.'
        );
      let value: unknown;
      updating = true;
      try {
        value = transform(snapshotValue(resolved.node, resolved.value));
        if (
          value &&
          (typeof value === 'object' || typeof value === 'function') &&
          'then' in value &&
          typeof value.then === 'function'
        )
          throw new TypeError('Field update callbacks must be synchronous.');
      } finally {
        updating = false;
      }
      return writeField(address, value, false, resolved);
    },
    finish: () => {
      if (state !== 'active') throw new Error('Mutation session is closed.');
      const changes = journal.finish();
      state = 'finished';
      if (changes.status === 'unchanged') return { status: 'unchanged' };

      const inverse = inverseOps.slice().reverse();
      return {
        status: 'changed',
        operations: Object.freeze(forwards),
        inverse: Object.freeze(inverse),
        paths: changes.paths,
        collections: changes.collections,
      };
    },
    rollback,
  };
};

export const mutateOperations = <TSchema extends DocumentSchema>(
  root: unknown,
  schema: TSchema,
  operations: unknown,
  options: { readonly copyPayload?: boolean } = {}
): MutationBatch<TSchema> => {
  const decodedBatch = operation.decodeBatch(operations);
  if (decodedBatch.status === 'rejected')
    return { status: 'rejected', issues: Object.freeze([decodedBatch.issue]) };
  const session = createMutationSession(root, schema, options);
  for (const input of decodedBatch.operations) {
    const issue = session.apply(input);
    if (!issue) continue;
    session.rollback();
    return { status: 'rejected', issues: Object.freeze([issue]) };
  }
  return session.finish();
};
