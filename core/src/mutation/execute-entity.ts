import type { ResolvedAddress } from '../address';
import type { DocumentOperationUnion, EntityCreateOperation } from '../operations';
import type { DocumentNode } from '../schema';
import type { MutationOutcome } from './contract';
import * as anchor from './anchor';
import type { MutationIssueCode } from './issue';
import * as issue from './issue';
import { cloneValue, isRecord, transferPayload } from '../value/ownership';

type EntityOperation = Extract<
  DocumentOperationUnion,
  { type: 'entity.create' | 'entity.remove' | 'entity.move' }
>;

type EntityNode = Extract<DocumentNode, { readonly kind: 'table' | 'map' }>;

export type EntityCollection =
  | {
      readonly kind: 'table';
      readonly ids: string[];
      readonly byId: Record<string, unknown>;
    }
  | {
      readonly kind: 'map';
      readonly byId: Record<string, unknown>;
    };

export type EntityCollectionResolution =
  | { readonly status: 'resolved'; readonly collection: EntityCollection }
  | { readonly status: 'invalid' };

export const resolveEntityCollection = (
  node: EntityNode,
  value: unknown
): EntityCollectionResolution => {
  if (node.kind === 'table') {
    if (!isRecord(value) || !Array.isArray(value.ids) || !isRecord(value.byId))
      return { status: 'invalid' };
    // Table ids are canonical schema data. Validating every existing id for
    // each operation would turn a constant-address mutation into a full
    // collection scan; operation semantics validate the ids they touch.
    const ids = value.ids as string[];
    return {
      status: 'resolved',
      collection: { kind: 'table', ids, byId: value.byId },
    };
  }
  return isRecord(value)
    ? { status: 'resolved', collection: { kind: 'map', byId: value } }
    : { status: 'invalid' };
};

const rejected = (
  operation: EntityOperation,
  code: MutationIssueCode,
  message: string
): MutationOutcome => ({
  status: 'rejected',
  issue: issue.from(operation, code, message),
});

export const executeEntity = (
  target: ResolvedAddress,
  operation: EntityOperation,
  copyPayload: boolean
): MutationOutcome => {
  if (target.node.kind !== 'table' && target.node.kind !== 'map')
    return rejected(operation, 'invalid-address', 'Collection target is invalid.');
  const resolution = resolveEntityCollection(target.node, target.value);
  if (resolution.status === 'invalid')
    return rejected(operation, 'invalid-address', 'Collection target is invalid.');
  const collection = resolution.collection;
  const ids = collection.kind === 'table' ? collection.ids : undefined;
  if (operation.type === 'entity.move' && collection.kind === 'map')
    return rejected(operation, 'invalid-operation', 'Map entries are unordered.');
  const byId = collection.byId;

  if (operation.type === 'entity.create') {
    if (operation.entries.length === 0) return { status: 'unchanged' };
    const seen = new Set<string>();
    for (const entry of operation.entries) {
      if (seen.has(entry.id))
        return rejected(operation, 'duplicate-entity', 'Entity ids must be unique within a batch.');
      seen.add(entry.id);
      if (Object.prototype.hasOwnProperty.call(byId, entry.id))
        return rejected(operation, 'duplicate-entity', `Entity '${entry.id}' already exists.`);
    }
    if (collection.kind === 'map' && (operation.anchor || operation.positions))
      return rejected(operation, 'invalid-anchor', 'Map entries do not support ordering metadata.');
    if (ids && operation.positions) {
      if (
        operation.positions.length !== operation.entries.length ||
        !anchor.validPositions(ids.length, operation.positions)
      )
        return rejected(operation, 'invalid-operation', 'Entity restore positions are invalid.');
    } else if (ids && !anchor.valid(ids, operation.anchor))
      return rejected(operation, 'invalid-anchor', 'Collection anchor is invalid.');

    for (const entry of operation.entries)
      byId[entry.id] = copyPayload
        ? cloneValue(entry.value, 'canonical')
        : transferPayload(entry.value);
    if (ids) {
      if (operation.positions) {
        anchor.restore(
          ids,
          operation.entries.map(entry => entry.id),
          operation.positions
        );
      } else {
        if (!operation.anchor || ('at' in operation.anchor && operation.anchor.at === 'end')) {
          for (const entry of operation.entries) ids.push(entry.id);
        } else {
          const insertion = anchor.index(ids, operation.anchor);
          const currentLength = ids.length;
          ids.length = currentLength + operation.entries.length;
          for (let index = currentLength - 1; index >= insertion; index -= 1)
            ids[index + operation.entries.length] = ids[index];
          for (let index = 0; index < operation.entries.length; index += 1)
            ids[insertion + index] = operation.entries[index].id;
        }
      }
    }
    return {
      status: 'changed',
      inverse: [
        {
          type: 'entity.remove',
          at: operation.at,
          ids: operation.entries.map(entry => entry.id),
        },
      ],
    };
  }

  if (operation.type === 'entity.remove') {
    if (operation.ids.length === 0) return { status: 'unchanged' };
    const seen = new Set<string>();
    for (const id of operation.ids) {
      if (seen.has(id))
        return rejected(operation, 'duplicate-entity', 'Entity ids must be unique within a batch.');
      seen.add(id);
      if (!Object.prototype.hasOwnProperty.call(byId, id))
        return rejected(operation, 'missing-entity', `Entity '${id}' does not exist.`);
    }

    const entries: { id: string; value: unknown }[] = [];
    const positions: number[] = [];
    if (ids) {
      const positionsById = new Map<string, number>();
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        if (seen.has(id)) positionsById.set(id, index);
      }
      for (const id of operation.ids)
        if (!positionsById.has(id))
          return rejected(operation, 'invalid-collection', `Collection index is missing '${id}'.`);

      let writeIndex = 0;
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        if (seen.has(id)) {
          entries.push({ id, value: cloneValue(byId[id], 'inverse') });
          positions.push(index);
          delete byId[id];
        } else {
          ids[writeIndex++] = id;
        }
      }
      ids.length = writeIndex;
    } else {
      for (const id of operation.ids) {
        entries.push({ id, value: cloneValue(byId[id], 'inverse') });
        delete byId[id];
      }
    }
    const inverse: EntityCreateOperation = {
      type: 'entity.create',
      at: operation.at,
      entries,
      ...(ids ? { positions } : {}),
    };
    return { status: 'changed', inverse: [inverse] };
  }

  const exists = Object.prototype.hasOwnProperty.call(byId, operation.id);
  const position = ids?.indexOf(operation.id) ?? -1;
  if (!exists)
    return rejected(operation, 'missing-entity', `Entity '${operation.id}' does not exist.`);
  if (!ids || position < 0)
    return rejected(
      operation,
      'invalid-collection',
      `Collection index is missing '${operation.id}'.`
    );
  if (!anchor.valid(ids, operation.anchor))
    return rejected(operation, 'invalid-anchor', 'Collection anchor is invalid.');
  if (
    operation.anchor &&
    (('before' in operation.anchor && operation.anchor.before === operation.id) ||
      ('after' in operation.anchor && operation.anchor.after === operation.id))
  )
    return rejected(operation, 'invalid-anchor', 'An entity cannot be moved relative to itself.');
  const nextIndex = anchor.afterRemove(ids, position, operation.anchor);
  if (nextIndex === position) return { status: 'unchanged' };
  const inverse: DocumentOperationUnion = {
    type: 'entity.move',
    at: operation.at,
    id: operation.id,
    anchor: anchor.at(ids, position),
  };
  ids.splice(position, 1);
  ids.splice(nextIndex, 0, operation.id);
  return { status: 'changed', inverse: [inverse] };
};
