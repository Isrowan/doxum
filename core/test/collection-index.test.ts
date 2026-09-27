import { describe, expect, it, vi } from 'vitest';
import { createProjectionRuntime, derive, input } from 'doxum';
import { measureProfile } from '@/profile';
import type { CollectionEntry } from '@/projection/collection/entry';
import { PersistentKeyedIndex } from '@/projection/collection/index';
import { createCollectionState } from '@/projection/collection/state';

// Inspect representation only here: balance/height and sharing must not become public APIs.
type Node<V> = {
  readonly key: string;
  readonly value: V;
  readonly height: number;
  readonly left?: Node<V>;
  readonly right?: Node<V>;
};
const rootOf = <V>(index: PersistentKeyedIndex<string, V>): Node<V> | undefined =>
  (index as unknown as { readonly root?: Node<V> }).root;
const keyOf = (i: number) => `key-${String(i).padStart(6, '0')}`;
const set = <V>(value: V): CollectionEntry<V> => ({ present: true, value });
const removed: CollectionEntry<never> = { present: false };

const assertTree = <V>(index: PersistentKeyedIndex<string, V>, model: ReadonlyMap<string, V>) => {
  const entries: [string, V][] = [];
  const visit = (current: Node<V> | undefined): number => {
    if (!current) return 0;
    expect(Object.isFrozen(current)).toBe(true);
    const leftHeight = visit(current.left);
    entries.push([current.key, current.value]);
    const rightHeight = visit(current.right);
    expect(Math.abs(leftHeight - rightHeight)).toBeLessThanOrEqual(1);
    expect(current.height).toBe(Math.max(leftHeight, rightHeight) + 1);
    return current.height;
  };
  visit(rootOf(index));
  expect(entries).toEqual([...model].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const [key, value] of model) {
    expect(index.has(key)).toBe(true);
    expect(index.get(key)).toBe(value);
  }
};

const paths = <V>(index: PersistentKeyedIndex<string, V>, keys: Iterable<string>) => {
  const seen = new Set<Node<V>>();
  for (const key of keys) {
    let current = rootOf(index);
    while (current) {
      seen.add(current);
      if (key === current.key) break;
      current = key < current.key ? current.left : current.right;
    }
  }
  return seen;
};

describe('persistent collection batch index', () => {
  it.each([10000, 100000])('copies each affected path node once in %i members', count => {
    const entries = Array.from({ length: count }, (_, i) => [keyOf(i), i] as const);
    const before = PersistentKeyedIndex.from(entries);
    for (const spread of [false, true]) {
      const changes = new Map(
        Array.from({ length: 500 }, (_, i) => [
          keyOf(spread ? i * (count / 500) : count / 2 + i),
          set(-i - 1),
        ])
      );
      const affected = paths(before, changes.keys());
      const { value: after, profile } = measureProfile(() => before.apply(changes));
      expect(profile.collectionIndex.nodes).toBe(affected.size);
      expect(profile.collectionIndex.visitedNodes).toBe(affected.size);
      expect(profile.collectionIndex.sortedKeys).toBe(500);
      expect(profile.collectionIndex.batches).toBe(1);
      expect(profile.collectionIndex.builds).toBe(0);
      const sharing = (old: Node<number> | undefined, next: Node<number> | undefined) => {
        if (!old) return;
        if (!affected.has(old)) expect(next).toBe(old);
        else {
          expect(next).not.toBe(old);
          expect(next!.height).toBe(old.height);
          sharing(old.left, next!.left);
          sharing(old.right, next!.right);
        }
      };
      sharing(rootOf(before), rootOf(after));
      for (const [key, value] of entries) {
        expect(before.get(key)).toBe(value);
        const entry = changes.get(key);
        expect(after.get(key)).toBe(entry?.present ? entry.value : value);
      }
    }
  });

  it('keeps no-op roots and distinguishes undefined values from missing members', () => {
    const original = PersistentKeyedIndex.from<string, number | undefined>([
      ['a', 1],
      ['b', undefined],
    ]);
    for (const changes of [
      new Map<string, CollectionEntry<number | undefined>>(),
      new Map([['a', set(1)]]),
      new Map([['absent', removed]]),
      new Map<string, CollectionEntry<number | undefined>>([
        ['a', set(1)],
        ['b', set(undefined)],
        ['absent', removed],
      ]),
    ]) {
      const { value, profile } = measureProfile(() => original.apply(changes));
      expect(value).toBe(original);
      expect(profile.collectionIndex.nodes).toBe(0);
    }
    const changes = new Map([
      ['b', removed],
      ['c', set(undefined)],
    ]);
    const after = original.apply(changes);
    changes.clear();
    expect(original.has('b')).toBe(true);
    expect(after.has('b')).toBe(false);
    expect(after.has('c')).toBe(true);
    expect(after.get('c')).toBeUndefined();
    expect(
      PersistentKeyedIndex.empty<string, number>().apply(
        new Map([
          ['a', removed],
          ['b', removed],
        ])
      )
    ).toEqual(PersistentKeyedIndex.empty());
  });

  it('does not sort or allocate a batch key array for one accepted key', () => {
    const before = PersistentKeyedIndex.from([
      ['a', 1],
      ['b', 2],
    ]);
    const { profile } = measureProfile(() => before.apply(new Map([['a', set(3)]])));
    expect(profile.collectionIndex.sortedKeys).toBe(0);
    expect(profile.collectionIndex.batches).toBe(1);
    expect(profile.collectionIndex.nodes).toBe(2);
  });

  it('joins arbitrarily different heights after mass deletion and insertion', () => {
    const initial = new Map(Array.from({ length: 2047 }, (_, i) => [keyOf(i), i]));
    const before = PersistentKeyedIndex.from(initial);
    const cleared = before.apply(new Map([...initial.keys()].map(key => [key, removed])));
    assertTree(cleared, new Map());
    assertTree(before, initial);
    for (const keep of [
      (i: number) => i >= 1536,
      (i: number) => i < 511,
      (i: number) => i % 257 === 0,
      (_i: number) => false,
    ]) {
      const changes = new Map<string, CollectionEntry<number>>();
      const expected = new Map(initial);
      for (let i = 0; i < 2047; i++)
        if (!keep(i)) {
          changes.set(keyOf(i), removed);
          expected.delete(keyOf(i));
        }
      for (let i = 2047; i < 4096; i++) {
        changes.set(keyOf(i), set(i));
        expected.set(keyOf(i), i);
      }
      assertTree(before.apply(changes), expected);
      assertTree(before, initial);
    }
  });

  it('matches a Map through randomized mixed batches while preserving every retained version', () => {
    let seed = 0x6a2c1;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const keys = [
      '',
      '__proto__',
      'constructor',
      '😀',
      '\u0000',
      ...Array.from({ length: 151 }, (_, i) => keyOf(i)),
    ];
    let index = PersistentKeyedIndex.empty<string, number | undefined>();
    const model = new Map<string, number | undefined>();
    const snapshots: { index: typeof index; model: typeof model }[] = [];
    for (let step = 0; step < 400; step++) {
      const changes = new Map<string, CollectionEntry<number | undefined>>();
      const count = (random() % 100) + 1;
      for (let i = 0; i < count; i++) {
        const key = keys[random() % keys.length];
        if (random() % 3 === 0) {
          changes.set(key, removed);
          model.delete(key);
        } else {
          const value = random() % 10 || undefined;
          changes.set(key, set(value));
          model.set(key, value);
        }
      }
      index = index.apply(changes);
      assertTree(index, model);
      for (const key of keys) expect(index.has(key)).toBe(model.has(key));
      if (step % 23 === 0) snapshots.push({ index, model: new Map(model) });
    }
    for (const snapshot of snapshots) assertTree(snapshot.index, snapshot.model);
  });

  it('installs no partial batch on equality failure and preserves accepted equal references', () => {
    const initial = new Map(Array.from({ length: 64 }, (_, i) => [keyOf(i), { n: i }]));
    const failure = new Error('entry equality');
    const source = input.collection(initial, (a, b) => {
      if (b.n === -99) throw failure;
      return a.n === b.n;
    });
    const errors = vi.fn();
    const runtime = createProjectionRuntime({ onError: errors });
    const leaf = derive.keyed(
      source,
      value => ({ n: value.n }),
      (a, b) => {
        if (b.n === -98) throw failure;
        return a.n === b.n;
      }
    );
    const original = runtime.read(leaf);
    const before = runtime.read(source);
    expect(() =>
      runtime.update(source, draft => {
        for (let i = 0; i < 64; i++) draft.set(keyOf(i), { n: i === 63 ? -99 : -i - 1 });
      })
    ).toThrow(failure);
    expect(runtime.read(source)).toBe(before);
    expect(runtime.read(leaf)).toBe(original);
    runtime.update(source, draft => {
      for (let i = 0; i < 64; i++) draft.set(keyOf(i), { n: i === 63 ? -98 : -i - 1 });
    });
    expect(errors).toHaveBeenCalled();
    expect(() => runtime.read(leaf)).toThrow();
    // Durable views retain the normal owner fault checks until recovery.
    expect(() => original.get(keyOf(0))).toThrow();
    runtime.update(source, draft => draft.set(keyOf(63), { n: -64 }));
    for (let i = 0; i < 64; i++) expect(original.get(keyOf(i))!.n).toBe(i);
    const recovered = runtime.read(leaf);
    for (let i = 0; i < 64; i++) expect(recovered.get(keyOf(i))!.n).toBe(-i - 1);
    const accepted = runtime.read(source);
    const unchanged = measureProfile(() =>
      runtime.update(source, draft => {
        for (let i = 0; i < 64; i++) draft.set(keyOf(i), { n: -i - 1 });
      })
    );
    expect(unchanged.profile.collectionIndex.nodes).toBe(0);
    expect(runtime.read(source)).toBe(accepted);
    expect(runtime.read(leaf)).toBe(recovered);
    runtime.dispose();
  });

  it('keeps storage lazy and order separate, including reset and released old reads', () => {
    const state = createCollectionState(
      new Map([
        ['b', 2],
        ['a', 1],
      ])
    );
    const first = measureProfile(() => state.install(new Map([['b', set(3)]]), state.ids(), false));
    expect(first.profile.collectionIndex.nodes).toBe(0);
    const before = state.read(() => undefined);
    const reordered = Object.freeze(['a', 'b']);
    const order = measureProfile(() => state.install(new Map(), reordered, false));
    expect(order.profile.collectionIndex.batches).toBe(0);
    expect(order.profile.collectionIndex.nodes).toBe(0);
    expect(state.read(() => undefined).ids()).toBe(reordered);
    expect(before.ids()).toEqual(['b', 'a']);
    state.install(
      new Map([
        ['c', set(4)],
        ['a', removed],
      ]),
      Object.freeze(['c']),
      true
    );
    const reset = state.read(() => undefined);
    expect(reset.has('a')).toBe(false);
    expect(reset.get('c')).toBe(4);
    expect(before.get('b')).toBe(3);
    state.release();
    expect(reset.get('c')).toBe(4);
    expect(state.size()).toBe(0);
  });

  it('batches five projection layers without losing intermediate reads or coalesced notifications', () => {
    const count = 10000;
    const source = input.collection(
      new Map(Array.from({ length: count }, (_, i) => [keyOf(i), i]))
    );
    const select = vi.fn((value: number) => value + 1);
    let leaf = derive.keyed(source, select);
    for (let i = 1; i < 5; i++) leaf = derive.keyed(leaf, select);
    const runtime = createProjectionRuntime();
    const other = createProjectionRuntime();
    const initial = runtime.read(leaf);
    const otherInitial = other.read(leaf);
    const listener = vi.fn();
    const readable = runtime.select(leaf);
    const unsubscribe = readable.subscribe(listener);
    // Materialize notification baselines outside the measured batch.
    runtime.update(source, draft => draft.set(keyOf(count - 1), -2));
    listener.mockClear();
    select.mockClear();
    const snapshots: (typeof initial)[] = [];
    const { profile } = measureProfile(() =>
      runtime.batch(() => {
        for (let pass = 1; pass <= 2; pass++) {
          runtime.update(source, draft => {
            for (let i = 0; i < 500; i++) draft.set(keyOf(5000 + i), -i - pass * 1000);
          });
          snapshots.push(runtime.read(leaf));
          expect(listener).not.toHaveBeenCalled();
        }
      })
    );
    expect(select).toHaveBeenCalledTimes(5000);
    expect(profile.collectionIndex.nodes).toBe(505 * 6 * 2);
    expect(profile.collectionIndex.builds).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(initial.get(keyOf(5000))).toBe(5005);
    expect(snapshots[0].get(keyOf(5000))).toBe(-995);
    expect(snapshots[1].get(keyOf(5000))).toBe(-1995);
    expect(other.read(leaf)).toBe(otherInitial);
    unsubscribe();
    runtime.dispose();
    expect(() => snapshots[0].get(keyOf(5000))).toThrow();
    expect(other.read(leaf).get(keyOf(5000))).toBe(5005);
    other.dispose();
  });
});
