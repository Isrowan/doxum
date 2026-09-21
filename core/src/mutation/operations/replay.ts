import type { ChangeDirection, ChangeSet } from '@/changes';
import type { MutationSession } from '@/mutation/session';
import * as state from '@/mutation/state';
import * as sequence from '@/order/sequence';
import * as issue from '@/mutation/issue';
import * as schemaValue from '@/schema/value';
import * as tree from '@/tree/topology';
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
          return issue.fail(change.at, 'invalid-changes', 'Order requires an ordered container.');
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
        const keys =
          node.kind === 'table' ? Object.keys(container.parent) : state.orderOf(node, current);
        if (!sequence.matches(change.order[side], keys))
          return issue.fail(
            change.at,
            'invalid-changes',
            'Order must contain exactly the resulting keys.'
          );
        state.installOrder(node, current, change.order[side]);
        session.invalidate();
      } else if (membershipChanged && node.kind === 'table') {
        const ids = (current as { ids: string[] }).ids;
        if (!sequence.matches(ids, Object.keys(container.parent)))
          return issue.fail(
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
        if (next !== undefined) {
          const diagnostic = schemaValue.checkTreePayload(
            node.value,
            next,
            change.at.concat(item.id)
          );
          if (diagnostic) issue.invalidValue(diagnostic);
        }
        state.installMember(
          current.nodes,
          item.id,
          next !== undefined,
          next && schemaValue.copyTreeNode(next)
        );
      }
      if (!tree.validate(current))
        return issue.fail(change.at, 'invalid-tree', 'Invalid tree structure.');
      session.invalidate();
    }
  }
}
