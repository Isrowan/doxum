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
  type Projection,
} from 'doxum';
import { incremental, type CollectionChange } from 'doxum/advanced';
import { startProfile } from '@/profile';

describe('keyed selection', () => {
  it('computes named selection lazily and only when its own dependencies change', () => {
    const a = { n: 1 };
    const source = input.collection(
      new Map([
        ['a', a],
        ['b', { n: 2 }],
      ])
    );
    const selection = input({ ids: ['a'], active: 'a' });
    const enabled = input(true);
    const keys = vi.fn(
      ({ selection, enabled }: { selection: { ids: string[] }; enabled: boolean }) =>
        enabled ? selection.ids : []
    );
    const key = vi.fn(
      ({ selection, enabled }: { selection: { active: string }; enabled: boolean }) =>
        enabled ? selection.active : undefined
    );
    const subset = derive.keyed.subset(source, { selection, enabled }, keys);
    const member = derive.keyed.get(source, { selection, enabled }, key);
    expect(keys).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    const runtime = createProjectionRuntime();
    const subsetReadable = runtime.select(subset);
    const memberReadable = runtime.select(member);
    const before = subsetReadable.current();
    expect(memberReadable.current()).toBe(a);
    const notify = vi.fn();
    subsetReadable.subscribe(notify);
    memberReadable.subscribe(notify);
    keys.mockClear();
    key.mockClear();
    runtime.update(source, draft => draft.set('b', { n: 3 }));
    expect(keys).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    expect(subsetReadable.current()).toBe(before);
    expect(notify).not.toHaveBeenCalled();
    runtime.update(selection, { ids: ['a'], active: 'a' });
    expect(keys).toHaveBeenCalledTimes(1);
    expect(key).toHaveBeenCalledTimes(1);
    expect(subsetReadable.current()).toBe(before);
    expect(notify).not.toHaveBeenCalled();
    runtime.batch(() => {
      runtime.update(selection, { ids: ['a'], active: 'a' });
      runtime.update(source, draft => draft.set('a', { n: 4 }));
      expect(runtime.read(member)).toBe(runtime.read(source).get('a'));
      expect(runtime.read(subset).get('a')).toBe(runtime.read(source).get('a'));
      expect(notify).not.toHaveBeenCalled();
    });
    expect(notify).toHaveBeenCalledTimes(2);
    runtime.update(enabled, false);
    expect(runtime.read(subset).size).toBe(0);
    expect(runtime.read(member)).toBeUndefined();
    runtime.dispose();
  });

  it.each(['static', 'projection', 'named'] as const)(
    'retains missing requests, source references and requested order with %s selection',
    form => {
      const a = { n: 1 };
      const source = input.collection<string, { n: number } | undefined>(
        new Map([
          ['a', a],
          ['b', { n: 2 }],
        ])
      );
      const initialKeys = ['missing', 'a', 'undefined'];
      const requested = input<readonly string[]>(initialKeys);
      const key = input<string | undefined>('missing');
      const subset =
        form === 'static'
          ? derive.keyed.subset(source, initialKeys)
          : form === 'projection'
            ? derive.keyed.subset(source, requested)
            : derive.keyed.subset(source, { requested }, ({ requested }) => requested);
      const member =
        form === 'static'
          ? derive.keyed.get(source, 'missing')
          : form === 'projection'
            ? derive.keyed.get(source, key)
            : derive.keyed.get(source, { key }, ({ key }) => key);
      const runtime = createProjectionRuntime();
      expect([...runtime.read(subset)]).toEqual([['a', a]]);
      expect(runtime.read(member)).toBeUndefined();
      if (form === 'static') initialKeys.reverse(); // definition owns its static array snapshot
      runtime.update(source, draft => {
        draft.set('undefined', undefined);
        draft.set('missing', { n: 3 });
      });
      expect([...runtime.read(subset).keys()]).toEqual(['missing', 'a', 'undefined']);
      expect(runtime.read(subset).has('undefined')).toBe(true);
      expect(runtime.read(subset).get('a')).toBe(a);
      expect(runtime.read(member)).toBe(runtime.read(source).get('missing'));
      runtime.update(source, draft => draft.remove('missing'));
      expect([...runtime.read(subset).keys()]).toEqual(['a', 'undefined']);
      runtime.update(source, draft => draft.set('missing', { n: 4 }));
      expect([...runtime.read(subset).keys()]).toEqual(['missing', 'a', 'undefined']);
      expect(runtime.read(member)?.n).toBe(4);
      runtime.dispose();
    }
  );

  it('reconciles simultaneous key, membership and value changes using final source values', () => {
    const source = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ])
    );
    const selection = input<readonly string[]>(['a', 'b']);
    const subset = derive.keyed.subset(source, { selection }, ({ selection }) => selection);
    const member = derive.keyed.get(source, { selection }, ({ selection }) => selection[0]);
    const changes: CollectionChange<string, number>[] = [];
    const recorder = incremental(
      { subset },
      {
        process: context => {
          if (context.changes.subset) changes.push(context.changes.subset);
          return context.values.subset.size;
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(recorder);
    runtime.read(member);
    changes.length = 0;
    runtime.batch(() => {
      runtime.update(selection, ['c', 'b', 'new']);
      runtime.update(source, draft => {
        draft.set('c', 30);
        draft.set('b', 20);
        draft.set('new', 40);
        draft.remove('a');
      });
    });
    expect([...runtime.read(subset)]).toEqual([
      ['c', 30],
      ['b', 20],
      ['new', 40],
    ]);
    expect(runtime.read(member)).toBe(30);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'incremental',
      added: [
        { key: 'c', after: 30 },
        { key: 'new', after: 40 },
      ],
      removed: [{ key: 'a', before: 1 }],
      updated: [{ key: 'b', before: 2, after: 20 }],
    });
    runtime.dispose();
  });

  it('ignores source-only reorder and publishes only requested reorder without value updates', () => {
    const base = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const sourceOrder = input<readonly string[]>(['a', 'b']);
    const source = derive.keyed.subset(base, sourceOrder);
    const request = input<readonly string[]>(['b', 'a']);
    const keys = vi.fn(({ request }: { request: readonly string[] }) => request);
    const subset = derive.keyed.subset(source, { request }, keys);
    const member = derive.keyed.get(source, 'a');
    const downstream = vi.fn((value: number) => value);
    const mapped = derive.keyed(subset, downstream);
    const runtime = createProjectionRuntime();
    runtime.read(mapped);
    runtime.read(member);
    const before = runtime.read(subset);
    keys.mockClear();
    downstream.mockClear();
    runtime.update(sourceOrder, ['b', 'a']);
    expect(keys).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
    expect(runtime.read(subset)).toBe(before);
    runtime.update(request, ['a', 'b']);
    expect([...runtime.read(mapped).keys()]).toEqual(['a', 'b']);
    expect(downstream).not.toHaveBeenCalled();
    expect(runtime.read(member)).toBe(1);
    runtime.dispose();
  });

  it('uses net notification membership for transient deselection and reselection', () => {
    const source = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const request = input<readonly string[]>(['a']);
    const subset = derive.keyed.subset(source, { request }, ({ request }) => request);
    const runtime = createProjectionRuntime();
    const items = runtime.items(subset);
    const a = items.get('a');
    const notify = vi.fn();
    runtime.select(subset).subscribe(notify);
    runtime.batch(() => {
      runtime.update(request, []);
      expect(a.current()).toBeUndefined();
      runtime.batch(() => {
        runtime.update(request, ['b']);
        expect([...runtime.read(subset).keys()]).toEqual(['b']);
        runtime.update(request, ['a']);
        expect(items.get('a')).toBe(a);
        expect(a.current()).toBe(1);
      });
    });
    expect(notify).not.toHaveBeenCalled();
    runtime.update(request, []);
    runtime.update(request, ['a']);
    expect(items.get('a')).not.toBe(a);
    runtime.dispose();
  });

  it('treats an explicitly declared source as a whole dependency and snapshots named values', () => {
    const source = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const snapshots: ReadonlyMap<string, number>[] = [];
    const declarations = { source };
    const select = vi.fn((values: { readonly source: ReadonlyMap<string, number> }) => {
      expect(Object.isFrozen(values)).toBe(true);
      snapshots.push(values.source);
      return ['a'];
    });
    const subset = derive.keyed.subset(source, declarations, select);
    const getSelect = vi.fn(({ source }: { source: ReadonlyMap<string, number> }) =>
      source.has('a') ? 'a' : undefined
    );
    const member = derive.keyed.get(source, { source }, getSelect);
    declarations.source = input.collection();
    const runtime = createProjectionRuntime();
    runtime.read(subset);
    runtime.read(member);
    select.mockClear();
    getSelect.mockClear();
    runtime.update(source, draft => draft.set('b', 3));
    expect(select).toHaveBeenCalledTimes(1);
    expect(getSelect).toHaveBeenCalledTimes(1);
    expect(snapshots[0].get('b')).toBe(2);
    expect(snapshots[1].get('b')).toBe(3);
    runtime.dispose();
  });

  it('handles constants, undefined and empty-string keys, and get equality', () => {
    const original = { n: 1 };
    const source = input.collection(new Map([['', original]]));
    const empty = derive.keyed.get(source, undefined);
    const equal = vi.fn(
      (left: typeof original | undefined, right: typeof original | undefined) =>
        left?.n === right?.n
    );
    const member = derive.keyed.get(source, {}, () => '', equal);
    const direct = derive.keyed.get(source, '', equal);
    const subset = derive.keyed.subset(source, {}, () => ['']);
    const runtime = createProjectionRuntime();
    expect(runtime.read(empty)).toBeUndefined();
    expect(runtime.read(member)).toBe(original);
    expect(runtime.read(direct)).toBe(original);
    expect(runtime.read(subset).get('')).toBe(original);
    const replacement = { n: 1 };
    runtime.update(source, draft => draft.set('', replacement));
    expect(runtime.read(member)).toBe(original);
    expect(runtime.read(direct)).toBe(original);
    expect(runtime.read(subset).get('')).toBe(replacement);
    runtime.dispose();
  });

  it.each(['compute', 'duplicate', 'key', 'equality'] as const)(
    'publishes no partial output on %s failure and recovers with fresh selection state',
    failure => {
      const source = input.collection(
        new Map([
          ['a', 1],
          ['b', 2],
        ])
      );
      const mode = input(0);
      const errors = vi.fn();
      const subset = derive.keyed.subset(source, { mode }, ({ mode }) => {
        if (mode === 1 && failure === 'compute') throw new Error('selection failed');
        return mode === 1 && failure === 'duplicate' ? ['b', 'b'] : mode === 0 ? ['a'] : ['b'];
      });
      const member = derive.keyed.get(
        source,
        { mode },
        ({ mode }) => {
          if (mode === 1 && failure === 'compute') throw new Error('selection failed');
          if (mode === 1 && failure === 'key') return 1 as unknown as string;
          return mode === 0 ? 'a' : 'b';
        },
        (left, right) => {
          if (failure === 'equality' && right === 2) throw new Error('equality failed');
          return left === right;
        }
      );
      const runtime = createProjectionRuntime({ onError: errors });
      const before = runtime.read(subset);
      runtime.read(member);
      const notify = vi.fn();
      (failure === 'duplicate' ? runtime.select(subset) : runtime.select(member)).subscribe(notify);
      runtime.batch(() => {
        runtime.update(mode, 1);
        expect(() =>
          failure === 'duplicate' ? runtime.read(subset) : runtime.read(member)
        ).toThrow(ProjectionError);
        expect(notify).not.toHaveBeenCalled();
        runtime.update(mode, 0);
        expect([...runtime.read(subset)]).toEqual([['a', 1]]);
        expect(runtime.read(member)).toBe(1);
      });
      expect([...before]).toEqual([['a', 1]]);
      expect(errors).toHaveBeenCalled();
      runtime.dispose();
    }
  );

  it.each([null, undefined, false, 'a', [1], ['a', 'a'], Promise.resolve(['a'])])(
    'rejects malformed computed key lists: %j',
    invalid => {
      const source = input.collection<string, number>();
      const subset = derive.keyed.subset(source, {}, () => invalid as unknown as readonly string[]);
      const runtime = createProjectionRuntime();
      expect(() => runtime.read(subset)).toThrow();
      runtime.dispose();
    }
  );

  it('validates definitions and disallows undeclared reads from selectors', () => {
    const source = input.collection<string, number>();
    for (const invalid of [
      { bad: 1 },
      { bad: { source } },
      { [Symbol()]: source },
      Object.defineProperty({}, 'source', { value: source }),
    ]) {
      expect(() =>
        derive.keyed.get(source, invalid as Record<string, Projection<unknown>>, () => 'a')
      ).toThrow();
      expect(() =>
        derive.keyed.subset(source, invalid as Record<string, Projection<unknown>>, () => ['a'])
      ).toThrow();
    }
    expect(() => derive.keyed.subset(source, ['a', 'a'])).toThrow('duplicate');
    expect(() => derive.keyed.get(source, {}, undefined as unknown as () => string)).toThrow(
      'callback'
    );
    expect(() => derive.keyed.get(source, 'a', 1 as unknown as () => boolean)).toThrow('equality');
    const runtime = createProjectionRuntime();
    const bypass = derive.keyed.subset(source, {}, () => [...runtime.read(source).keys()]);
    expect(() => runtime.read(bypass)).toThrow('re-entered');
    const asyncKey = derive.keyed.get(source, {}, () => Promise.resolve('a') as unknown as string);
    expect(() => runtime.read(asyncKey)).toThrow();
    runtime.dispose();
  });

  it('isolates runtimes, resets source values without recomputing independent selection, and disposes scopes', () => {
    const document = createDocument({
      schema: object({ rows: map(field<number>()) }),
      initial: { rows: { a: 1, b: 2 } },
    });
    const source = observe(document, path => path.rows);
    const request = input<readonly string[]>(['a']);
    const keys = vi.fn(({ request }: { request: readonly string[] }) => request);
    const key = vi.fn(({ request }: { request: readonly string[] }) => request[0]);
    const subset = derive.keyed.subset(source, { request }, keys);
    const member = derive.keyed.get(source, { request }, key);
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    left.read(subset);
    left.read(member);
    right.read(subset);
    right.read(member);
    left.update(request, ['b']);
    keys.mockClear();
    key.mockClear();
    document.replace({ rows: { a: 10, b: 20 } });
    expect([...left.read(subset)]).toEqual([['b', 20]]);
    expect([...right.read(subset)]).toEqual([['a', 10]]);
    expect(left.read(member)).toBe(20);
    expect(right.read(member)).toBe(10);
    expect(keys).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    const scope = left.scope();
    const local = scope.own(derive.keyed.subset(source, {}, () => ['a']));
    const item = scope.items(local).get('a');
    expect(item.current()).toBe(10);
    scope.dispose();
    expect(() => item.current()).toThrow(ProjectionDisposedError);
    left.dispose();
    right.dispose();
    document.dispose();
  });

  it('filters large-source deltas without rerunning selectors, scanning order or touching unselected outputs', () => {
    const source = input.collection(
      new Map(Array.from({ length: 10000 }, (_, i) => [String(i), i]))
    );
    const selected = input({ ids: ['0', '9999'], active: '0' });
    const keys = vi.fn(({ selected }: { selected: { ids: string[] } }) => selected.ids);
    const key = vi.fn(({ selected }: { selected: { active: string } }) => selected.active);
    const subset = derive.keyed.subset(source, { selected }, keys);
    const member = derive.keyed.get(source, { selected }, key);
    const downstream = vi.fn((n: number) => n * 2);
    const mapped = derive.keyed(subset, downstream);
    const runtime = createProjectionRuntime();
    runtime.read(mapped);
    runtime.read(member);
    keys.mockClear();
    key.mockClear();
    downstream.mockClear();
    let measuring = startProfile();
    runtime.update(source, draft => draft.set('5000', -1));
    let counters = measuring.stop();
    expect(keys).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
    expect(counters.projection.touchedKeys).toBe(1); // source only
    expect(counters.collectionView.idsScanned).toBe(0);
    expect(counters.collectionIndex.builds).toBe(0);
    measuring = startProfile();
    runtime.batch(() => {
      runtime.update(selected, { ids: ['0', '9999'], active: '0' });
      runtime.update(source, draft => draft.set('0', -2));
    });
    counters = measuring.stop();
    expect(keys).toHaveBeenCalledTimes(1);
    expect(key).toHaveBeenCalledTimes(1);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(counters.projection.processedNodes).toBe(3); // get, subset, mapped: no intermediate derive
    expect(counters.projection.touchedKeys).toBe(3); // source, subset, mapped: only the changed key
    expect(runtime.read(member)).toBe(-2);
    expect(runtime.read(mapped).get('0')).toBe(-4);
    runtime.dispose();
  });
});
