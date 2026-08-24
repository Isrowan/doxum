import type { DocumentAnchor } from '../operations';

export type KeyOrder = {
  readonly length: number;
  readonly at: (index: number) => string | undefined;
  readonly index: (key: string) => number;
};

type Keys = readonly string[] | KeyOrder;

const length = (keys: Keys): number => keys.length;
const keyAt = (keys: Keys, index: number): string | undefined =>
  Array.isArray(keys) ? keys[index] : keys.at(index);
const keyIndex = (keys: Keys, key: string): number =>
  Array.isArray(keys) ? keys.indexOf(key) : (keys as KeyOrder).index(key);

export const keys = (values: readonly unknown[], keyOf: (value: unknown) => string): KeyOrder => ({
  length: values.length,
  at: index => (index >= 0 && index < values.length ? keyOf(values[index]) : undefined),
  index: key => {
    for (let index = 0; index < values.length; index += 1)
      if (keyOf(values[index]) === key) return index;
    return -1;
  },
});

export const index = (keys: Keys, anchor?: DocumentAnchor): number => {
  if (!anchor) return length(keys);
  if ('at' in anchor) return anchor.at === 'start' ? 0 : length(keys);
  if ('before' in anchor) return keyIndex(keys, anchor.before);
  return keyIndex(keys, anchor.after) + 1;
};

export const at = (keys: Keys, position: number): DocumentAnchor =>
  position <= 0 ? { at: 'start' } : { after: keyAt(keys, position - 1) as string };

export const valid = (keys: Keys, anchor?: DocumentAnchor): boolean => {
  if (!anchor) return true;
  if (typeof anchor !== 'object' || anchor === null) return false;
  if (Number('at' in anchor) + Number('before' in anchor) + Number('after' in anchor) !== 1)
    return false;
  if ('at' in anchor) return anchor.at === 'start' || anchor.at === 'end';
  return keyIndex(keys, 'before' in anchor ? anchor.before : anchor.after) >= 0;
};

export const afterRemove = (keys: Keys, removedIndex: number, anchor?: DocumentAnchor): number => {
  const position = index(keys, anchor);
  return position > removedIndex ? position - 1 : position;
};

export const validPositions = (length: number, positions: readonly number[]): boolean => {
  let previous = -1;
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position <= previous ||
      position > length + index
    )
      return false;
    previous = position;
  }
  return true;
};

export const restore = (
  keys: string[],
  inserted: readonly string[],
  positions: readonly number[]
): void => {
  const currentLength = keys.length;
  if (inserted.length !== positions.length || !validPositions(currentLength, positions))
    throw new Error('Ordered restore positions are invalid.');
  let readIndex = currentLength - 1;
  let insertedIndex = inserted.length - 1;
  keys.length = currentLength + inserted.length;
  for (let writeIndex = keys.length - 1; writeIndex >= 0; writeIndex -= 1) {
    if (insertedIndex >= 0 && positions[insertedIndex] === writeIndex) {
      keys[writeIndex] = inserted[insertedIndex];
      insertedIndex -= 1;
    } else {
      keys[writeIndex] = keys[readIndex];
      readIndex -= 1;
    }
  }
};
