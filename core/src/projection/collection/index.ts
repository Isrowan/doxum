import { profile } from '@/profile';
import type { CollectionEntry } from './entry';

type IndexNode<K extends string, V> = {
  readonly key: K;
  readonly value: V;
  readonly height: number;
  readonly left?: IndexNode<K, V>;
  readonly right?: IndexNode<K, V>;
};

const height = <K extends string, V>(node: IndexNode<K, V> | undefined): number =>
  node?.height ?? 0;

const node = <K extends string, V>(
  key: K,
  value: V,
  left?: IndexNode<K, V>,
  right?: IndexNode<K, V>
): IndexNode<K, V> => {
  profile.collectionIndex.node();
  return Object.freeze({
    key,
    value,
    left,
    right,
    height: Math.max(height(left), height(right)) + 1,
  });
};

/** Local repair after a join descent or a single deletion (height difference at most two). */
const balance = <K extends string, V>(
  key: K,
  value: V,
  left?: IndexNode<K, V>,
  right?: IndexNode<K, V>
): IndexNode<K, V> => {
  if (height(left) > height(right) + 1) {
    const heavy = left!;
    if (height(heavy.left) >= height(heavy.right))
      return node(heavy.key, heavy.value, heavy.left, node(key, value, heavy.right, right));
    const middle = heavy.right!;
    return node(
      middle.key,
      middle.value,
      node(heavy.key, heavy.value, heavy.left, middle.left),
      node(key, value, middle.right, right)
    );
  }
  if (height(right) > height(left) + 1) {
    const heavy = right!;
    if (height(heavy.right) >= height(heavy.left))
      return node(heavy.key, heavy.value, node(key, value, left, heavy.left), heavy.right);
    const middle = heavy.left!;
    return node(
      middle.key,
      middle.value,
      node(key, value, left, middle.left),
      node(heavy.key, heavy.value, middle.right, heavy.right)
    );
  }
  return node(key, value, left, right);
};

/** All left keys precede key, all right keys follow it; heights may differ arbitrarily. */
const join = <K extends string, V>(
  key: K,
  value: V,
  left?: IndexNode<K, V>,
  right?: IndexNode<K, V>
): IndexNode<K, V> => {
  if (height(left) > height(right) + 1) {
    profile.collectionIndex.visit();
    return balance(left!.key, left!.value, left!.left, join(key, value, left!.right, right));
  }
  if (height(right) > height(left) + 1) {
    profile.collectionIndex.visit();
    return balance(right!.key, right!.value, join(key, value, left, right!.left), right!.right);
  }
  return node(key, value, left, right);
};

const removeMin = <K extends string, V>(current: IndexNode<K, V>): IndexNode<K, V> | undefined => {
  profile.collectionIndex.visit();
  if (!current.left) return current.right;
  return balance(current.key, current.value, removeMin(current.left), current.right);
};

const concat = <K extends string, V>(
  left: IndexNode<K, V> | undefined,
  right: IndexNode<K, V> | undefined
): IndexNode<K, V> | undefined => {
  if (!left) return right;
  if (!right) return left;
  let first = right;
  while (first.left) {
    profile.collectionIndex.visit();
    first = first.left;
  }
  return join(first.key, first.value, left, removeMin(right));
};

const replace = <K extends string, V>(
  current: IndexNode<K, V>,
  entry: CollectionEntry<V> | undefined,
  left: IndexNode<K, V> | undefined,
  right: IndexNode<K, V> | undefined
): IndexNode<K, V> | undefined => {
  if (entry && !entry.present) return concat(left, right);
  const value = entry ? entry.value : current.value;
  if (left === current.left && right === current.right && Object.is(value, current.value))
    return current;
  return join(current.key, value, left, right);
};

const edit = <K extends string, V>(
  current: IndexNode<K, V> | undefined,
  key: K,
  entry: CollectionEntry<V>
): IndexNode<K, V> | undefined => {
  if (!current) return entry.present ? node(key, entry.value) : undefined;
  profile.collectionIndex.visit();
  if (key === current.key) return replace(current, entry, current.left, current.right);
  // A single edit changes subtree height by at most one; reuse local repair
  // without paying for a general height-aware join on every search ancestor.
  if (key < current.key) {
    const left = edit(current.left, key, entry);
    return left === current.left
      ? current
      : balance(current.key, current.value, left, current.right);
  }
  const right = edit(current.right, key, entry);
  return right === current.right
    ? current
    : balance(current.key, current.value, current.left, right);
};

/** Builds a new subtree in linear time, ignoring removals of absent keys. */
const buildChanges = <K extends string, V>(
  keys: readonly K[],
  changes: ReadonlyMap<K, CollectionEntry<V>>,
  start: number,
  end: number
): IndexNode<K, V> | undefined => {
  let count = 0;
  for (let i = start; i < end; i++) if (changes.get(keys[i])!.present) count++;
  let cursor = start;
  const build = (size: number): IndexNode<K, V> | undefined => {
    if (!size) return undefined;
    const leftSize = size >> 1;
    const left = build(leftSize);
    let key: K;
    let entry: CollectionEntry<V>;
    do {
      key = keys[cursor++];
      entry = changes.get(key)!;
    } while (!entry.present);
    return node(key, entry.value, left, build(size - leftSize - 1));
  };
  return build(count);
};

const applyChanges = <K extends string, V>(
  current: IndexNode<K, V> | undefined,
  keys: readonly K[],
  changes: ReadonlyMap<K, CollectionEntry<V>>,
  start: number,
  end: number
): IndexNode<K, V> | undefined => {
  if (start === end) return current;
  if (end - start === 1) return edit(current, keys[start], changes.get(keys[start])!);
  if (!current) return buildChanges(keys, changes, start, end);
  profile.collectionIndex.visit();
  let low = start;
  let high = end;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle] < current.key) low = middle + 1;
    else high = middle;
  }
  const matched = low < end && keys[low] === current.key;
  const left = applyChanges(current.left, keys, changes, start, low);
  const right = applyChanges(current.right, keys, changes, matched ? low + 1 : low, end);
  return replace(current, matched ? changes.get(current.key)! : undefined, left, right);
};

const fromSorted = <K extends string, V>(
  entries: readonly (readonly [K, V])[],
  start = 0,
  end = entries.length
): IndexNode<K, V> | undefined => {
  if (start >= end) return undefined;
  const middle = (start + end) >>> 1;
  const [key, value] = entries[middle];
  return node(key, value, fromSorted(entries, start, middle), fromSorted(entries, middle + 1, end));
};

/** Immutable keyed lookup used to keep collection snapshots durable across revisions. */
export class PersistentKeyedIndex<K extends string, V> {
  private constructor(private readonly root?: IndexNode<K, V>) {}

  static empty<K extends string, V>(): PersistentKeyedIndex<K, V> {
    return new PersistentKeyedIndex<K, V>();
  }

  /** The input must contain unique keys. Formal collection order is owned separately. */
  static from<K extends string, V>(entries: Iterable<readonly [K, V]>): PersistentKeyedIndex<K, V> {
    const sorted = [...entries].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    profile.collectionIndex.build(sorted.length);
    return new PersistentKeyedIndex(fromSorted(sorted));
  }

  get(key: K): V | undefined {
    let current = this.root;
    while (current) {
      if (key === current.key) return current.value;
      current = key < current.key ? current.left : current.right;
    }
    return undefined;
  }

  has(key: K): boolean {
    let current = this.root;
    while (current) {
      if (key === current.key) return true;
      current = key < current.key ? current.left : current.right;
    }
    return false;
  }

  /** Applies accepted final entry intents together; never calls user equality or changes old roots. */
  apply(changes: ReadonlyMap<K, CollectionEntry<V>>): PersistentKeyedIndex<K, V> {
    if (!changes.size) return this;
    profile.collectionIndex.batch(changes.size > 1 ? changes.size : 0);
    let root: IndexNode<K, V> | undefined;
    if (changes.size === 1) {
      const [key, entry] = changes.entries().next().value!;
      root = edit(this.root, key, entry);
    } else {
      const keys = [...changes.keys()].sort();
      root = applyChanges(this.root, keys, changes, 0, keys.length);
    }
    return root === this.root ? this : new PersistentKeyedIndex(root);
  }
}
