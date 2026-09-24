import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  map,
  object,
  observe,
  ProjectionDisposedError,
  ProjectionError,
} from 'doxum';
import { incremental, type CollectionChange } from 'doxum/advanced';
import { startProfile } from '@/profile';

type Child = readonly [string, number | undefined];
const entries = (...values: Child[]): readonly Child[] => values;

describe('derive.keyed.flatMap', () => {
  it('tracks parent and child membership, values and formal order without recomputing reordered parents', () => {
    const parents = input.collection(
      new Map([
        ['a', entries(['x', 1], ['y', 2])],
        ['b', entries(['z', 3])],
      ])
    );
    const select = vi.fn((value: readonly Child[]) => value);
    const result = derive.keyed.flatMap(parents, select);
    const runtime = createProjectionRuntime();
    expect([...runtime.read(result)]).toEqual([
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ]);
    select.mockClear();
    runtime.update(parents, d => d.set('a', entries(['y', 20], ['w', 4], ['x', 1])));
    expect(select).toHaveBeenCalledTimes(1);
    expect([...runtime.read(result)]).toEqual([
      ['y', 20],
      ['w', 4],
      ['x', 1],
      ['z', 3],
    ]);
    select.mockClear();
    runtime.update(parents, d => {
      const a = d.get('a')!;
      d.remove('a');
      d.set('a', a);
    });
    expect(select).not.toHaveBeenCalled();
    expect([...runtime.read(result).keys()]).toEqual(['z', 'y', 'w', 'x']);
    runtime.update(parents, d => {
      d.remove('b');
      d.set('c', entries(['u', undefined]));
    });
    expect([...runtime.read(result).keys()]).toEqual(['y', 'w', 'x', 'u']);
    expect(runtime.read(result).has('u')).toBe(true);
    runtime.update(parents, d => {
      d.set('a', []);
      d.remove('c');
    });
    expect(runtime.read(result).size).toBe(0);
    runtime.dispose();
  });

  it.each([false, true])(
    'preserves global membership for same-batch transfers regardless of parent update order (%s)',
    reverse => {
      const parents = input.collection(
        new Map([
          ['a', entries(['x', 1])],
          ['b', entries(['y', 2])],
        ])
      );
      const result = derive.keyed.flatMap(parents, value => value);
      const changes: CollectionChange<string, number | undefined>[] = [];
      const recorded = incremental(
        { result },
        {
          process: ({ changes: next }) => {
            if (next.result) changes.push(next.result);
            return 0;
          },
        }
      );
      const runtime = createProjectionRuntime();
      runtime.read(recorded);
      const items = runtime.items(result);
      const x = items.get('x');
      const y = items.get('y');
      const next = [
        ['a', entries(['y', 20])],
        ['b', entries(['x', 10])],
      ] as const;
      runtime.batch(() => {
        for (const [key, value] of reverse ? [...next].reverse() : next)
          runtime.update(parents, d => d.set(key, value));
      });
      expect([...runtime.read(result)]).toEqual([
        ['y', 20],
        ['x', 10],
      ]);
      expect(items.get('x')).toBe(x);
      expect(items.get('y')).toBe(y);
      expect(changes.at(-1)).toMatchObject({ kind: 'incremental', added: [], removed: [] });
      runtime.batch(() => {
        runtime.update(parents, d => d.set('c', entries(['x', 10])));
        runtime.update(parents, d => d.remove('b'));
      });
      expect(items.get('x')).toBe(x);
      runtime.update(parents, d => d.remove('c'));
      runtime.update(parents, d => d.set('c', entries(['x', 10])));
      expect(items.get('x')).not.toBe(x);
      runtime.dispose();
    }
  );

  it.each([entries(['x', 1], ['x', 2]), 1, [[1, 2]], [['x']], [['x', 1, 2]], Promise.resolve([])])(
    'rejects malformed or duplicate initial results: %j',
    value => {
      const parent = input.collection(new Map([['a', 1]]));
      const result = derive.keyed.flatMap(parent, (() => value) as never);
      const runtime = createProjectionRuntime();
      expect(() => runtime.read(result)).toThrow();
      runtime.dispose();
    }
  );

  it('fails on final cross-parent collisions, blocks consumers, then rebuilds all relations on recovery', () => {
    const parent = input.collection(
      new Map([
        ['a', entries(['x', 1])],
        ['b', entries(['y', 2])],
      ])
    );
    const result = derive.keyed.flatMap(parent, value => value);
    const downstream = derive.keyed.values(result);
    const errors = vi.fn();
    const runtime = createProjectionRuntime({ onError: errors });
    expect(runtime.read(downstream)).toEqual([1, 2]);
    runtime.update(parent, d => d.set('b', entries(['x', 3])));
    expect(() => runtime.read(result)).toThrow(ProjectionError);
    expect(() => runtime.read(downstream)).toThrow(ProjectionError);
    expect(errors.mock.calls.some(([error]) => String(error.cause).includes('duplicate key'))).toBe(
      true
    );
    runtime.batch(() => {
      runtime.update(parent, d => d.set('a', []));
      runtime.update(parent, d => d.set('c', entries(['z', 4])));
    });
    expect([...runtime.read(result)]).toEqual([
      ['x', 3],
      ['z', 4],
    ]);
    expect(runtime.read(downstream)).toEqual([3, 4]);
    runtime.dispose();
  });

  it('routes global, same-key, one and many dependencies and removes stale bindings', () => {
    const parent = input.collection(
      new Map([
        ['a', ['r1', 'r2']],
        ['b', ['r3']],
      ])
    );
    const records = input.collection(
      new Map([
        ['r1', 1],
        ['r2', 2],
        ['r3', 3],
        ['other', 4],
      ])
    );
    const meta = input.collection(
      new Map([
        ['a', 10],
        ['b', 20],
      ])
    );
    const global = input(100);
    const called = vi.fn();
    const result = derive.keyed.flatMap(
      parent,
      {
        global,
        meta: { source: meta },
        first: { source: records, key: ids => ids[0] },
        records: { source: records, keys: ids => ids },
      },
      (ids, key, deps) => {
        called(key);
        return [
          [
            key,
            (deps.meta ?? 0) +
              deps.global +
              (deps.first ?? 0) +
              [...deps.records.values()].reduce((a, b) => a + b, 0),
          ],
        ] as const;
      }
    );
    const runtime = createProjectionRuntime();
    expect([...runtime.read(result)]).toEqual([
      ['a', 114],
      ['b', 126],
    ]);
    called.mockClear();
    runtime.update(records, d => d.set('other', 40));
    expect(called).not.toHaveBeenCalled();
    runtime.update(records, d => d.set('r2', 5));
    expect(called.mock.calls).toEqual([['a']]);
    called.mockClear();
    runtime.update(parent, d => d.set('a', ['missing']));
    called.mockClear();
    runtime.update(records, d => d.set('r2', 8));
    expect(called).not.toHaveBeenCalled();
    runtime.update(records, d => d.set('missing', 7));
    expect(called.mock.calls).toEqual([['a']]);
    called.mockClear();
    runtime.update(meta, d => d.set('b', 30));
    expect(called.mock.calls).toEqual([['b']]);
    called.mockClear();
    runtime.update(records, d => {
      const old = d.get('r3')!;
      d.remove('r3');
      d.set('r3', old);
    });
    expect(called).not.toHaveBeenCalled();
    runtime.update(global, 200);
    expect(called.mock.calls).toEqual([['a'], ['b']]);
    called.mockClear();
    runtime.batch(() => {
      runtime.update(parent, d => d.set('a', ['r1', 'r2']));
      runtime.update(records, d => {
        d.set('r1', 9);
        d.set('r2', 10);
      });
      runtime.update(meta, d => d.set('a', 40));
    });
    expect(called.mock.calls).toEqual([['a']]);
    expect(runtime.read(result).get('a')).toBe(268);
    runtime.update(parent, d => d.remove('a'));
    called.mockClear();
    runtime.update(records, d => {
      d.set('missing', 8);
      d.set('r1', 8);
    });
    expect(called).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('retains equal entry references through source reset and processor recovery', () => {
    const schema = object({ parents: map(field<number>()) });
    const document = createDocument({ schema, initial: { parents: { a: 1, b: 2 } } });
    const parent = observe(document, p => p.parents);
    let failOnce = false;
    const result = derive.keyed.flatMap(
      parent,
      (value, key) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('retry');
        }
        return [[key, { n: value }]] as const;
      },
      (a, b) => a.n === b.n
    );
    const runtime = createProjectionRuntime();
    const items = runtime.items(result);
    const a = items.get('a');
    const original = runtime.read(result).get('a');
    document.replace({ parents: { a: 1, c: 3 } });
    expect(runtime.read(result).get('a')).toBe(original);
    expect(items.get('a')).toBe(a);
    failOnce = true;
    document.update(d => d.parents.put('c', 4));
    expect(runtime.read(result).get('a')).toBe(original);
    expect(items.get('a')).toBe(a);
    expect([...runtime.read(result).keys()]).toEqual(['a', 'c']);
    runtime.dispose();
    document.dispose();
  });

  it('does not publish partial output on equality failure and recovers the final complete collection', () => {
    const parent = input.collection(new Map([['a', entries(['x', 1], ['y', 2])]]));
    let fail = false;
    const result = derive.keyed.flatMap(
      parent,
      value => value,
      (a, b) => {
        if (fail && b === 99) throw new Error('equality');
        return Object.is(a, b);
      }
    );
    const runtime = createProjectionRuntime();
    const first = runtime.read(result);
    fail = true;
    runtime.update(parent, d => d.set('a', entries(['x', 10], ['y', 99])));
    expect(() => runtime.read(result)).toThrow(ProjectionError);
    fail = false;
    runtime.update(parent, d => d.set('a', entries(['x', 11], ['z', 3])));
    expect([...runtime.read(result)]).toEqual([
      ['x', 11],
      ['z', 3],
    ]);
    expect([...first]).toEqual([
      ['x', 1],
      ['y', 2],
    ]);
    runtime.dispose();
  });

  it('isolates instance caches, cleans up scoped processors and composes through normal keyed views', () => {
    const parent = input.collection(new Map([['a', entries(['x', 1])]]));
    const result = derive.keyed.flatMap(parent, value => value);
    const first = createProjectionRuntime();
    const second = createProjectionRuntime();
    first.read(result);
    second.read(result);
    first.update(parent, d => d.set('a', entries(['y', 2])));
    expect([...second.read(result)]).toEqual([['x', 1]]);
    const scope = first.scope();
    const scoped = scope.own(derive.keyed.flatMap(parent, value => value));
    const item = scope.items(scoped).get('y');
    expect(item.current()).toBe(2);
    scope.dispose();
    expect(() => item.current()).toThrow(ProjectionDisposedError);
    const filtered = derive.keyed.filter(result, n => n !== undefined);
    const grouped = derive.keyed.groupBy(filtered, () => 'all');
    const merged = derive.keyed.merge([result, input.collection(new Map([['z', 3]]))], {
      conflict: 'error',
    });
    expect(first.read(grouped).get('all')).toEqual(['y']);
    expect([...first.read(merged)]).toEqual([
      ['y', 2],
      ['z', 3],
    ]);
    first.dispose();
    second.dispose();
  });

  it('maintains only affected child values and skips global order scans on value-only updates', () => {
    const parent = input.collection(
      new Map(Array.from({ length: 10000 }, (_, i) => [String(i), i]))
    );
    const selector = vi.fn((value: number, key: string) => [[key, { value }]] as const);
    const result = derive.keyed.flatMap(parent, selector, (a, b) => a.value === b.value);
    const runtime = createProjectionRuntime();
    const unchanged = runtime.read(result).get('0');
    selector.mockClear();
    const measuring = startProfile();
    runtime.update(parent, d => d.set('5000', 99));
    const stats = measuring.stop();
    expect(selector).toHaveBeenCalledTimes(1);
    expect(runtime.read(result).get('0')).toBe(unchanged);
    expect(stats.collectionView.idsScanned).toBe(0);
    expect(stats.collectionIndex.builds).toBe(0);
    expect(stats.projection.touchedKeys).toBe(2); // source and output
    runtime.dispose();
  });
});
