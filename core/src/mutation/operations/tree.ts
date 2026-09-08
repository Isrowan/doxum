import type { DocumentAddress } from '../../schema';
import type { MutationSession } from '../session';
import type { ResolvedContainer } from '../../address';
import * as tree from '../tree';
export function set(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  id: string,
  value: unknown
): void {
  session.editTree(container, at, (current, node, capture) => {
    session.validate(node.value, value, [...at, id]);
    tree.set(current, id, value, capture, at);
  });
}
export function insert(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  id: string,
  value: unknown,
  position?: tree.TreePosition
): void {
  session.editTree(container, at, (current, node, capture) => {
    session.validate(node.value, value, [...at, id]);
    tree.insert(current, id, value, position, capture, at);
  });
}
export function remove(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  id: string
): void {
  session.editTree(container, at, (current, _node, capture) =>
    tree.remove(current, id, capture, at)
  );
}
export function move(
  session: MutationSession,
  container: ResolvedContainer,
  at: DocumentAddress,
  id: string,
  position?: tree.TreePosition
): void {
  session.editTree(container, at, (current, _node, capture) =>
    tree.move(current, id, position, capture, at)
  );
}
