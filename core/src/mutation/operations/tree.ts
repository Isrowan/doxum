import type { DocumentAddress } from '../../schema';
import type { MutationSession } from '../session';
import * as tree from '../tree';
export function set(
  session: MutationSession,
  at: DocumentAddress,
  id: string,
  value: unknown
): void {
  session.editTree(at, (current, node, capture) => {
    session.validate(node.value, value, [...at, id]);
    tree.set(current, id, value, capture, at);
  });
}
export function insert(
  session: MutationSession,
  at: DocumentAddress,
  id: string,
  value: unknown,
  position?: tree.TreePosition
): void {
  session.editTree(at, (current, node, capture) => {
    session.validate(node.value, value, [...at, id]);
    tree.insert(current, id, value, position, capture, at);
  });
}
export function remove(session: MutationSession, at: DocumentAddress, id: string): void {
  session.editTree(at, (current, _node, capture) => tree.remove(current, id, capture, at));
}
export function move(
  session: MutationSession,
  at: DocumentAddress,
  id: string,
  position?: tree.TreePosition
): void {
  session.editTree(at, (current, _node, capture) => tree.move(current, id, position, capture, at));
}
