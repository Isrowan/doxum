import { describe, expect, it } from 'vitest';
import {
  collectionChange,
  collectionHasStructuralChange,
  createCollectionChange,
  diffCollection,
} from '@/projection/collection/change';
import { PersistentKeyedIndex } from '@/projection/collection/index';

const generator = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

describe('projection collection algorithms', () => {
  it('keeps the persistent keyed index equivalent to Map without mutating old roots', () => {
    const random = generator(0x51_7a_11);
    const keys = [
      '__proto__',
      'constructor',
      'prototype',
      ...Array.from({ length: 61 }, (_, index) => `key-${index}`),
    ];
    let index = PersistentKeyedIndex.empty<string, number>();
    const model = new Map<string, number>();
    const snapshots: { index: PersistentKeyedIndex<string, number>; model: Map<string, number> }[] =
      [];

    for (let step = 0; step < 500; step++) {
      const key = keys[Math.floor(random() * keys.length)];
      if (random() < 0.7) {
        const value = Math.floor(random() * 100_000);
        index = index.set(key, value);
        model.set(key, value);
      } else {
        index = index.remove(key);
        model.delete(key);
      }
      for (const candidate of keys) {
        expect(index.has(candidate)).toBe(model.has(candidate));
        expect(index.get(candidate)).toBe(model.get(candidate));
      }
      if (step % 37 === 0) snapshots.push({ index, model: new Map(model) });
    }

    const rebuilt = PersistentKeyedIndex.from(model);
    for (const key of keys) {
      expect(rebuilt.has(key)).toBe(model.has(key));
      expect(rebuilt.get(key)).toBe(model.get(key));
    }
    for (const snapshot of snapshots)
      for (const key of keys) {
        expect(snapshot.index.has(key)).toBe(snapshot.model.has(key));
        expect(snapshot.index.get(key)).toBe(snapshot.model.get(key));
      }
  });

  it('owns membership, value and common-member order semantics in one change algebra', () => {
    const membershipOnly = createCollectionChange({
      added: [{ key: 'd', after: 4 }],
      updated: [],
      removed: [{ key: 'a', before: 1 }],
      beforeOrder: ['a', 'b', 'c'],
      afterOrder: ['b', 'c', 'd'],
    });
    expect(membershipOnly).toEqual({
      kind: 'incremental',
      added: [{ key: 'd', after: 4 }],
      updated: [],
      removed: [{ key: 'a', before: 1 }],
    });

    const reordered = createCollectionChange({
      added: [],
      updated: [],
      removed: [],
      beforeOrder: ['a', 'b', 'c'],
      afterOrder: ['c', 'a', 'b'],
    });
    expect(reordered).toEqual({
      kind: 'incremental',
      added: [],
      updated: [],
      removed: [],
      order: { before: ['a', 'b', 'c'], after: ['c', 'a', 'b'] },
    });
    expect(collectionHasStructuralChange(reordered!)).toBe(true);
    expect(reordered?.kind).toBe('incremental');
    if (reordered?.kind !== 'incremental') throw new Error('Expected incremental change.');
    expect([...collectionChange.keys(reordered)]).toEqual([]);
  });

  it('iterates incremental entry-transition keys without interpreting order or reset', () => {
    const change = createCollectionChange({
      added: [{ key: 'added', after: 1 }],
      updated: [{ key: 'updated', before: 1, after: 2 }],
      removed: [{ key: 'removed', before: 3 }],
      beforeOrder: ['removed', 'updated'],
      afterOrder: ['updated', 'added'],
    });
    expect(change?.kind).toBe('incremental');
    if (change?.kind !== 'incremental') throw new Error('Expected incremental change.');
    expect([...collectionChange.keys(change)]).toEqual(['added', 'updated', 'removed']);
    expect(() => [...collectionChange.keys({ kind: 'reset' } as never)]).toThrow(/incremental/i);
  });

  it('diffs random map snapshots against a direct transition oracle', () => {
    const random = generator(0xda_7a_5e);
    const keyPool = Array.from({ length: 24 }, (_, index) => `key-${index}`);
    for (let sample = 0; sample < 200; sample++) {
      const before = new Map<string, number>();
      const after = new Map<string, number>();
      for (const key of keyPool) {
        if (random() < 0.55) before.set(key, Math.floor(random() * 10));
        if (random() < 0.55) after.set(key, Math.floor(random() * 10));
      }
      const change = diffCollection(before, after);
      const added = [...after].filter(([key]) => !before.has(key));
      const removed = [...before].filter(([key]) => !after.has(key));
      const updated = [...before].filter(
        ([key, value]) => after.has(key) && !Object.is(value, after.get(key))
      );
      const commonBefore = [...before.keys()].filter(key => after.has(key));
      const commonAfter = [...after.keys()].filter(key => before.has(key));
      const orderChanged = commonBefore.some((key, index) => commonAfter[index] !== key);
      const expectedChange = Boolean(
        added.length || removed.length || updated.length || orderChanged
      );
      expect(Boolean(change)).toBe(expectedChange);
      if (!change || change.kind === 'reset') continue;
      expect(change.added.map(entry => [entry.key, entry.after])).toEqual(added);
      expect(change.removed.map(entry => [entry.key, entry.before])).toEqual(removed);
      expect(change.updated.map(entry => [entry.key, entry.before])).toEqual(updated);
      expect(Boolean(change.order)).toBe(orderChanged);
    }
  });
});
