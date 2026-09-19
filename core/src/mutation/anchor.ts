import type { KeyOrder, OrderedKeys } from '../ordered-key';
import type { DocumentAnchor } from '../schema';

type MoveSelection =
  | { readonly kind: 'ok'; readonly order: readonly string[] }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid-anchor' };

const length = (keys: OrderedKeys): number => keys.length;
const keyIndex = (keys: OrderedKeys, key: string): number =>
  Array.isArray(keys) ? keys.indexOf(key) : (keys as KeyOrder).index(key);

/** Plan one relative move against the order that remains after removing the selection. */
export const moveSelection = (
  current: readonly string[],
  selection: readonly string[],
  position?: DocumentAnchor
): MoveSelection => {
  if (!selection.length) return { kind: 'ok', order: current };
  const selected = new Set<string>();
  for (const key of selection) {
    if (selected.has(key)) return { kind: 'duplicate' };
    selected.add(key);
  }
  const moved: string[] = [];
  const remaining: string[] = [];
  for (const key of current) (selected.has(key) ? moved : remaining).push(key);
  if (moved.length !== selected.size) return { kind: 'missing' };
  if (!valid(remaining, position)) return { kind: 'invalid-anchor' };
  const insertion = index(remaining, position);
  return {
    kind: 'ok',
    order: [...remaining.slice(0, insertion), ...moved, ...remaining.slice(insertion)],
  };
};

export const index = (keys: OrderedKeys, anchor?: DocumentAnchor): number => {
  if (!anchor) return length(keys);
  if ('at' in anchor) return anchor.at === 'start' ? 0 : length(keys);
  if ('before' in anchor) return keyIndex(keys, anchor.before);
  return keyIndex(keys, anchor.after) + 1;
};

export const valid = (keys: OrderedKeys, anchor?: DocumentAnchor): boolean => {
  if (!anchor) return true;
  if (typeof anchor !== 'object' || anchor === null) return false;
  if (Number('at' in anchor) + Number('before' in anchor) + Number('after' in anchor) !== 1)
    return false;
  if ('at' in anchor) return anchor.at === 'start' || anchor.at === 'end';
  return keyIndex(keys, 'before' in anchor ? anchor.before : anchor.after) >= 0;
};
