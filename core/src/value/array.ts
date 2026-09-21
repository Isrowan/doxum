/** Allocation-free strict equality for ordered readonly arrays. */
export const sameArray = <T>(left: readonly T[], right: readonly T[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
};

/** Owns an immutable shallow snapshot while reusing arrays that are already frozen. */
export const snapshotArray = <T>(values: readonly T[]): readonly T[] =>
  Object.isFrozen(values) ? values : Object.freeze([...values]);

/** Compares an iterable with an ordered array without materializing the iterable. */
export const iterableMatchesArray = <T>(values: Iterable<T>, expected: readonly T[]): boolean => {
  let index = 0;
  for (const value of values) {
    if (index >= expected.length || value !== expected[index]) return false;
    index++;
  }
  return index === expected.length;
};
