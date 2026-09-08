import type { Change, ChangeSet, Presence } from '../changes';
import { isPlainObject } from '../value/ownership';
import { AddressIndex } from '../address';
import { fail } from './issue';
import { compareChanges } from './recorder';
import { validNode } from './tree';

const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).every(key => expected.includes(key));
const presence = (value: unknown): value is Presence =>
  isPlainObject(value) &&
  ((value.present === false && keys(value, ['present'])) ||
    (value.present === true && Object.hasOwn(value, 'value') && keys(value, ['present', 'value'])));
const strings = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
};
const order = (value: unknown): value is readonly string[] =>
  strings(value) && new Set(value).size === value.length;

/** The only external ChangeSet decoder. No executor parses transport envelopes. */
export const decodeChanges = (input: unknown): ChangeSet => {
  if (!isPlainObject(input) || !keys(input, ['changes']) || !Array.isArray(input.changes))
    return fail([], 'invalid-changes', 'Expected a ChangeSet.');
  const result: Change[] = [];
  for (const entry of input.changes) {
    if (!isPlainObject(entry) || !strings(entry.at))
      return fail([], 'invalid-changes', 'Change addresses must contain strings.');
    const at = entry.at;
    if (
      entry.kind === 'value' &&
      keys(entry, ['kind', 'at', 'before', 'after']) &&
      presence(entry.before) &&
      presence(entry.after)
    )
      result.push({ kind: 'value', at, before: entry.before, after: entry.after });
    else if (
      entry.kind === 'order' &&
      keys(entry, ['kind', 'at', 'before', 'after']) &&
      order(entry.before) &&
      order(entry.after)
    )
      result.push({ kind: 'order', at, before: [...entry.before], after: [...entry.after] });
    else if (
      entry.kind === 'tree' &&
      keys(entry, ['kind', 'at', 'before', 'after', 'nodes']) &&
      presence(entry.before) &&
      presence(entry.after) &&
      (!entry.before.present || typeof entry.before.value === 'string') &&
      (!entry.after.present || typeof entry.after.value === 'string') &&
      Array.isArray(entry.nodes)
    ) {
      const seen = new Set<string>();
      for (const node of entry.nodes) {
        if (
          !isPlainObject(node) ||
          !keys(node, ['id', 'before', 'after']) ||
          typeof node.id !== 'string' ||
          seen.has(node.id) ||
          !presence(node.before) ||
          !presence(node.after) ||
          (node.before.present && !validNode(node.before.value)) ||
          (node.after.present && !validNode(node.after.value))
        )
          return fail(at, 'invalid-changes', 'Malformed or duplicate tree facts.');
        seen.add(node.id);
      }
      result.push({ ...entry, at } as Change);
    } else return fail(at, 'invalid-changes', 'Unknown or malformed change.');
  }
  const sorted = result.sort(compareChanges);
  // Value replacements absorb descendants; order and entry facts may share a container.
  const index = new AddressIndex<Change>();
  for (const a of sorted) {
    index.query(b => {
      const equal = a.at.length === b.at.length && a.at.every((v, k) => v === b.at[k]);
      if (
        (equal && a.kind === b.kind) ||
        ((a.kind === 'value' || b.kind === 'value') &&
          !(a.kind === 'order' && a.at.length < b.at.length) &&
          !(b.kind === 'order' && b.at.length < a.at.length)) ||
        (equal && (a.kind === 'tree' || b.kind === 'tree'))
      )
        return fail(a.at, 'invalid-changes', 'Duplicate or overlapping change facts.');
    })(a.at);
    index.add(a.at, a);
  }
  return { changes: sorted };
};
