import { resolveLocated } from '../address';
import type { DocumentSchema } from '../schema';
import type { DocumentOperationUnion } from '../operations';
import { profile } from '../profile';
import type { MutationBatch } from './contract';
import type { MutationIssue } from './issue';
import { execute } from './execute';
import { createChangeJournal } from './journal';
import * as operation from './operation';

export type MutationSession<TSchema extends DocumentSchema> = {
  readonly apply: (input: unknown) => MutationIssue | undefined;
  readonly finish: () => MutationBatch<TSchema>;
  readonly rollback: () => void;
};

type AppliedStep<TSchema extends DocumentSchema> = {
  readonly forward: DocumentOperationUnion<TSchema>;
  readonly inverse: readonly DocumentOperationUnion<TSchema>[];
};

export const createMutationSession = <TSchema extends DocumentSchema>(
  root: unknown,
  schema: TSchema,
  options: { readonly copyPayload?: boolean } = {}
): MutationSession<TSchema> => {
  const steps: AppliedStep<TSchema>[] = [];
  const journal = createChangeJournal(root);
  let state: 'active' | 'finished' | 'rolled-back' = 'active';

  const rollback = (): void => {
    if (state === 'rolled-back') return;
    for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      for (const inverse of steps[stepIndex].inverse) {
        const target = resolveLocated(schema, root, inverse.at);
        const result = execute(root, inverse, target, true);
        if (result.status === 'rejected')
          throw new Error(`Document rollback failed: ${result.issue.message}`);
      }
    }
    state = 'rolled-back';
  };

  return {
    apply: input => {
      if (state !== 'active') throw new Error('Mutation session is closed.');
      profile.batch.operation();
      const decoded = operation.decode(input);
      if (decoded.status === 'rejected') {
        profile.batch.rejected();
        return decoded.issue;
      }
      const normalized = operation.normalize(decoded.operation as DocumentOperationUnion<TSchema>);
      profile.batch.entry(
        normalized.type === 'entity.create'
          ? normalized.entries.length
          : normalized.type === 'entity.remove'
            ? normalized.ids.length
            : 1
      );
      const resolved = resolveLocated(schema, root, normalized.at);
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

      const published = operation.publish(normalized);
      const group: DocumentOperationUnion<TSchema>[] = [];
      for (const rawInverse of result.inverse) {
        const inverse = operation.inverse(rawInverse as DocumentOperationUnion<TSchema>);
        group.push(inverse);
        profile.mutation.inverse();
        profile.batch.inverse();
      }
      steps.push({ forward: published, inverse: Object.freeze(group) });
      try {
        if (!resolved) throw new Error(`Changed operation '${normalized.type}' was not resolved.`);
        journal.record(resolved, normalized, result.inverse);
      } catch (error) {
        rollback();
        throw error;
      }
      return undefined;
    },
    finish: () => {
      if (state !== 'active') throw new Error('Mutation session is closed.');
      const changes = journal.finish();
      state = 'finished';
      if (changes.status === 'unchanged') return { status: 'unchanged' };

      let inverseCount = 0;
      for (const step of steps) inverseCount += step.inverse.length;
      const inverse = new Array<DocumentOperationUnion<TSchema>>(inverseCount);
      let writeIndex = 0;
      for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1)
        for (const entry of steps[stepIndex].inverse) inverse[writeIndex++] = entry;
      return {
        status: 'changed',
        operations: Object.freeze(steps.map(step => step.forward)),
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
