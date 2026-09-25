import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  object,
  observe,
  ProjectionDisposedError,
  ProjectionError,
  type KeyedProjection,
  type Projection,
} from 'doxum';
import { incremental, type CollectionChange } from 'doxum/advanced';
import { startProfile } from '@/profile';

describe('derive.keyed.fromEntries', () => {
  it('is lazy, combines named sources, and publishes only changed output entries', () => {
    const left = input(1);
    const right = input(2);
    const unrelated = input(0);
    const compute = vi.fn(
      ({ left, right }: { left: number; right: number }) =>
        [
          ['left', left],
          ['right', right],
        ] as const
    );
    const rows = derive.keyed.fromEntries({ left, right }, compute);
    const mapped = vi.fn((value: number) => value * 2);
    const doubled = derive.keyed(rows, mapped);
    expect(compute).not.toHaveBeenCalled();
    const runtime = createProjectionRuntime();
    expect([...runtime.read(doubled)]).toEqual([
      ['left', 2],
      ['right', 4],
    ]);
    compute.mockClear();
    mapped.mockClear();
    runtime.update(unrelated, 1);
    expect(compute).not.toHaveBeenCalled();
    runtime.batch(() => {
      runtime.update(left, 3);
      runtime.update(right, 4);
      expect([...runtime.read(rows)]).toEqual([
        ['left', 3],
        ['right', 4],
      ]);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(mapped).not.toHaveBeenCalled();
    });
    expect(mapped.mock.calls).toEqual([
      [3, 'left'],
      [4, 'right'],
    ]);
    mapped.mockClear();
    runtime.update(right, 5);
    expect(mapped).toHaveBeenCalledTimes(1);
    expect(runtime.read(doubled).get('right')).toBe(10);
    runtime.dispose();
  });

  it('reconciles membership and formal order, preserving equal values and explicit undefined', () => {
    const a = { n: 1 };
    const b = { n: 2 };
    type Value = { readonly n: number } | undefined;
    const source = input<readonly (readonly [string, Value])[]>([
      ['a', a],
      ['b', b],
    ]);
    const rows = derive.keyed.fromEntries(
      { source },
      ({ source }) => source,
      (left, right) => left?.n === right?.n
    );
    const changes: CollectionChange<string, Value>[] = [];
    const recorder = incremental(
      { rows },
      {
        process: context => {
          if (context.changes.rows) changes.push(context.changes.rows);
          return context.values.rows.size;
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(recorder);
    const snapshot = runtime.read(rows);
    changes.length = 0;
    runtime.update(source, [
      ['b', { n: 2 }],
      ['a', { n: 1 }],
    ]);
    expect(changes).toEqual([
      {
        kind: 'incremental',
        added: [],
        updated: [],
        removed: [],
        order: { before: ['a', 'b'], after: ['b', 'a'] },
      },
    ]);
    expect(runtime.read(rows).get('a')).toBe(a);
    changes.length = 0;
    runtime.update(source, [
      ['a', { n: 3 }],
      ['u', undefined],
    ]);
    expect(changes[0]).toMatchObject({
      kind: 'incremental',
      added: [{ key: 'u', after: undefined }],
      updated: [{ key: 'a', before: a, after: { n: 3 } }],
      removed: [{ key: 'b', before: b }],
    });
    expect(runtime.read(rows).has('u')).toBe(true);
    expect([...snapshot]).toEqual([
      ['a', a],
      ['b', b],
    ]);
    runtime.update(source, []);
    expect(runtime.read(rows).size).toBe(0);
    runtime.dispose();
    expect(() => snapshot.get('a')).toThrow(ProjectionDisposedError);
  });

  it('suppresses equivalent results despite newly allocated arrays and tuples', () => {
    const source = input(0);
    const rows = derive.keyed.fromEntries(
      { source },
      () => [['a', { n: 1 }]],
      (left, right) => left.n === right.n
    );
    const runtime = createProjectionRuntime();
    const readable = runtime.select(rows);
    const before = readable.current();
    const revision = readable.revision();
    const listener = vi.fn();
    readable.subscribe(listener);
    runtime.update(source, 1);
    expect(readable.current()).toBe(before);
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('uses whole keyed dependencies and reuses get for precise dynamic lookups', () => {
    const records = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const activeId = input('a');
    const record = derive.keyed.get(records, activeId);
    const compute = vi.fn(({ record }: { record: number | undefined }) =>
      record === undefined ? [] : [['active', record] as const]
    );
    const exact = derive.keyed.fromEntries({ record }, compute);
    const aggregateCompute = vi.fn(
      ({ records }: { records: ReadonlyMap<string, number> }) => [['a', records.get('a')]] as const
    );
    const aggregate = derive.keyed.fromEntries({ records }, aggregateCompute);
    const runtime = createProjectionRuntime();
    runtime.read(exact);
    runtime.read(aggregate);
    compute.mockClear();
    aggregateCompute.mockClear();
    runtime.update(records, d => d.set('b', 3));
    expect(compute).not.toHaveBeenCalled();
    expect(aggregateCompute).toHaveBeenCalledTimes(1);
    runtime.update(activeId, 'b');
    expect(runtime.read(exact).get('active')).toBe(3);
    compute.mockClear();
    runtime.update(records, d => d.set('a', 4));
    expect(compute).not.toHaveBeenCalled();
    runtime.update(records, d => d.remove('b'));
    expect(runtime.read(exact).size).toBe(0);
    runtime.dispose();
  });

  it('provides durable named keyed snapshots and captures dependency declarations', () => {
    const records = input.collection(new Map([['a', 1]]));
    const definitions = { records };
    const snapshots: ReadonlyMap<string, number>[] = [];
    const rows = derive.keyed.fromEntries(definitions, values => {
      expect(Object.isFrozen(values)).toBe(true);
      snapshots.push(values.records);
      return [['snapshot', values.records]];
    });
    definitions.records = input.collection(new Map([['other', 9]]));
    const runtime = createProjectionRuntime();
    expect(runtime.read(rows).get('snapshot')?.get('a')).toBe(1);
    runtime.update(records, d => d.set('a', 2));
    expect(snapshots[0].get('a')).toBe(1);
    expect(runtime.read(rows).get('snapshot')?.get('a')).toBe(2);
    runtime.dispose();
  });

  it('keeps current reads separate from net notifications and membership endings', () => {
    const source = input<readonly (readonly [string, number])[]>([['a', 1]]);
    const rows = derive.keyed.fromEntries({ source }, ({ source }) => source);
    const runtime = createProjectionRuntime();
    const items = runtime.items(rows);
    const a = items.get('a');
    const listener = vi.fn();
    runtime.select(rows).subscribe(listener);
    runtime.batch(() => {
      runtime.update(source, []);
      expect(a.current()).toBeUndefined();
      runtime.update(source, [['a', 2]]);
      expect(a.current()).toBe(2);
      expect(items.get('a')).toBe(a);
      expect(listener).not.toHaveBeenCalled();
      runtime.update(source, [['a', 1]]);
    });
    expect(listener).not.toHaveBeenCalled();
    expect(items.get('a')).toBe(a);
    runtime.update(source, []);
    runtime.update(source, [['a', 1]]);
    expect(items.get('a')).not.toBe(a);
    expect(a.current()).toBeUndefined();
    runtime.dispose();
  });

  it.each(['compute', 'duplicate', 'tuple', 'equality'] as const)(
    'installs no partial output after %s failure and recovers through the processor lifecycle',
    failure => {
      const source = input(false);
      const errors = vi.fn();
      const rows = derive.keyed.fromEntries(
        { source },
        ({ source }) => {
          if (source && failure === 'compute') throw new Error('compute failed');
          if (source && failure === 'duplicate')
            return [
              ['a', 10],
              ['a', 20],
            ];
          if (source && failure === 'tuple')
            return [['a', 10], ['b']] as unknown as readonly (readonly [string, number])[];
          return [
            ['a', source ? 10 : 1],
            ['b', source ? 20 : 2],
          ];
        },
        (previous, next) => {
          if (failure === 'equality' && next === 20) throw new Error('equality failed');
          return previous === next;
        }
      );
      const runtime = createProjectionRuntime({ onError: errors });
      const readable = runtime.select(rows);
      const snapshot = readable.current();
      const revision = readable.revision();
      runtime.batch(() => {
        runtime.update(source, true);
        expect(() => readable.current()).toThrow(ProjectionError);
        runtime.update(source, false);
        expect([...readable.current()]).toEqual([
          ['a', 1],
          ['b', 2],
        ]);
      });
      expect([...snapshot]).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      // Recovery may explicitly reset the collection; failed candidates never become a value baseline.
      expect(readable.revision()).toBe(revision + 1);
      expect(errors).toHaveBeenCalled();
      runtime.dispose();
    }
  );

  it.each([
    ['promise', Promise.resolve([])],
    ['non-array', new Map()],
    ['non-tuple', [null]],
    ['non-string key', [[1, 'value']]],
    ['long tuple', [['a', 1, 2]]],
    [
      'duplicate undefined',
      [
        ['a', undefined],
        ['a', undefined],
      ],
    ],
  ])('rejects malformed %s results during lazy initialization', (_name, invalid) => {
    const rows = derive.keyed.fromEntries(
      {},
      () => invalid as unknown as readonly (readonly [string, number])[]
    );
    const runtime = createProjectionRuntime();
    expect(() => runtime.read(rows)).toThrow();
    runtime.dispose();
  });

  it('validates the shared named dependency shape and synchronous callback boundaries', () => {
    const source = input(1);
    const compute = () => [['a', 1]] as const;
    for (const invalid of [
      source,
      { bad: 1 },
      { bad: { source } },
      Object.defineProperty({}, 'source', { value: source }),
      { [Symbol()]: source },
    ]) {
      expect(() =>
        derive.keyed.fromEntries(invalid as Record<string, Projection<unknown>>, compute)
      ).toThrow();
    }
    expect(() => derive.keyed.fromEntries({}, null as unknown as typeof compute)).toThrow(
      'callback'
    );
    expect(() =>
      derive.keyed.fromEntries({}, compute, 1 as unknown as (a: number, b: number) => boolean)
    ).toThrow('equality');
    const runtime = createProjectionRuntime();
    const bypass = derive.keyed.fromEntries({ source }, () => [['a', runtime.read(source)]]);
    expect(() => runtime.read(bypass)).toThrow('re-entered');
    runtime.dispose();
  });

  it('handles resets, independent runtimes, empty dependencies and scope disposal', () => {
    const document = createDocument({ schema: object({ n: field<number>() }), initial: { n: 1 } });
    const n = observe(document, path => path.n);
    const suffix = input('x');
    const rows = derive.keyed.fromEntries({ n, suffix }, ({ n, suffix }) => [[suffix, n]]);
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    left.read(rows);
    right.read(rows);
    left.update(suffix, 'left');
    document.replace({ n: 2 });
    expect([...left.read(rows)]).toEqual([['left', 2]]);
    expect([...right.read(rows)]).toEqual([['x', 2]]);
    const scope = left.scope();
    const local = scope.own(derive.keyed.fromEntries({}, () => [['constant', 3]]));
    const handle = scope.items(local).get('constant');
    expect(handle.current()).toBe(3);
    scope.dispose();
    expect(() => handle.current()).toThrow(ProjectionDisposedError);
    expect(() => scope.read(local)).toThrow(ProjectionDisposedError);
    left.dispose();
    right.dispose();
    document.dispose();
  });

  it('uses one processor with full-result scanning and only changed downstream entries', () => {
    const initial = Array.from({ length: 10000 }, (_, i) => [String(i), i] as const);
    const source = input<readonly (readonly [string, number])[]>(initial);
    const compute = vi.fn(
      ({ source }: { source: typeof initial | readonly (readonly [string, number])[] }) => source
    );
    const rows: KeyedProjection<string, number> = derive.keyed.fromEntries({ source }, compute);
    const map = vi.fn((value: number) => value * 2);
    const downstream = derive.keyed(rows, map);
    const runtime = createProjectionRuntime();
    runtime.read(downstream);
    runtime.read(rows);
    compute.mockClear();
    map.mockClear();
    const next = [...initial];
    next[0] = ['0', -1];
    const profile = startProfile();
    runtime.update(source, next);
    const counters = profile.stop();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(map).toHaveBeenCalledTimes(1);
    expect(counters.projection.processedNodes).toBe(2);
    expect(counters.projection.changedKeys).toBe(2); // two keyed outputs
    expect(counters.collectionView.idsScanned).toBe(20000);
    expect(counters.collectionIndex.builds).toBe(0);
    runtime.dispose();
  });
});
