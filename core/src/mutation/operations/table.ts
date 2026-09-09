import type { DocumentAnchor } from '../../schema';
import type { MutationSession } from '../session';
import type { ResolvedContainer } from '../../address';
import * as anchor from '../anchor';
import { fail } from '../issue';
export function create(
  session: MutationSession,
  container: ResolvedContainer,
  entries: readonly { id: string; value: unknown }[],
  position?: DocumentAnchor
): void {
  const { at, node, value } = container;
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
  const index = anchor.index(table.ids, position);
  for (const entry of entries) session.writeMember(container, entry.id, entry.value, 'set');
  const length = table.ids.length;
  table.ids.length += entries.length;
  table.ids.copyWithin(index + entries.length, index, length);
  for (let i = 0; i < entries.length; i++) table.ids[index + i] = entries[i].id;
}
export function remove(
  session: MutationSession,
  container: ResolvedContainer,
  ids: readonly string[]
): void {
  const { at, node, value } = container;
  if (node.kind !== 'table') return fail(at, 'invalid-collection', 'Expected a table.');
  const table = value as { ids: string[]; byId: Record<string, unknown> };
  for (const id of ids)
    if (!Object.hasOwn(table.byId, id))
      return fail(at, 'missing-entity', 'Table key does not exist.');
  if (!ids.length) return;
  const removed = new Set(ids);
  for (const id of removed) session.writeMember(container, id, undefined, 'remove');
  table.ids = table.ids.filter(id => !removed.has(id));
}
