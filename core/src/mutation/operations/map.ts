import type { MutationSession } from '../session';
import type { ResolvedContainer } from '../../address/resolve';
import * as issue from '../issue';

export function put(
  session: MutationSession,
  container: ResolvedContainer,
  id: string,
  value: unknown
): void {
  if (container.node.kind !== 'map')
    return issue.fail(container.at, 'invalid-collection', 'Expected a map.');
  session.writeMember(container, id, value, 'set');
}

export function remove(session: MutationSession, container: ResolvedContainer, id: string): void {
  if (container.node.kind !== 'map')
    return issue.fail(container.at, 'invalid-collection', 'Expected a map.');
  session.writeMember(container, id, undefined, 'remove');
}
