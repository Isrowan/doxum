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
  type Projection,
} from 'doxum';
import { incremental, type CollectionChange } from 'doxum/advanced';
import { startProfile } from '@/profile';

describe('derive.keyed.singleton', () => {
  it('lazily combines named inputs in one processor and ignores unrelated changes', () => {
    const enabled = input(false);
    const count = input(1);
    const unrelated = input(0);
    const compute = vi.fn(({ enabled, count }: { enabled: boolean; count: number }) =>
      enabled ? (['count', count] as const) : undefined
    );
    const singleton = derive.keyed.singleton({ enabled, count }, compute);
    const runtime = createProjectionRuntime();
    expect(compute).not.toHaveBeenCalled();
    expect([...runtime.read(singleton)]).toEqual([]);
    compute.mockClear();
    runtime.update(unrelated, 1);
    expect(compute).not.toHaveBeenCalled();
    const listener = vi.fn();
    runtime.select(singleton).subscribe(listener);
    const profile = startProfile();
    runtime.batch(() => {
      runtime.update(enabled, true);
      runtime.update(count, 2);
      expect([...runtime.read(singleton)]).toEqual([['count', 2]]);
      expect(listener).not.toHaveBeenCalled();
    });
    const counters = profile.stop();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(counters.projection.processedNodes).toBe(1);
    expect(counters.collectionView.idsScanned).toBe(0);
    expect(counters.collectionIndex.builds).toBe(0);
    runtime.dispose();
  });

  it.each(['scalar', 'named'] as const)(
    'preserves equal references, membership and formal order with %s inputs',
    form => {
      type Value = { readonly id: string; readonly n: number };
      const initial: Value = { id: 'a', n: 1 };
      const source = input<Value | undefined>(initial);
      const equality = (left: Value, right: Value) => left.n === right.n;
      const singleton =
        form === 'scalar'
          ? derive.keyed.singleton(source, value => value.id, equality)
          : derive.keyed.singleton(
              { source },
              ({ source }) => (source === undefined ? undefined : [source.id, source]),
              equality
            );
      const changes: CollectionChange<string, Value>[] = [];
      const recorder = incremental(
        { singleton },
        {
          process: context => {
            if (context.changes.singleton) changes.push(context.changes.singleton);
            return context.values.singleton.size;
          },
        }
      );
      const runtime = createProjectionRuntime();
      runtime.read(recorder);
      const readable = runtime.select(singleton);
      const snapshot = readable.current();
      const listener = vi.fn();
      readable.subscribe(listener);
      changes.length = 0;
      runtime.update(source, { id: 'a', n: 1 });
      expect(readable.current()).toBe(snapshot);
      expect(runtime.read(singleton).get('a')).toBe(initial);
      expect(listener).not.toHaveBeenCalled();
      expect(changes).toEqual([]);
      runtime.update(source, { id: 'a', n: 2 });
      expect(changes[0]).toMatchObject({
        kind: 'incremental',
        added: [],
        removed: [],
        updated: [{ key: 'a', before: initial, after: { id: 'a', n: 2 } }],
      });
      changes.length = 0;
      runtime.update(source, { id: 'b', n: 2 });
      expect(changes[0]).toEqual({
        kind: 'incremental',
        added: [{ key: 'b', after: { id: 'b', n: 2 } }],
        removed: [{ key: 'a', before: { id: 'a', n: 2 } }],
        updated: [],
      });
      expect([...runtime.read(singleton).keys()]).toEqual(['b']);
      runtime.update(source, undefined);
      expect([...runtime.read(singleton)]).toEqual([]);
      runtime.update(source, { id: '', n: 3 });
      expect([...runtime.read(singleton)]).toEqual([['', { id: '', n: 3 }]]);
      expect([...snapshot]).toEqual([['a', initial]]);
      runtime.dispose();
    }
  );

  it('distinguishes an absent entry from a present undefined value', () => {
    const present = input(true);
    const singleton = derive.keyed.singleton({ present }, ({ present }) =>
      present ? ['optional', undefined] : undefined
    );
    const runtime = createProjectionRuntime();
    expect([...runtime.read(singleton)]).toEqual([['optional', undefined]]);
    expect(runtime.read(singleton).has('optional')).toBe(true);
    runtime.update(present, false);
    expect(runtime.read(singleton).has('optional')).toBe(false);
    runtime.dispose();
  });

  it('uses the notification boundary for net changes and item lifecycles', () => {
    const key = input<string | undefined>('a');
    const value = input(1);
    const singleton = derive.keyed.singleton({ key, value }, ({ key, value }) =>
      key === undefined ? undefined : [key, value]
    );
    const runtime = createProjectionRuntime();
    const items = runtime.items(singleton);
    const a = items.get('a');
    const listener = vi.fn();
    const keysListener = vi.fn();
    runtime.select(singleton).subscribe(listener);
    items.keys.subscribe(keysListener);
    runtime.batch(() => {
      runtime.update(key, 'b');
      expect([...runtime.read(singleton)]).toEqual([['b', 1]]);
      expect(a.current()).toBeUndefined();
      runtime.update(key, undefined);
      expect(runtime.read(singleton).size).toBe(0);
      runtime.batch(() => {
        runtime.update(key, 'a');
        runtime.update(value, 2);
        expect(a.current()).toBe(2);
        expect(items.get('a')).toBe(a);
      });
      expect(listener).not.toHaveBeenCalled();
      runtime.update(value, 1);
    });
    expect(listener).not.toHaveBeenCalled();
    expect(keysListener).not.toHaveBeenCalled();
    runtime.update(value, 3);
    expect(items.get('a')).toBe(a);
    expect(a.current()).toBe(3);
    expect(keysListener).not.toHaveBeenCalled();
    runtime.update(key, undefined);
    runtime.update(key, 'a');
    expect(items.get('a')).not.toBe(a);
    expect(a.current()).toBeUndefined();
    runtime.dispose();
  });

  it('captures named dependencies and composes precise keyed lookups', () => {
    const records = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const key = input('a');
    const record = derive.keyed.get(records, key);
    const select = vi.fn(({ record }: { record: number | undefined }) =>
      record === undefined ? undefined : (['active', record] as const)
    );
    const exact = derive.keyed.singleton({ record }, select);
    const snapshots: ReadonlyMap<string, number>[] = [];
    const dependencies = { records };
    const whole = derive.keyed.singleton(dependencies, values => {
      expect(Object.isFrozen(values)).toBe(true);
      snapshots.push(values.records);
      return ['snapshot', values.records];
    });
    dependencies.records = input.collection(new Map([['other', 9]]));
    const runtime = createProjectionRuntime();
    runtime.read(exact);
    expect(runtime.read(whole).get('snapshot')?.get('a')).toBe(1);
    select.mockClear();
    runtime.update(records, draft => draft.set('b', 3));
    expect(select).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].get('b')).toBe(2);
    runtime.update(key, 'b');
    expect(runtime.read(exact).get('active')).toBe(3);
    runtime.update(records, draft => draft.remove('b'));
    expect(runtime.read(exact).size).toBe(0);
    runtime.dispose();
  });

  it.each(['compute', 'tuple', 'equality'] as const)(
    'keeps the prior output on %s failure and recovers normally',
    failure => {
      const fail = input(false);
      const initial = { n: 1 };
      const onError = vi.fn();
      const singleton = derive.keyed.singleton(
        { fail },
        ({ fail }) => {
          if (fail && failure === 'compute') throw new Error('compute failed');
          if (fail && failure === 'tuple')
            return ['b'] as unknown as readonly [string, typeof initial];
          return ['a', { n: fail ? 2 : 1 }];
        },
        (left, right) => {
          if (failure === 'equality' && right.n === 2) throw new Error('equality failed');
          return left.n === right.n;
        }
      );
      const runtime = createProjectionRuntime({ onError });
      const readable = runtime.select(singleton);
      const snapshot = readable.current();
      const previous = snapshot.get('a');
      const listener = vi.fn();
      readable.subscribe(listener);
      runtime.batch(() => {
        runtime.update(fail, true);
        expect(() => readable.current()).toThrow(ProjectionError);
        expect(listener).not.toHaveBeenCalled();
        runtime.update(fail, false);
        expect([...readable.current()]).toEqual([['a', initial]]);
        expect(readable.current().get('a')).toBe(previous);
      });
      expect([...snapshot]).toEqual([['a', initial]]);
      expect(onError).toHaveBeenCalled();
      runtime.dispose();
    }
  );

  it.each([
    ['promise', Promise.resolve(undefined)],
    ['thenable', { then: () => undefined }],
    ['null', null],
    ['false', false],
    ['empty array', []],
    ['short tuple', ['a']],
    ['long tuple', ['a', 1, 2]],
    ['numeric key', [1, 'value']],
  ])('rejects a malformed %s result during initialization', (_label, invalid) => {
    const singleton = derive.keyed.singleton(
      {},
      () => invalid as unknown as readonly [string, number]
    );
    const runtime = createProjectionRuntime();
    expect(() => runtime.read(singleton)).toThrow();
    runtime.dispose();
  });

  it('validates dependency, callback, equality and reentrancy boundaries', () => {
    const source = input(1);
    const compute = () => ['a', 1] as const;
    for (const invalid of [
      null,
      { bad: 1 },
      { bad: { source } },
      Object.defineProperty({}, 'source', { value: source }),
      {
        get source() {
          throw new Error('must not execute getter');
        },
      },
      { [Symbol()]: source },
    ]) {
      expect(() =>
        derive.keyed.singleton(invalid as Record<string, Projection<unknown>>, compute)
      ).toThrow();
    }
    expect(() => derive.keyed.singleton({}, null as unknown as typeof compute)).toThrow('callback');
    expect(() =>
      derive.keyed.singleton({}, compute, 1 as unknown as (a: number, b: number) => boolean)
    ).toThrow('equality');
    expect(() =>
      derive.keyed.singleton(source, () => 'a', 1 as unknown as (a: number, b: number) => boolean)
    ).toThrow('equality');
    expect(() => derive.keyed.singleton(input.collection(), () => 'a')).toThrow('scalar');
    const runtime = createProjectionRuntime();
    const bypass = derive.keyed.singleton({ source }, () => ['a', runtime.read(source)]);
    expect(() => runtime.read(bypass)).toThrow('re-entered');
    runtime.dispose();
  });

  it('isolates runtimes, handles document resets, and disposes scoped constants', () => {
    const document = createDocument({ schema: object({ n: field<number>() }), initial: { n: 1 } });
    const n = observe(document, path => path.n);
    const key = input('a');
    const singleton = derive.keyed.singleton({ n, key }, ({ n, key }) => [key, n]);
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    const leftItem = left.items(singleton).get('a');
    const rightItem = right.items(singleton).get('a');
    expect(leftItem).not.toBe(rightItem);
    left.update(key, 'left');
    document.replace({ n: 2 });
    expect([...left.read(singleton)]).toEqual([['left', 2]]);
    expect([...right.read(singleton)]).toEqual([['a', 2]]);
    const scope = left.scope();
    const local = scope.own(derive.keyed.singleton({}, () => ['constant', 3]));
    const item = scope.items(local).get('constant');
    expect(item.current()).toBe(3);
    scope.dispose();
    expect(() => item.current()).toThrow(ProjectionDisposedError);
    expect(() => scope.read(local)).toThrow(ProjectionDisposedError);
    left.dispose();
    expect(() => left.read(singleton)).toThrow(ProjectionDisposedError);
    expect(rightItem.current()).toBe(2);
    right.dispose();
    document.dispose();
  });
});
