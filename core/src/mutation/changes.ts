import type { Change, ChangeSet, MemberChange, ValueTransition } from '../changes';
import { isPlainObject } from '../value/ownership';
import { AddressIndex } from '../address';
import { fail } from './issue';
import { compareChanges } from './recorder';
import { validNode } from './tree';

const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).every(key => expected.includes(key));
const strings = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
};
const order = (value: unknown): value is readonly string[] =>
  strings(value) && new Set(value).size === value.length;
const transition = (
  value: unknown,
  key: 'key' | 'id'
): value is ValueTransition & Record<string, unknown> => {
  if (!isPlainObject(value) || typeof value[key] !== 'string') return false;
  if (value.kind === 'added')
    return keys(value, ['kind', key, 'after']) && Object.hasOwn(value, 'after');
  if (value.kind === 'removed')
    return keys(value, ['kind', key, 'before']) && Object.hasOwn(value, 'before');
  return (
    value.kind === 'updated' &&
    keys(value, ['kind', key, 'before', 'after']) &&
    Object.hasOwn(value, 'before') &&
    Object.hasOwn(value, 'after')
  );
};
const lexical = (a: string, b: string) => (a < b ? -1 : a === b ? 0 : 1);

/** The sole unknown ChangeSet boundary, including normalized logical-address conflicts. */
export const decodeChanges = (input: unknown): ChangeSet => {
  if (!isPlainObject(input) || !keys(input, ['changes']) || !Array.isArray(input.changes))
    return fail([], 'invalid-changes', 'Expected a ChangeSet.');
  const result: Change[] = [];
  for (const entry of input.changes) {
    if (!isPlainObject(entry)) return fail([], 'invalid-changes', 'Expected a change.');
    if (entry.kind === 'reset') {
      if (
        input.changes.length !== 1 ||
        !keys(entry, ['kind', 'before', 'after']) ||
        !Object.hasOwn(entry, 'before') ||
        !Object.hasOwn(entry, 'after')
      )
        return fail(
          [],
          'invalid-changes',
          'A reset must be the only change and contain both values.'
        );
      return { changes: [{ kind: 'reset', before: entry.before, after: entry.after }] };
    }
    if (!strings(entry.at))
      return fail([], 'invalid-changes', 'Change addresses must contain strings.');
    const at = entry.at;
    if (
      entry.kind === 'members' &&
      keys(entry, ['kind', 'at', 'members']) &&
      Array.isArray(entry.members) &&
      entry.members.length
    ) {
      const seen = new Set<string>();
      const members: MemberChange[] = [];
      for (const member of entry.members) {
        if (!transition(member, 'key') || typeof member.key !== 'string' || seen.has(member.key))
          return fail(at, 'invalid-changes', 'Malformed or duplicate member transition.');
        seen.add(member.key);
        members.push({ ...member, key: member.key });
      }
      result.push({ kind: 'members', at, members: members.sort((a, b) => lexical(a.key, b.key)) });
    } else if (
      entry.kind === 'order' &&
      keys(entry, ['kind', 'at', 'before', 'after']) &&
      order(entry.before) &&
      order(entry.after)
    ) {
      result.push({ kind: 'order', at, before: entry.before, after: entry.after });
    } else if (
      entry.kind === 'tree' &&
      keys(entry, ['kind', 'at', 'before', 'after', 'nodes']) &&
      (entry.before === null || typeof entry.before === 'string') &&
      (entry.after === null || typeof entry.after === 'string') &&
      Array.isArray(entry.nodes)
    ) {
      const seen = new Set<string>();
      for (const node of entry.nodes) {
        if (
          !transition(node, 'id') ||
          typeof node.id !== 'string' ||
          seen.has(node.id) ||
          (node.kind !== 'added' && !validNode(node.before)) ||
          (node.kind !== 'removed' && !validNode(node.after))
        )
          return fail(at, 'invalid-changes', 'Malformed or duplicate tree transition.');
        seen.add(node.id);
      }
      const nodes = entry.nodes as Extract<Change, { kind: 'tree' }>['nodes'];
      result.push({
        kind: 'tree',
        at,
        before: entry.before,
        after: entry.after,
        nodes: [...nodes].sort((a, b) => lexical(a.id, b.id)),
      });
    } else return fail(at, 'invalid-changes', 'Unknown or malformed change.');
  }
  const sorted = result.sort(compareChanges);
  const groups = new AddressIndex<true>();
  const replacements = new AddressIndex<true>();
  const orders = new AddressIndex<true>();
  for (const change of sorted) {
    if (change.kind === 'reset') continue;
    if (change.kind === 'members') {
      if (groups.exact(change.at)?.size)
        return fail(change.at, 'invalid-changes', 'Duplicate member group.');
      groups.add(change.at, true);
      for (const member of change.members) {
        const at = change.at.concat(member.key);
        if (replacements.overlaps(at) || orders.hasDescendant(at))
          return fail(at, 'invalid-changes', 'Overlapping member transitions.');
        replacements.add(at, true);
      }
    } else if (change.kind === 'tree') {
      if (replacements.overlaps(change.at) || orders.hasDescendant(change.at))
        return fail(change.at, 'invalid-changes', 'Overlapping tree transitions.');
      replacements.add(change.at, true);
    } else {
      if (orders.exact(change.at)?.size || replacements.hasAncestor(change.at))
        return fail(change.at, 'invalid-changes', 'Duplicate or overlapping order.');
      orders.add(change.at, true);
    }
  }
  return { changes: sorted };
};

export const changeCount = (changes: ChangeSet): number => {
  let count = 0;
  for (const change of changes.changes)
    count +=
      change.kind === 'members'
        ? change.members.length
        : change.kind === 'tree'
          ? 1 + change.nodes.length
          : 1;
  return count;
};
