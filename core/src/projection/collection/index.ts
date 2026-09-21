import { profile } from '@/profile';

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

const rotateLeft = <K extends string, V>(current: IndexNode<K, V>): IndexNode<K, V> => {
  const right = current.right!;
  return node(
    right.key,
    right.value,
    node(current.key, current.value, current.left, right.left),
    right.right
  );
};

const rotateRight = <K extends string, V>(current: IndexNode<K, V>): IndexNode<K, V> => {
  const left = current.left!;
  return node(
    left.key,
    left.value,
    left.left,
    node(current.key, current.value, left.right, current.right)
  );
};

const rebalance = <K extends string, V>(current: IndexNode<K, V>): IndexNode<K, V> => {
  const balance = height(current.left) - height(current.right);
  if (balance > 1) {
    if (height(current.left!.left) < height(current.left!.right))
      return rotateRight(
        node(current.key, current.value, rotateLeft(current.left!), current.right)
      );
    return rotateRight(current);
  }
  if (balance < -1) {
    if (height(current.right!.right) < height(current.right!.left))
      return rotateLeft(
        node(current.key, current.value, current.left, rotateRight(current.right!))
      );
    return rotateLeft(current);
  }
  return current;
};

const setNode = <K extends string, V>(
  current: IndexNode<K, V> | undefined,
  key: K,
  value: V
): IndexNode<K, V> => {
  if (!current) return node(key, value);
  if (key === current.key) return node(key, value, current.left, current.right);
  if (key < current.key)
    return rebalance(
      node(current.key, current.value, setNode(current.left, key, value), current.right)
    );
  return rebalance(
    node(current.key, current.value, current.left, setNode(current.right, key, value))
  );
};

const minNode = <K extends string, V>(current: IndexNode<K, V>): IndexNode<K, V> =>
  current.left ? minNode(current.left) : current;

const removeNode = <K extends string, V>(
  current: IndexNode<K, V> | undefined,
  key: K
): IndexNode<K, V> | undefined => {
  if (!current) return undefined;
  if (key < current.key)
    return rebalance(
      node(current.key, current.value, removeNode(current.left, key), current.right)
    );
  if (key > current.key)
    return rebalance(
      node(current.key, current.value, current.left, removeNode(current.right, key))
    );
  if (!current.left) return current.right;
  if (!current.right) return current.left;
  const next = minNode(current.right);
  return rebalance(node(next.key, next.value, current.left, removeNode(current.right, next.key)));
};

const fromSorted = <K extends string, V>(
  entries: readonly (readonly [K, V])[],
  start = 0,
  end = entries.length
): IndexNode<K, V> | undefined => {
  if (start >= end) return undefined;
  const middle = (start + end) >> 1;
  const [key, value] = entries[middle];
  return node(key, value, fromSorted(entries, start, middle), fromSorted(entries, middle + 1, end));
};

/** Immutable keyed lookup used to keep published collection snapshots durable across revisions. */
export class PersistentKeyedIndex<K extends string, V> {
  private constructor(private readonly root?: IndexNode<K, V>) {}

  static empty<K extends string, V>(): PersistentKeyedIndex<K, V> {
    return new PersistentKeyedIndex<K, V>();
  }

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

  set(key: K, value: V): PersistentKeyedIndex<K, V> {
    return new PersistentKeyedIndex(setNode(this.root, key, value));
  }

  remove(key: K): PersistentKeyedIndex<K, V> {
    return new PersistentKeyedIndex(removeNode(this.root, key));
  }
}
