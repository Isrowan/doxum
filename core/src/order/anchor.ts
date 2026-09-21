import type { DocumentAnchor } from '@/schema/model';
import type { KeyOrder, OrderedKeys } from './sequence';

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
  let remainingLength = 0;
  let anchorIndex = -1;
  const anchoredKey =
    position &&
    ('before' in position ? position.before : 'after' in position ? position.after : undefined);
  for (const key of current) {
    if (selected.has(key)) {
      moved.push(key);
      continue;
    }
    if (key === anchoredKey) anchorIndex = remainingLength;
    remainingLength++;
  }
  if (moved.length !== selected.size) return { kind: 'missing' };
  let insertion: number;
  if (!position || ('at' in position && position.at === 'end')) insertion = remainingLength;
  else if ('at' in position) {
    if (position.at !== 'start') return { kind: 'invalid-anchor' };
    insertion = 0;
  } else {
    if (anchorIndex < 0) return { kind: 'invalid-anchor' };
    insertion = 'before' in position ? anchorIndex : anchorIndex + 1;
  }
  const order = new Array<string>(current.length);
  let outputIndex = 0;
  let remainingIndex = 0;
  let inserted = false;
  for (const key of current) {
    if (selected.has(key)) continue;
    if (!inserted && remainingIndex === insertion) {
      for (const movedKey of moved) order[outputIndex++] = movedKey;
      inserted = true;
    }
    order[outputIndex++] = key;
    remainingIndex++;
  }
  if (!inserted) for (const movedKey of moved) order[outputIndex++] = movedKey;
  return { kind: 'ok', order };
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
