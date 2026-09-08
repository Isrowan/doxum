import type { DocumentAddress, DocumentAnchor } from '../../schema';
import type { MutationSession } from '../session';
import type { ResolvedContainer } from '../../address';
import * as anchor from '../anchor';
import { fail } from '../issue';
export function insert(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  value: unknown,
  position?: DocumentAnchor
): void {
  const { node, value: current } = container;
  if (node.kind !== 'list') return fail(at, 'invalid-list-key', 'Expected a list.');
  session.validate(node.value, value, at);
  const id = node.keyOf(value);
  if (typeof id !== 'string') return fail(at, 'invalid-list-key', 'List key must be a string.');
  const items = current as unknown[],
    keys = anchor.keys(items, node.keyOf);
  if (keys.index(id) >= 0) return fail(at, 'duplicate-list-item', 'List key already exists.');
  if (!anchor.valid(keys, position)) return fail(at, 'invalid-anchor', 'Unknown list anchor.');
  session.recorder.order(at, node, current);
  session.recorder.member(container, id, session.definition(container, id), -1);
  anchor.insert(items, anchor.index(keys, position), value);
  session.invalidate();
}
export function set(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  id: string,
  value: unknown
): void {
  const { node, value: items } = container;
  if (node.kind !== 'list') return fail(at, 'invalid-list-key', 'Expected a list.');
  const index = anchor.indexedKeys(items as unknown[], node.keyOf).index(id);
  if (index < 0) return fail(at, 'missing-list-item', 'List key does not exist.');
  session.writeLocatedMember(container, id, session.definition(container, id), index, value, 'set');
}
export function remove(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  id: string
): void {
  const { node, value } = container;
  if (node.kind !== 'list') return fail(at, 'missing-list-item', 'List key does not exist.');
  const index = anchor.keys(value as unknown[], node.keyOf).index(id);
  if (index < 0) return fail(at, 'missing-list-item', 'List key does not exist.');
  session.recorder.order(at, node, value);
  session.writeLocatedMember(
    container,
    id,
    session.definition(container, id),
    index,
    undefined,
    'remove'
  );
}
