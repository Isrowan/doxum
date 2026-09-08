import type { DocumentAddress, DocumentAnchor } from '../../schema';
import type { MutationSession } from '../session';
import type { ResolvedContainer } from '../../address';
import * as anchor from '../anchor';
import { fail } from '../issue';
export function create(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  entries: readonly { id: string; value: unknown }[],
  position?: DocumentAnchor
): void {
  const { node, value } = container;
  if (node.kind !== 'table') return fail(at, 'invalid-collection', 'Expected a table.');
  const table = value as { ids: string[]; byId: Record<string, unknown> };
  if (!anchor.valid(table.ids, position))
    return fail(at, 'invalid-anchor', 'Unknown table anchor.');
  const ids = new Set<string>();
  for (const entry of entries) {
    if (Object.hasOwn(table.byId, entry.id) || ids.has(entry.id))
      return fail(at, 'duplicate-entity', 'Table key already exists.');
    ids.add(entry.id);
  }
  if (!entries.length) return;
  session.recorder.order(at, node, value);
  const index = anchor.index(table.ids, position);
  for (const entry of entries)
    session.writeLocatedMember(
      container,
      entry.id,
      session.definition(container, entry.id),
      entry.id,
      entry.value,
      'set'
    );
  const length = table.ids.length;
  table.ids.length += entries.length;
  table.ids.copyWithin(index + entries.length, index, length);
  for (let i = 0; i < entries.length; i++) table.ids[index + i] = entries[i].id;
}
export function remove(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  ids: readonly string[]
): void {
  const { node, value } = container;
  if (node.kind !== 'table') return fail(at, 'invalid-collection', 'Expected a table.');
  const table = value as { ids: string[]; byId: Record<string, unknown> };
  for (const id of ids)
    if (!Object.hasOwn(table.byId, id))
      return fail(at, 'missing-entity', 'Table key does not exist.');
  if (!ids.length) return;
  session.recorder.order(at, node, value);
  const removed = new Set(ids);
  for (const id of removed)
    session.writeLocatedMember(
      container,
      id,
      session.definition(container, id),
      id,
      undefined,
      'remove'
    );
  table.ids = table.ids.filter(id => !removed.has(id));
}
