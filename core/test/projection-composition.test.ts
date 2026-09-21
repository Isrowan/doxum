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
} from 'doxum';

describe('keyed composition', () => {
  describe('derive.keyed.from', () => {
    it('constructs a keyed projection from static values in formal array order', () => {
      const rows = derive.keyed.from(
        [
          { id: 'b', value: 2 },
          { id: 'a', value: 1 },
        ] as const,
        row => row.id
      );
      const runtime = createProjectionRuntime();
      expect([...runtime.read(rows)]).toEqual([
        ['b', { id: 'b', value: 2 }],
        ['a', { id: 'a', value: 1 }],
      ]);
      runtime.dispose();
    });

    it('snapshots a mutable static outer array at definition creation', () => {
      const values = [{ id: 'a', value: 1 }];
      const rows = derive.keyed.from(values, row => row.id);
      values.push({ id: 'b', value: 2 });
      const runtime = createProjectionRuntime();
      expect([...runtime.read(rows)]).toEqual([['a', { id: 'a', value: 1 }]]);
      runtime.dispose();
    });

    it('tracks scalar arrays with exact membership, value, and order semantics', () => {
      const a = { id: 'a', value: 1 };
      const values = input<readonly { readonly id: string; readonly value: number }[]>([
        a,
        { id: 'b', value: 2 },
      ]);
      const rows = derive.keyed.from(values, row => row.id);
      const runtime = createProjectionRuntime();
      expect(runtime.read(rows).get('a')).toBe(a);

      runtime.update(values, [{ id: 'b', value: 20 }, { id: 'c', value: 3 }, a]);

      expect([...runtime.read(rows)]).toEqual([
        ['b', { id: 'b', value: 20 }],
        ['c', { id: 'c', value: 3 }],
        ['a', a],
      ]);
      expect(runtime.read(rows).get('a')).toBe(a);
      runtime.dispose();
    });

    it('uses equality to suppress value-only no-ops and preserve published identity', () => {
      const initial = { id: 'a', revision: 1 };
      const values = input<readonly { readonly id: string; readonly revision: number }[]>([
        initial,
      ]);
      const rows = derive.keyed.from(
        values,
        row => row.id,
        (left, right) => left.id === right.id
      );
      const runtime = createProjectionRuntime();
      const readable = runtime.select(rows);
      const listener = vi.fn();
      readable.subscribe(listener);
      const revision = readable.revision();

      runtime.update(values, [{ id: 'a', revision: 2 }]);

      expect(readable.revision()).toBe(revision);
      expect(listener).not.toHaveBeenCalled();
      expect(runtime.read(rows).get('a')).toBe(initial);
      runtime.dispose();
    });

    it('publishes reorder-only changes without replacing unchanged values', () => {
      const a = { id: 'a', value: 1 };
      const b = { id: 'b', value: 2 };
      const values = input<readonly (typeof a)[]>([a, b]);
      const rows = derive.keyed.from(values, row => row.id);
      const runtime = createProjectionRuntime();
      const items = runtime.items(rows);
      const aItem = items.get('a');
      const aListener = vi.fn();
      const keysListener = vi.fn();
      aItem.subscribe(aListener);
      items.keys.subscribe(keysListener);

      runtime.update(values, [b, a]);

      expect([...runtime.read(rows).keys()]).toEqual(['b', 'a']);
      expect(items.get('a')).toBe(aItem);
      expect(aListener).not.toHaveBeenCalled();
      expect(keysListener).toHaveBeenCalledTimes(1);
      runtime.dispose();
    });

    it('rejects duplicate keys without partial publication and recovers from valid input', () => {
      const values = input<readonly { readonly id: string; readonly value: number }[]>([
        { id: 'a', value: 1 },
      ]);
      const rows = derive.keyed.from(values, row => row.id);
      const errors: unknown[] = [];
      const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
      expect([...runtime.read(rows)]).toEqual([['a', { id: 'a', value: 1 }]]);

      runtime.update(values, [
        { id: 'x', value: 2 },
        { id: 'x', value: 3 },
      ]);
      expect(errors).toHaveLength(1);
      expect(() => runtime.read(rows)).toThrow();

      runtime.update(values, [{ id: 'b', value: 4 }]);
      expect([...runtime.read(rows)]).toEqual([['b', { id: 'b', value: 4 }]]);
      runtime.dispose();
    });

    it('rejects duplicate keys during initial materialization', () => {
      const rows = derive.keyed.from(
        [
          { id: 'a', value: 1 },
          { id: 'a', value: 2 },
        ],
        row => row.id
      );
      const runtime = createProjectionRuntime();
      expect(() => runtime.read(rows)).toThrow();
      runtime.dispose();
    });

    it('rejects invalid and asynchronous key selectors', () => {
      const invalid = derive.keyed.from([1], () => 1 as never);
      const asynchronous = derive.keyed.from([1], () => Promise.resolve('a') as never);
      const invalidRuntime = createProjectionRuntime();
      expect(() => invalidRuntime.read(invalid)).toThrow();
      invalidRuntime.dispose();
      const asyncRuntime = createProjectionRuntime();
      expect(() => asyncRuntime.read(asynchronous)).toThrow();
      asyncRuntime.dispose();
    });

    it('supports present undefined values and special string keys', () => {
      const undefinedValue = derive.keyed.from<'undefined-key', undefined>(
        [undefined],
        () => 'undefined-key'
      );
      const special = derive.keyed.from(
        [
          { key: '__proto__', value: 1 },
          { key: 'constructor', value: 2 },
        ],
        entry => entry.key
      );
      const runtime = createProjectionRuntime();
      expect(runtime.read(undefinedValue).has('undefined-key')).toBe(true);
      expect(runtime.read(undefinedValue).get('undefined-key')).toBeUndefined();
      expect([...runtime.read(special).keys()]).toEqual(['__proto__', 'constructor']);
      runtime.dispose();
    });

    it('reuses one static definition across independent runtimes and respects scope ownership', () => {
      const rows = derive.keyed.from([{ id: 'a', value: 1 }], row => row.id);
      const first = createProjectionRuntime();
      const second = createProjectionRuntime();
      expect([...first.read(rows)]).toEqual([['a', { id: 'a', value: 1 }]]);
      expect([...second.read(rows)]).toEqual([['a', { id: 'a', value: 1 }]]);
      first.dispose();
      second.dispose();

      const scopedRows = derive.keyed.from([{ id: 's', value: 2 }], row => row.id);
      const runtime = createProjectionRuntime();
      const scope = runtime.scope();
      scope.own(scopedRows);
      expect([...scope.read(scopedRows)]).toEqual([['s', { id: 's', value: 2 }]]);
      scope.dispose();
      expect(() => scope.read(scopedRows)).toThrow(ProjectionDisposedError);
      runtime.dispose();
    });
  });

  describe('derive.keyed.merge', () => {
    it('supports empty and single-source merges without identity shortcuts', () => {
      const empty = derive.keyed.merge<string, number>([], { conflict: 'error' });
      const source = input.collection(new Map([['a', 1]]));
      const merged = derive.keyed.merge([source], { conflict: 'error' });
      expect(merged).not.toBe(source);
      const runtime = createProjectionRuntime();
      expect([...runtime.read(empty)]).toEqual([]);
      expect([...runtime.read(merged)]).toEqual([['a', 1]]);
      runtime.dispose();
    });

    it('uses union membership and stable first-occurrence source order', () => {
      const first = input.collection(
        new Map<string, number>([
          ['a', 1],
          ['c', 3],
        ])
      );
      const second = input.collection(
        new Map<string, number>([
          ['b', 2],
          ['a', 10],
          ['d', 4],
        ])
      );
      const third = input.collection(
        new Map<string, number>([
          ['c', 30],
          ['e', 5],
        ])
      );
      const merged = derive.keyed.merge([first, second, third], { conflict: 'last' });
      const runtime = createProjectionRuntime();
      expect([...runtime.read(merged)]).toEqual([
        ['a', 10],
        ['c', 30],
        ['b', 2],
        ['d', 4],
        ['e', 5],
      ]);
      runtime.dispose();
    });

    it('implements first, last, and resolver conflicts with source-priority contributions', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['a', 2]]));
      const third = input.collection(new Map([['a', 3]]));
      const resolver = vi.fn(
        (contributions: readonly { readonly sourceIndex: number; readonly value: number }[]) =>
          contributions.reduce((sum, entry) => sum + entry.value, 0)
      );
      const firstWins = derive.keyed.merge([first, second, third], { conflict: 'first' });
      const lastWins = derive.keyed.merge([first, second, third], { conflict: 'last' });
      const resolved = derive.keyed.merge([first, second, third], {
        conflict: 'resolve',
        resolve: resolver,
      });
      const runtime = createProjectionRuntime();
      expect(runtime.read(firstWins).get('a')).toBe(1);
      expect(runtime.read(lastWins).get('a')).toBe(3);
      expect(runtime.read(resolved).get('a')).toBe(6);
      expect(resolver).toHaveBeenCalledWith(
        [
          { sourceIndex: 0, value: 1 },
          { sourceIndex: 1, value: 2 },
          { sourceIndex: 2, value: 3 },
        ],
        'a'
      );
      runtime.dispose();
    });

    it('does not invoke the resolver for keys with a single contribution', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['b', 2]]));
      const resolver = vi.fn(() => 0);
      const merged = derive.keyed.merge([first, second], {
        conflict: 'resolve',
        resolve: resolver,
      });
      const runtime = createProjectionRuntime();
      expect([...runtime.read(merged)]).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      expect(resolver).not.toHaveBeenCalled();
      runtime.dispose();
    });

    it('rejects error-policy conflicts and recovers after the overlap is removed', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection<string, number>();
      const merged = derive.keyed.merge([first, second], { conflict: 'error' });
      const errors: unknown[] = [];
      const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
      expect([...runtime.read(merged)]).toEqual([['a', 1]]);

      runtime.update(second, draft => draft.set('a', 2));
      expect(errors).toHaveLength(1);
      expect(() => runtime.read(merged)).toThrow();

      runtime.update(second, draft => draft.remove('a'));
      expect([...runtime.read(merged)]).toEqual([['a', 1]]);
      runtime.dispose();
    });

    it('rejects an initial error-policy conflict', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['a', 2]]));
      const merged = derive.keyed.merge([first, second], { conflict: 'error' });
      const runtime = createProjectionRuntime();
      expect(() => runtime.read(merged)).toThrow();
      runtime.dispose();
    });

    it('snapshots the source list at definition creation', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['b', 2]]));
      const sources = [first];
      const merged = derive.keyed.merge(sources, { conflict: 'error' });
      sources.push(second);
      const runtime = createProjectionRuntime();
      expect([...runtime.read(merged)]).toEqual([['a', 1]]);
      runtime.dispose();
    });

    it('keeps position semantics independent from last-wins value semantics', () => {
      const base = input.collection(
        new Map<string, string>([
          ['base-first', 'base'],
          ['shared', 'base-shared'],
        ])
      );
      const overrides = input.collection(
        new Map<string, string>([
          ['shared', 'override-shared'],
          ['override-only', 'override'],
        ])
      );
      const merged = derive.keyed.merge([base, overrides], { conflict: 'last' });
      const runtime = createProjectionRuntime();
      expect([...runtime.read(merged)]).toEqual([
        ['base-first', 'base'],
        ['shared', 'override-shared'],
        ['override-only', 'override'],
      ]);
      runtime.dispose();
    });

    it('moves a key when an earlier source gains its first formal occurrence', () => {
      const first = input.collection(new Map([['c', 3]]));
      const second = input.collection(
        new Map([
          ['a', 1],
          ['b', 2],
          ['c', 30],
        ])
      );
      const merged = derive.keyed.merge([first, second], { conflict: 'last' });
      const runtime = createProjectionRuntime();
      expect([...runtime.read(merged).keys()]).toEqual(['c', 'a', 'b']);
      runtime.update(first, draft => draft.set('b', 20));
      expect([...runtime.read(merged).keys()]).toEqual(['c', 'b', 'a']);
      expect(runtime.read(merged).get('b')).toBe(2);
      runtime.dispose();
    });

    it('preserves membership lifecycle when a winner source is removed and a fallback remains', () => {
      const first = input.collection(new Map([['b', { source: 'first' }]]));
      const second = input.collection(
        new Map([
          ['a', { source: 'second-a' }],
          ['b', { source: 'second-b' }],
        ])
      );
      const merged = derive.keyed.merge([first, second], { conflict: 'first' });
      const runtime = createProjectionRuntime();
      const items = runtime.items(merged);
      const b = items.get('b');
      expect(b.current()).toEqual({ source: 'first' });

      runtime.update(first, draft => draft.remove('b'));

      expect(items.get('b')).toBe(b);
      expect(b.current()).toEqual({ source: 'second-b' });
      expect([...runtime.read(merged).keys()]).toEqual(['a', 'b']);
      runtime.dispose();
    });

    it('suppresses shadowed updates and only publishes the effective value', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['a', 2]]));
      const merged = derive.keyed.merge([first, second], { conflict: 'first' });
      const runtime = createProjectionRuntime();
      const readable = runtime.select(merged);
      const listener = vi.fn();
      readable.subscribe(listener);
      const revision = readable.revision();

      runtime.update(second, draft => draft.set('a', 3));

      expect(readable.revision()).toBe(revision);
      expect(listener).not.toHaveBeenCalled();
      expect(runtime.read(merged).get('a')).toBe(1);
      runtime.dispose();
    });

    it('uses equality on final effective values and preserves the previous published identity', () => {
      const base = { id: 'a', payload: 'base' };
      const override = { id: 'a', payload: 'override' };
      const first = input.collection(new Map([['a', base]]));
      const second = input.collection(new Map([['a', override]]));
      const merged = derive.keyed.merge([first, second], {
        conflict: 'last',
        equality: (left, right) => left.id === right.id,
      });
      const runtime = createProjectionRuntime();
      expect(runtime.read(merged).get('a')).toBe(override);

      runtime.update(second, draft => draft.remove('a'));

      expect(runtime.read(merged).get('a')).toBe(override);
      runtime.dispose();
    });

    it('processes all changed sources in one batch and resolves each affected key once', () => {
      const first = input.collection(
        new Map([
          ['a', 1],
          ['x', 10],
        ])
      );
      const second = input.collection(
        new Map([
          ['a', 2],
          ['y', 20],
        ])
      );
      const resolver = vi.fn((contributions: readonly { readonly value: number }[]) =>
        contributions.reduce((sum, entry) => sum + entry.value, 0)
      );
      const merged = derive.keyed.merge([first, second], {
        conflict: 'resolve',
        resolve: resolver,
      });
      const runtime = createProjectionRuntime();
      runtime.read(merged);
      resolver.mockClear();

      runtime.batch(() => {
        runtime.update(first, draft => {
          draft.set('a', 3);
          draft.set('x', 11);
        });
        runtime.update(second, draft => {
          draft.set('a', 4);
          draft.set('y', 21);
        });
      });

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(runtime.read(merged).get('a')).toBe(7);
      expect(runtime.read(merged).get('x')).toBe(11);
      expect(runtime.read(merged).get('y')).toBe(21);
      runtime.dispose();
    });

    it('does not run the resolver for source order-only changes', () => {
      const firstRaw = input.collection(
        new Map([
          ['a', 1],
          ['b', 2],
        ])
      );
      const secondRaw = input.collection(
        new Map([
          ['a', 10],
          ['b', 20],
        ])
      );
      const firstOrder = input<readonly string[]>(['a', 'b']);
      const first = derive.keyed.subset(firstRaw, firstOrder);
      const resolver = vi.fn((contributions: readonly { readonly value: number }[]) =>
        contributions.reduce((sum, entry) => sum + entry.value, 0)
      );
      const merged = derive.keyed.merge([first, secondRaw], {
        conflict: 'resolve',
        resolve: resolver,
      });
      const runtime = createProjectionRuntime();
      runtime.read(merged);
      resolver.mockClear();

      runtime.update(firstOrder, ['b', 'a']);

      expect(resolver).not.toHaveBeenCalled();
      expect([...runtime.read(merged).keys()]).toEqual(['b', 'a']);
      runtime.dispose();
    });

    it('supports present undefined contributions using membership rather than value checks', () => {
      const first = input.collection<string, number | undefined>(new Map([['a', undefined]]));
      const second = input.collection<string, number | undefined>();
      const merged = derive.keyed.merge([first, second], { conflict: 'last' });
      const runtime = createProjectionRuntime();
      expect(runtime.read(merged).has('a')).toBe(true);
      expect(runtime.read(merged).get('a')).toBeUndefined();
      runtime.dispose();
    });

    it('rebuilds from current source reads after reset while preserving surviving membership', () => {
      const schema = object({ rows: map(field<number>()) });
      const document = createDocument({
        schema,
        initial: { rows: { a: 1, b: 2 } },
      });
      const base = observe(document, path => path.rows);
      const overrides = input.collection(
        new Map([
          ['b', 20],
          ['c', 30],
        ])
      );
      const merged = derive.keyed.merge([base, overrides], { conflict: 'last' });
      const runtime = createProjectionRuntime();
      const items = runtime.items(merged);
      const b = items.get('b');
      expect([...runtime.read(merged)]).toEqual([
        ['a', 1],
        ['b', 20],
        ['c', 30],
      ]);

      document.replace({ rows: { b: 3, d: 4 } });

      expect([...runtime.read(merged)]).toEqual([
        ['b', 20],
        ['d', 4],
        ['c', 30],
      ]);
      expect(items.get('b')).toBe(b);
      expect(b.current()).toBe(20);
      document.dispose();
      runtime.dispose();
    });

    it('rejects asynchronous resolvers and recovers when the conflict disappears', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['a', 2]]));
      const merged = derive.keyed.merge([first, second], {
        conflict: 'resolve',
        resolve: (() => Promise.resolve(3)) as never,
      });
      const errors: unknown[] = [];
      const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
      expect(() => runtime.read(merged)).toThrow();
      expect(errors).toHaveLength(0);
      runtime.dispose();
    });

    it('binds merged projections to scope ownership and disposal', () => {
      const first = input.collection(new Map([['a', 1]]));
      const second = input.collection(new Map([['b', 2]]));
      const merged = derive.keyed.merge([first, second], { conflict: 'error' });
      const runtime = createProjectionRuntime();
      const scope = runtime.scope();
      scope.own(merged);
      expect([...scope.read(merged)]).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      scope.dispose();
      expect(() => scope.read(merged)).toThrow(ProjectionDisposedError);
      runtime.dispose();
    });
  });
});
