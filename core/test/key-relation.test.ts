import { describe, expect, it, vi } from 'vitest';
import { createKeyRelation } from '@/projection/keyed/relation';
import { measureProfile } from '@/profile';
import { createProjectionRuntime, derive, input } from 'doxum';

const noWork = {
  attachedEdges: 0,
  detachedEdges: 0,
  createdBuckets: 0,
  deletedBuckets: 0,
  diffSets: 0,
  diffKeys: 0,
};

describe('key relation replacement', () => {
  it('replaces one of 1000 keys with only two edge writes and no difference Set', () => {
    const relation = createKeyRelation();
    const previous = Array.from({ length: 1000 }, (_, i) => String(i));
    relation.replace('left', previous);
    const bucket = relation.reverse('499');
    const snapshot = relation.forward('left');
    const next = [...previous];
    next[500] = 'new';
    const measured = measureProfile(() => relation.replace('left', next));
    expect(measured.value).toBe(true);
    expect(measured.profile.keyRelation).toEqual({
      ...noWork,
      attachedEdges: 1,
      detachedEdges: 1,
      createdBuckets: 1,
      deletedBuckets: 1,
    });
    expect(relation.reverse('499')).toBe(bucket);
    expect(relation.reverse('500')).toBeUndefined();
    expect([...relation.reverse('new')!]).toEqual(['left']);
    expect(relation.forward('left')).toEqual(next);
    expect(Object.isFrozen(relation.forward('left'))).toBe(true);
    next[0] = 'mutated';
    expect(relation.forward('left')![0]).toBe('0');
    expect(snapshot).toEqual(previous);
  });

  it('keeps equal snapshots and all buckets intact for reorder-only replacements', () => {
    const relation = createKeyRelation();
    const initial = Object.freeze(['a', 'b', 'c']);
    relation.replace('left', initial);
    const buckets = initial.map(key => relation.reverse(key));
    for (const equal of [initial, [...initial]]) {
      const measured = measureProfile(() => relation.replace('left', equal));
      expect(measured.value).toBe(false);
      expect(measured.profile.keyRelation).toEqual(noWork);
      expect(relation.forward('left')).toBe(initial);
    }
    const next = Object.freeze(['c', 'a', 'b']);
    const measured = measureProfile(() => relation.replace('left', next));
    expect(measured.value).toBe(true);
    expect(measured.profile.keyRelation).toEqual(noWork);
    expect(relation.forward('left')).toBe(next);
    initial.forEach((key, index) => expect(relation.reverse(key)).toBe(buckets[index]));
  });

  it.each([
    { before: [], after: ['a', 'b'], added: 2, removed: 0, diffKeys: 0 },
    { before: ['a', 'b'], after: [], added: 0, removed: 2, diffKeys: 0 },
    { before: ['a'], after: ['a', 'b', 'c'], added: 2, removed: 0, diffKeys: 0 },
    { before: ['a', 'b', 'c'], after: ['a'], added: 0, removed: 2, diffKeys: 0 },
    { before: ['b'], after: ['a', 'b'], added: 1, removed: 0, diffKeys: 0 },
    { before: ['a', 'b'], after: ['b'], added: 0, removed: 1, diffKeys: 0 },
    { before: ['a', 'z'], after: ['a', 'b', 'c', 'z'], added: 2, removed: 0, diffKeys: 0 },
    { before: ['a', 'b', 'c', 'z'], after: ['a', 'z'], added: 0, removed: 2, diffKeys: 0 },
    {
      before: ['a', 'b', 'z'],
      after: ['a', 'x', 'b', 'y', 'z'],
      added: 2,
      removed: 0,
      diffKeys: 0,
    },
    {
      before: ['a', 'x', 'b', 'y', 'z'],
      after: ['a', 'b', 'z'],
      added: 0,
      removed: 2,
      diffKeys: 0,
    },
    { before: ['a', 'b', 'z'], after: ['a', 'x', 'y', 'z'], added: 2, removed: 1, diffKeys: 0 },
    { before: ['a', 'x', 'y', 'z'], after: ['a', 'b', 'z'], added: 1, removed: 2, diffKeys: 0 },
    {
      before: ['p', 'a', 'b', 'c', 's'],
      after: ['p', 'c', 'new', 'a', 's'],
      added: 1,
      removed: 1,
      diffKeys: 3,
    },
    { before: ['a', 'b'], after: ['c', 'd'], added: 2, removed: 2, diffKeys: 0 },
    { before: ['a', 'b', 'c', 'd'], after: ['c', 'a'], added: 0, removed: 2, diffKeys: 2 },
  ])(
    'maintains only changed edges: $before → $after',
    ({ before, after, added, removed, diffKeys }) => {
      const relation = createKeyRelation();
      relation.replace('left', before);
      const measured = measureProfile(() => relation.replace('left', after));
      expect(measured.value).toBe(true);
      expect(measured.profile.keyRelation).toEqual({
        attachedEdges: added,
        detachedEdges: removed,
        createdBuckets: added,
        deletedBuckets: removed,
        diffSets: diffKeys ? 1 : 0,
        diffKeys,
      });
      expect(relation.forward('left')).toEqual(after.length ? after : undefined);
      expect([...relation.rights()].sort()).toEqual([...after].sort());
    }
  );

  it('shares buckets and preserves intersections across replaceOne, replace and delete', () => {
    const relation = createKeyRelation();
    relation.replace('one', ['a', '', 'b']);
    relation.replace('two', ['a', '', 'b']);
    const a = relation.reverse('a');
    const empty = relation.reverse('');
    const measured = measureProfile(() => relation.replaceOne('one', ''));
    expect(measured.profile.keyRelation).toEqual({ ...noWork, detachedEdges: 2 });
    expect(relation.reverse('a')).toBe(a);
    expect([...a!]).toEqual(['two']);
    expect(relation.reverse('')).toBe(empty);
    expect([...empty!]).toEqual(['one', 'two']);
    expect(measureProfile(() => relation.replaceOne('one', '')).profile.keyRelation).toEqual(
      noWork
    );
    relation.replace('one', ['a', '', 'b']);
    expect(relation.reverse('')).toBe(empty);
    relation.delete('two');
    expect(relation.reverse('a')).toBe(a);
    expect([...a!]).toEqual(['one']);
    const removed = measureProfile(() => relation.replaceOne('one', undefined));
    expect(removed.profile.keyRelation).toEqual({ ...noWork, detachedEdges: 3, deletedBuckets: 3 });
    expect([...relation.lefts()]).toEqual([]);
    expect([...relation.rights()]).toEqual([]);
    expect(relation.delete('absent')).toBe(false);
    expect(relation.replaceOne('absent', undefined)).toBe(false);
    expect(relation.replace('absent', [])).toBe(false);
  });

  it('agrees with a reference model across mixed replacements, deletions and clears', () => {
    const relation = createKeyRelation();
    const model = new Map<string, readonly string[]>();
    const universe = ['', 'a', 'b', 'c', 'd', 'e', 'f'];
    let seed = 731;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    for (let step = 0; step < 500; step++) {
      const left = String(random(5));
      const operation = random(12);
      if (operation === 0) {
        model.clear();
        relation.clear();
      } else if (operation === 1) expect(relation.delete(left)).toBe(model.delete(left));
      else {
        const next = [...universe];
        for (let i = next.length - 1; i > 0; i--) {
          const j = random(i + 1);
          [next[i], next[j]] = [next[j], next[i]];
        }
        next.length = operation < 5 ? random(2) : random(next.length + 1);
        const previous = model.get(left) ?? [];
        const changed =
          previous.length !== next.length || previous.some((key, i) => key !== next[i]);
        expect(
          operation < 5 ? relation.replaceOne(left, next[0]) : relation.replace(left, next)
        ).toBe(changed);
        if (next.length) model.set(left, [...next]);
        else model.delete(left);
      }
      expect([...relation.lefts()].sort()).toEqual([...model.keys()].sort());
      for (const [key, values] of model) expect(relation.forward(key)).toEqual(values);
      const present = universe.filter(key => [...model.values()].some(keys => keys.includes(key)));
      expect([...relation.rights()].sort()).toEqual(present.sort());
      for (const key of universe) {
        const expected = [...model]
          .filter(([, keys]) => keys.includes(key))
          .map(([left]) => left)
          .sort();
        expect([...(relation.reverse(key) ?? [])].sort()).toEqual(expected);
      }
    }
  });
});

describe('incremental relation consumers', () => {
  it('updates plural dependency routing only for changed edges and preserves selected order', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    const source = input.collection(new Map(ids.map((key, i) => [key, i])));
    const driver = input.collection(
      new Map([
        ['left', ids],
        ['shared', ['0', '1']],
      ])
    );
    const select = vi.fn(
      (_value: readonly string[], _key: string, deps: { records: ReadonlyMap<string, number> }) => [
        ...deps.records.keys(),
      ]
    );
    const result = derive.keyed(driver, { records: { source, keys: ids => ids } }, select);
    const runtime = createProjectionRuntime();
    runtime.read(result);
    const next = [...ids];
    next[500] = 'missing';
    const changed = measureProfile(() => runtime.update(driver, draft => draft.set('left', next)));
    expect(changed.profile.keyRelation).toEqual({
      ...noWork,
      attachedEdges: 1,
      detachedEdges: 1,
      createdBuckets: 1,
      deletedBuckets: 1,
    });
    expect(runtime.read(result).get('left')).toEqual(next.filter(key => key !== 'missing'));
    select.mockClear();
    runtime.update(source, draft => draft.set('500', -1));
    expect(select).not.toHaveBeenCalled();
    runtime.update(source, draft => draft.set('missing', 10));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.read(result).get('left')).toEqual(next);
    select.mockClear();
    runtime.update(source, draft => draft.set('0', -1));
    expect(select).toHaveBeenCalledTimes(2);
    const reordered = measureProfile(() =>
      runtime.update(driver, draft => draft.set('left', [...next].reverse()))
    );
    expect(reordered.profile.keyRelation.attachedEdges).toBe(0);
    expect(reordered.profile.keyRelation.detachedEdges).toBe(0);
    expect(runtime.read(result).get('left')).toEqual([...next].reverse());
    runtime.dispose();
  });

  it('preserves group values while publishing group-key order on selector reorder', () => {
    const source = input.collection(
      new Map([
        ['first', ['a', 'b', 'c']],
        ['second', ['b']],
      ])
    );
    const grouped = derive.keyed.groupBy(source, groups => groups);
    const runtime = createProjectionRuntime();
    const before = runtime.read(grouped);
    const measured = measureProfile(() =>
      runtime.update(source, draft => draft.set('first', ['c', 'b', 'a']))
    );
    expect(measured.profile.keyRelation).toEqual(noWork);
    expect([...runtime.read(grouped).keys()]).toEqual(['c', 'b', 'a']);
    for (const key of ['a', 'b', 'c']) expect(runtime.read(grouped).get(key)).toBe(before.get(key));
    runtime.update(source, draft => draft.set('first', ['c', 'new', 'a']));
    expect([...runtime.read(grouped)]).toEqual([
      ['c', ['first']],
      ['new', ['first']],
      ['a', ['first']],
      ['b', ['second']],
    ]);
    runtime.dispose();
  });
});
