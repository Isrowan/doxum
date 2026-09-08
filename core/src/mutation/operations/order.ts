import type { DocumentAddress, DocumentAnchor } from '../../schema';
import type { MutationSession } from '../session';
import * as anchor from '../anchor';
import { fail } from '../issue';
export function move(
  session: MutationSession,
  at: DocumentAddress,
  id: string,
  position?: DocumentAnchor
): void {
  const { node, value } = session.resolveValue(at);
  if (node.kind !== 'table' && node.kind !== 'list')
    return fail(at, 'invalid-collection', 'Expected an ordered container.');
  const items = node.kind === 'table' ? (value as { ids: string[] }).ids : (value as unknown[]);
  const keys = node.kind === 'table' ? (items as string[]) : anchor.keys(items, node.keyOf);
  const index =
    node.kind === 'table' ? (items as string[]).indexOf(id) : (keys as anchor.KeyOrder).index(id);
  if (index < 0) return fail(at, 'missing-entity', 'Ordered key does not exist.');
  if (!anchor.valid(keys, position)) return fail(at, 'invalid-anchor', 'Unknown order anchor.');
  const next = anchor.afterRemove(keys, index, position);
  if (next === index) return;
  session.recorder.order(at, node, value);
  anchor.move(items, index, next);
  session.invalidate();
}
