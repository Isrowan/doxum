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
  ProjectionError,
  type ExternalCollectionEvent,
} from 'doxum';
import { incremental, type CollectionChange } from 'doxum/advanced';
import { startProfile } from '@/profile';

describe('current projection reads', () => {
  it('advances only demanded branches and defers all notifications', () => {
    const count = input(0);
    const a = vi.fn((n: number) => n * 2);
    const b = vi.fn((n: number) => n + 10);
    const left = derive({ count }, ({ count }) => a(count));
    const right = derive({ count }, ({ count }) => b(count));
    const runtime = createProjectionRuntime();
    const current = runtime.select(left);
    runtime.read(right);
    const listener = vi.fn();
    current.subscribe(listener);
    a.mockClear();
    b.mockClear();
    runtime.batch(() => {
      runtime.update(count, 1);
      expect(runtime.read(count)).toBe(1);
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
      expect(current.current()).toBe(2);
      expect(current.current()).toBe(2);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
      runtime.update(count, 2);
      expect(runtime.read(left)).toBe(4);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });
    expect(b.mock.calls).toEqual([[2]]);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('keeps selectors current while preserving their notification baseline', () => {
    const rows = input.collection(
      new Map([
        ['a', 0],
        ['b', 0],
      ])
    );
    const runtime = createProjectionRuntime();
    const select = vi.fn((values: ReadonlyMap<string, number>) => values.get('a'));
    const readable = runtime.select(rows, select);
    const listener = vi.fn();
    readable.subscribe(listener);
    select.mockClear();
    runtime.batch(() => {
      runtime.update(rows, d => d.set('b', 1));
      expect(readable.current()).toBe(0);
      expect(select).not.toHaveBeenCalled();
      runtime.update(rows, d => d.set('a', 1));
      expect(readable.current()).toBe(1);
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.batch(() => {
      runtime.update(rows, d => d.set('a', 2));
      expect(readable.current()).toBe(2);
      runtime.update(rows, d => d.set('a', 1));
      expect(readable.current()).toBe(1);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.batch(() => {
      runtime.update(rows, d => d.set('a', 3));
      expect(readable.current()).toBe(3);
      runtime.update(rows, d => {
        d.set('a', 1);
        d.set('b', 2);
      });
    });
    // The outward net change mentions only b, but the selected cache saw a=3.
    expect(readable.current()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('merges independent collection deltas for consumers at different revisions', () => {
    const rows = input.collection(
      new Map([
        ['a', 0],
        ['b', 0],
      ])
    );
    const eager = vi.fn((value: number) => value * 2);
    const deferred = vi.fn((value: number) => value * 3);
    const left = derive.keyed(rows, eager);
    const right = derive.keyed(rows, deferred);
    const runtime = createProjectionRuntime();
    runtime.read(left);
    runtime.read(right);
    eager.mockClear();
    deferred.mockClear();
    runtime.batch(() => {
      runtime.update(rows, d => d.set('a', 1));
      expect(runtime.read(left).get('a')).toBe(2);
      runtime.update(rows, d => d.set('b', 2));
      expect(runtime.read(left).get('b')).toBe(4);
      runtime.update(rows, d => d.set('a', 3));
      expect(runtime.read(left).get('a')).toBe(6);
      expect(deferred).not.toHaveBeenCalled();
    });
    expect(eager.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
    expect(deferred.mock.calls.map(([n]) => n)).toEqual([3, 2]);
    expect([...runtime.read(right)]).toEqual([
      ['a', 9],
      ['b', 6],
    ]);
    runtime.dispose();
  });

  it('skips consumers whose unconsumed interval has no net change', () => {
    const source = input(0);
    const rows = input.collection(new Map([['a', 0]]));
    const scalar = vi.fn((n: number) => n);
    const keyed = vi.fn((n: number) => n);
    const a = derive({ source }, ({ source }) => scalar(source));
    const b = derive.keyed(rows, keyed);
    const runtime = createProjectionRuntime();
    runtime.read(a);
    runtime.read(b);
    const listener = vi.fn();
    runtime.select(source).subscribe(listener);
    runtime.select(rows).subscribe(listener);
    scalar.mockClear();
    keyed.mockClear();
    runtime.batch(() => {
      runtime.update(source, 1);
      runtime.read(source);
      runtime.update(source, 0);
      runtime.read(source);
      runtime.update(rows, d => d.set('a', 1));
      runtime.read(rows);
      runtime.update(rows, d => d.set('a', 0));
      runtime.read(rows);
    });
    expect(scalar).not.toHaveBeenCalled();
    expect(keyed).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('advances one retained instance and preserves reset per consumer', () => {
    const document = createDocument({
      schema: object({ value: field<number>() }),
      initial: { value: 0 },
    });
    const source = observe(document, p => p.value);
    const state = vi.fn(() => ({ count: 0 }));
    const runs: { value: number; reset: boolean; count: number }[] = [];
    const result = incremental(
      { source },
      {
        state,
        process: ({ values, state, reset }) => {
          runs.push({ value: values.source, reset, count: ++state.count });
          return values.source;
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(result);
    runtime.batch(() => {
      document.update(d => {
        d.value = 1;
      });
      expect(runtime.read(result)).toBe(1);
      document.replace({ value: 2 });
      expect(runtime.read(source)).toBe(2);
      document.update(d => {
        d.value = 3;
      });
      expect(runtime.read(source)).toBe(3);
      expect(runtime.read(result)).toBe(3);
    });
    expect(state).toHaveBeenCalledTimes(1);
    expect(runs).toEqual([
      { value: 0, reset: true, count: 1 },
      { value: 1, reset: false, count: 2 },
      { value: 3, reset: true, count: 3 },
    ]);
    runtime.dispose();
    document.dispose();
  });

  it('keeps item identity through observed temporary removal and settles transient handles', () => {
    const parent = input.collection(
      new Map([
        ['a', [['x', 1]] as readonly (readonly [string, number])[]],
        ['b', []],
      ])
    );
    const expanded = derive.keyed.flatMap(parent, value => value);
    const runtime = createProjectionRuntime();
    const items = runtime.items(expanded);
    const x = items.get('x');
    const listener = vi.fn();
    const keysListener = vi.fn();
    x.subscribe(listener);
    items.keys.subscribe(keysListener);
    runtime.batch(() => {
      runtime.update(parent, d => d.set('a', []));
      expect(x.current()).toBeUndefined();
      expect(items.keys.current()).toEqual([]);
      runtime.update(parent, d => d.set('b', [['x', 2]]));
      expect(items.get('x')).toBe(x);
      expect(x.current()).toBe(2);
      expect(items.keys.current()).toEqual(['x']);
      expect(listener).not.toHaveBeenCalled();
    });
    expect(items.get('x')).toBe(x);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(keysListener).not.toHaveBeenCalled();
    let transient!: ReturnType<typeof items.get>;
    runtime.batch(() => {
      runtime.update(parent, d => d.set('a', [['temp', 1]]));
      transient = items.get('temp');
      expect(transient.current()).toBe(1);
      runtime.update(parent, d => d.set('a', []));
      expect(runtime.read(expanded).has('temp')).toBe(false);
    });
    expect(transient.current()).toBeUndefined();
    runtime.update(parent, d => d.set('a', [['temp', 3]]));
    expect(items.get('temp')).not.toBe(transient);
    runtime.dispose();
  });

  it('preserves canonical references and net notifications through intermediate custom-equality reads', () => {
    const source = input(0);
    const computed = derive(
      { source },
      ({ source }) => ({ n: source }),
      (a, b) => a.n === b.n
    );
    const rows = derive.keyed.flatMap(
      derive.keyed.singleton(source, () => 'row'),
      n => [['x', { n }]],
      (a, b) => a.n === b.n
    );
    const runtime = createProjectionRuntime();
    const before = runtime.read(computed);
    const entry = runtime.read(rows).get('x');
    const listener = vi.fn();
    runtime.select(computed).subscribe(listener);
    runtime.select(rows).subscribe(listener);
    runtime.batch(() => {
      runtime.update(source, 1);
      expect(runtime.read(computed).n).toBe(1);
      expect(runtime.read(rows).get('x')?.n).toBe(1);
      runtime.update(source, 0);
      expect(runtime.read(computed)).toBe(before);
      expect(runtime.read(rows).get('x')).toBe(entry);
    });
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('throws demand failures without rolling back input and recovers after another write', () => {
    const source = input(0);
    const errors = vi.fn();
    const derived = derive({ source }, ({ source }) => {
      if (source === 1) throw new Error('bad');
      return source * 2;
    });
    const runtime = createProjectionRuntime({ onError: errors });
    runtime.read(derived);
    runtime.batch(() => {
      runtime.update(source, 1);
      expect(() => runtime.read(derived)).toThrow(ProjectionError);
      expect(runtime.read(source)).toBe(1);
      expect(errors).not.toHaveBeenCalled();
      runtime.update(source, 2);
      expect(runtime.read(derived)).toBe(4);
    });
    expect(errors).toHaveBeenCalled();
    runtime.dispose();
  });

  it('does not scan a large collection for partial reads across a batch', () => {
    const rows = input.collection(new Map(Array.from({ length: 10000 }, (_, i) => [String(i), i])));
    const run = vi.fn((value: number) => value + 1);
    const derived = derive.keyed(rows, run);
    const runtime = createProjectionRuntime();
    runtime.read(derived);
    run.mockClear();
    const profile = startProfile();
    runtime.batch(() => {
      runtime.update(rows, d => d.set('1', 99));
      expect(runtime.read(derived).get('1')).toBe(100);
      runtime.update(rows, d => d.set('2', 88));
      expect(runtime.read(derived).get('2')).toBe(89);
    });
    const counters = profile.stop();
    expect(run).toHaveBeenCalledTimes(2);
    expect(counters.collectionView.idsScanned).toBe(0);
    expect(counters.collectionIndex.builds).toBe(0);
    runtime.dispose();
  });
  it('preserves exact order and membership changes across partially consumed document commits', () => {
    const document = createDocument({
      schema: object({ rows: map(field<number>()) }),
      initial: { rows: { a: 1, b: 2 } },
    });
    const rows = observe(document, p => p.rows);
    const seen: (CollectionChange<string, number> | undefined)[] = [];
    const result = incremental.collection(
      { rows },
      {
        process: ({ values, changes, previous, output }) => {
          seen.push(changes.rows);
          for (const key of previous.ids()) if (!values.rows.has(key)) output.remove(key);
          for (const [key, value] of values.rows) output.set(key, value);
          output.order([...values.rows.keys()]);
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(result);
    seen.length = 0;
    runtime.batch(() => {
      document.update(d => d.rows.put('a', 3));
      runtime.read(rows);
      document.update(d => {
        d.rows.remove('b');
        d.rows.put('c', 4);
      });
      runtime.read(rows);
      document.update(d => {
        d.rows.put('b', 5);
        d.rows.remove('c');
      });
      runtime.read(rows);
    });
    expect([...runtime.read(result)]).toEqual([
      ['a', 3],
      ['b', 5],
    ]);
    expect(seen).toEqual([
      {
        kind: 'incremental',
        added: [],
        updated: [
          { key: 'a', before: 1, after: 3 },
          { key: 'b', before: 2, after: 5 },
        ],
        removed: [],
      },
    ]);
    runtime.dispose();
    document.dispose();
  });

  it('rebinds dynamic dependencies without losing unconsumed entry updates', () => {
    const parents = input.collection(new Map([['p', ['a']]]));
    const records = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ])
    );
    const calls = vi.fn();
    const result = derive.keyed.flatMap(
      parents,
      { records: { source: records, keys: ids => ids } },
      (_ids, key, deps) => {
        calls();
        return [[key, [...deps.records.values()].reduce((a, b) => a + b, 0)]];
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(result);
    calls.mockClear();
    runtime.batch(() => {
      runtime.update(records, d => d.set('a', 4));
      runtime.read(records);
      runtime.update(records, d => d.set('b', 5));
      runtime.read(records);
      runtime.update(parents, d => d.set('p', ['b', 'c']));
      expect(runtime.read(result).get('p')).toBe(8);
      runtime.update(records, d => d.set('a', 9));
      runtime.read(records);
      runtime.update(records, d => d.set('c', 6));
      expect(runtime.read(result).get('p')).toBe(11);
    });
    expect(calls).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('reports read failures but suppresses transient fault notifications after recovery to the baseline', () => {
    const source = input(0);
    const result = derive({ source }, ({ source }) => {
      if (source === 1) throw new Error('bad');
      return 0;
    });
    const errors = vi.fn();
    const runtime = createProjectionRuntime({ onError: errors });
    const listener = vi.fn();
    runtime.select(result).subscribe(listener);
    runtime.batch(() => {
      runtime.update(source, 1);
      expect(() => runtime.read(result)).toThrow(ProjectionError);
      runtime.update(source, 2);
      expect(runtime.read(result)).toBe(0);
    });
    expect(errors).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });
  it('matches final membership and order across many independently consumed intervals', () => {
    const rows = input.collection<string, number | undefined>();
    const left = derive.keyed(rows, value => value);
    const right = derive.keyed(rows, value => value);
    const runtime = createProjectionRuntime();
    runtime.read(left);
    runtime.read(right);
    const expected = new Map<string, number | undefined>();
    let seed = 54321;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    runtime.batch(() => {
      for (let round = 0; round < 300; round++) {
        runtime.update(rows, draft => {
          for (let i = 0; i < 4; i++) {
            const key = String(random() % 17);
            if (random() % 3 === 0) {
              draft.remove(key);
              expected.delete(key);
            } else {
              const value = random() % 7 || undefined;
              draft.set(key, value);
              expected.set(key, value);
            }
          }
        });
        expect([...runtime.read(left)]).toEqual([...expected]);
        if (round % 13 === 0) expect([...runtime.read(right)]).toEqual([...expected]);
      }
    });
    expect([...runtime.read(right)]).toEqual([...expected]);
    runtime.dispose();
  });

  it('recovers a collection source including keys changed during its failed interval', () => {
    const values = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    let fail = false;
    let revision = 0;
    let receive!: (event: ExternalCollectionEvent<string, number>) => void;
    const source = observe({
      kind: 'collection' as const,
      revision: () => revision,
      current: () => {
        if (fail) throw new Error('source unavailable');
        return {
          get: (key: string) => values.get(key),
          has: (key: string) => values.has(key),
          ids: () => [...values.keys()],
        };
      },
      subscribe: (listener: (event: ExternalCollectionEvent<string, number>) => void) => {
        receive = listener;
        return () => undefined;
      },
    });
    const errors = vi.fn();
    const runtime = createProjectionRuntime({ onError: errors });
    const result = derive.keyed(source, value => value * 2);
    runtime.read(result);
    const items = runtime.items(result);
    const a = items.get('a');
    let previous = new Map(values);
    const notify = (key: string) => {
      const before = previous;
      previous = new Map(values);
      receive({
        previous: {
          get: key => before.get(key),
          has: key => before.has(key),
          ids: () => [...before.keys()],
        },
        revision: ++revision,
        impact: {
          kind: 'incremental',
          added: new Set(),
          removed: new Set(),
          updated: new Set([key]),
          orderChanged: false,
        },
      });
    };
    runtime.batch(() => {
      values.set('a', 3);
      fail = true;
      notify('a');
      expect(() => runtime.read(result)).toThrow(ProjectionError);
      fail = false;
      values.set('b', 4);
      notify('b');
      expect(a.current()).toBe(6);
      expect([...runtime.read(result)]).toEqual([
        ['a', 6],
        ['b', 8],
      ]);
    });
    expect(errors).toHaveBeenCalled();
    runtime.dispose();
  });

  it('allows settled listener reads and rejects writes or graph creation during notification', () => {
    const value = input(0);
    const result = derive({ value }, ({ value }) => value * 2);
    const untouched = derive({ value }, ({ value }) => value + 1);
    const runtime = createProjectionRuntime();
    const current = runtime.select(result);
    const notifications: number[] = [];
    current.subscribe(() => {
      notifications.push(current.current());
      expect(runtime.read(value)).toBe(2);
      expect(() => runtime.update(value, 3)).toThrow('re-entered');
      expect(() => runtime.read(untouched)).toThrow('re-entered');
    });
    runtime.batch(() => {
      runtime.update(value, 1);
      expect(current.current()).toBe(2);
      runtime.update(value, 2);
    });
    expect(notifications).toEqual([4]);
    runtime.dispose();
  });

  it('does not advance an unchanged scalar sibling when a grouped collection resets', () => {
    const document = createDocument({ schema: object({ n: field<number>() }), initial: { n: 0 } });
    const source = observe(document, path => path.n);
    const grouped = incremental.group(
      { source },
      {
        output: define => ({
          scalar: define.value<number>(),
          rows: define.collection<string, number>(),
        }),
        process: ({ values, output }) => {
          output.scalar.set(0);
          output.rows.set('a', values.source);
        },
      }
    );
    const runtime = createProjectionRuntime();
    const scalar = runtime.select(grouped.scalar);
    const revision = scalar.revision();
    const listener = vi.fn();
    scalar.subscribe(listener);
    runtime.batch(() => {
      document.replace({ n: 1 });
      expect(runtime.read(grouped.rows).get('a')).toBe(1);
      expect(scalar.revision()).toBe(revision);
    });
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
    document.dispose();
  });
});
