import type { ChangeDirection, ChangeSet } from '../../changes';
import type { MutationSession } from '../session';
import { installOrder, installMember, orderOf } from '../state';
import * as anchor from '../anchor';
import { fail } from '../issue';
export function apply(
  session: MutationSession,
  changes: ChangeSet,
  direction: ChangeDirection
): void {
  const side = direction === 'forward' ? 'after' : 'before';
  for (const change of changes.changes) {
    if (change.kind === 'reset') {
      session.replace([], change[side]);
    } else if (change.kind === 'members') {
      const container = session.resolveContainer(change.at);
      const { node, value: current } = container;
      if (change.order) {
        if (node.kind !== 'table' && node.kind !== 'list')
          return fail(change.at, 'invalid-changes', 'Order requires an ordered container.');
        session.recorder.order(container);
      }
      let membershipChanged = false;
      for (const member of change.members) {
        const present = side === 'after' ? member.kind !== 'removed' : member.kind !== 'added';
        const value =
          side === 'after'
            ? member.kind !== 'removed'
              ? member.after
              : undefined
            : member.kind !== 'added'
              ? member.before
              : undefined;
        membershipChanged =
          session.writeMember(container, member.key, value, present ? 'set' : 'remove') ||
          membershipChanged;
      }
      if (change.order) {
        const keys = node.kind === 'table' ? Object.keys(container.parent) : orderOf(node, current);
        if (!anchor.matches(change.order[side], keys))
          return fail(
            change.at,
            'invalid-changes',
            'Order must contain exactly the resulting keys.'
          );
        installOrder(node, current, change.order[side]);
        session.invalidate();
      } else if (membershipChanged && node.kind === 'table') {
        const ids = (current as { ids: string[] }).ids;
        if (!anchor.matches(ids, Object.keys(container.parent)))
          return fail(
            change.at,
            'invalid-changes',
            'Table membership changes require a matching order.'
          );
      }
    } else {
      const container = session.resolveTree(change.at);
      const { value: current, node } = container;
      session.recorder.tree(container);
      for (const item of change.nodes) session.recorder.tree(container, item.id);
      const root = change[side];
      if (root === null) delete current.rootId;
      else current.rootId = root;
      for (const item of change.nodes) {
        const next =
          side === 'after'
            ? item.kind !== 'removed'
              ? item.after
              : undefined
            : item.kind !== 'added'
              ? item.before
              : undefined;
        installMember(
          current.nodes,
          item.id,
          next !== undefined,
          next && { ...next, children: [...next.children] }
        );
      }
      session.validate(node, current, change.at);
      session.invalidate();
    }
  }
}
