import type { DocumentAnchor } from '../../schema';
import type { MutationSession } from '../session';
import type { ResolvedContainer } from '../../address';
import * as anchor from '../anchor';
import { fail } from '../issue';

const assertOrdered = (
  container: ResolvedContainer
): Extract<ResolvedContainer['node'], { kind: 'table' | 'list' }> => {
  const { at, node } = container;
  if (node.kind !== 'table' && node.kind !== 'list')
    return fail(at, 'invalid-collection', 'Expected an ordered container.');
  return node;
};

const plannedOrder = (
  at: ResolvedContainer['at'],
  current: readonly string[],
  selection: readonly string[],
  position?: DocumentAnchor
): readonly string[] => {
  const plan = anchor.moveSelection(current, selection, position);
  switch (plan.kind) {
    case 'ok':
      return plan.order;
    case 'duplicate':
      return fail(at, 'invalid-key', 'Moved keys must be unique.');
    case 'missing':
      return fail(at, 'missing-entity', 'Ordered key does not exist.');
    case 'invalid-anchor':
      return fail(at, 'invalid-anchor', 'Unknown order anchor.');
  }
};

export function move(
  session: MutationSession,
  container: ResolvedContainer,
  ids: string | readonly string[],
  position?: DocumentAnchor
): void {
  const node = assertOrdered(container);
  const selection = typeof ids === 'string' ? [ids] : ids;
  if (!selection.length) return;

  if (node.kind === 'table') {
    const order = (container.value as { ids: string[] }).ids;
    const next = plannedOrder(container.at, order, selection, position);
    if (anchor.equal(order, next)) return;
    session.recorder.order(container);
    anchor.installKeys(order, next);
  } else {
    const items = container.value as unknown[];
    const sequence = anchor.listSequence(items, node.keyOf);
    const next = plannedOrder(container.at, sequence.order, selection, position);
    if (anchor.equal(sequence.order, next)) return;
    session.recorder.order(container);
    anchor.installList(items, node.keyOf, sequence, next);
  }
  session.invalidate();
}

export function reorder(
  session: MutationSession,
  container: ResolvedContainer,
  next: readonly string[]
): void {
  const node = assertOrdered(container);
  if (node.kind === 'table') {
    const current = (container.value as { ids: string[] }).ids;
    if (!anchor.matches(next, current))
      return fail(container.at, 'invalid-collection', 'Order must contain every key exactly once.');
    if (anchor.equal(current, next)) return;
    session.recorder.order(container);
    anchor.installKeys(current, next);
  } else {
    const items = container.value as unknown[];
    const sequence = anchor.listSequence(items, node.keyOf);
    if (!anchor.matches(next, sequence.order))
      return fail(container.at, 'invalid-collection', 'Order must contain every key exactly once.');
    if (anchor.equal(sequence.order, next)) return;
    session.recorder.order(container);
    anchor.installList(items, node.keyOf, sequence, next);
  }
  session.invalidate();
}
