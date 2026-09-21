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
import { incremental } from 'doxum/advanced';

describe('keyed projection evolution', () => {
  it('publishes ordered entries and reuses unchanged tuples', () => {
    const a = { value: 1 };
    const b = { value: 2 };
    const rows = input.collection(
      new Map([
        ['a', a],
        ['b', b],
      ])
    );
    const entries = derive.keyed.entries(rows);
    const runtime = createProjectionRuntime();
    const initial = runtime.read(entries);
    expect(initial).toEqual([
      ['a', a],
      ['b', b],
    ]);

    const nextA = { value: 10 };
    runtime.update(rows, draft => draft.set('a', nextA));
    const updated = runtime.read(entries);
    expect(updated).toEqual([
      ['a', nextA],
      ['b', b],
    ]);
    expect(updated[0]).not.toBe(initial[0]);
    expect(updated[1]).toBe(initial[1]);
    runtime.dispose();
  });

  it('invalidates every current driver key for ordinary incremental.keyed dependencies', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const factor = input(2);
    const process = vi.fn(
      ({
        value,
        dependencies,
      }: {
        readonly value: number;
        readonly dependencies: { factor: number };
      }) => value * dependencies.factor
    );
    const projected = incremental.keyed(rows, { factor }, { process });
    const runtime = createProjectionRuntime();
    expect([...runtime.read(projected)]).toEqual([
      ['a', 2],
      ['b', 4],
    ]);
    process.mockClear();

    runtime.update(factor, 3);
    expect(process).toHaveBeenCalledTimes(2);
    expect([...runtime.read(projected)]).toEqual([
      ['a', 3],
      ['b', 6],
    ]);
    runtime.dispose();
  });

  it('recreates every per-key state after incremental.keyed processor recovery', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const gate = input(1);
    let generation = 0;
    const createState = vi.fn(() => ({ generation: ++generation, calls: 0 }));
    const projected = incremental.keyed(
      rows,
      { gate },
      {
        state: createState,
        process: ({ key, value, dependencies, state, reset }) => {
          state.calls++;
          if (!reset && dependencies.gate === 2 && key === 'b') throw new Error('recover');
          return `${state.generation}:${state.calls}:${value}:${dependencies.gate}`;
        },
      }
    );
    const runtime = createProjectionRuntime({ onError: () => undefined });
    expect([...runtime.read(projected)]).toEqual([
      ['a', '1:1:1:1'],
      ['b', '2:1:2:1'],
    ]);

    runtime.update(gate, 2);
    expect([...runtime.read(projected)]).toEqual([
      ['a', '3:1:1:2'],
      ['b', '4:1:2:2'],
    ]);
    expect(createState).toHaveBeenCalledTimes(4);
    runtime.dispose();
  });

  it('performs scalar keyed lookup with precise invalidation and missing-key binding', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const selectedKey = input<string | undefined>('a');
    const selected = derive.keyed.get(rows, selectedKey);
    const runtime = createProjectionRuntime();
    const readable = runtime.select(selected);
    const listener = vi.fn();
    readable.subscribe(listener);
    expect(readable.current()).toBe(1);
    const revision = readable.revision();

    runtime.update(rows, draft => draft.set('b', 3));
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();

    runtime.update(rows, draft => draft.set('a', 4));
    expect(readable.current()).toBe(4);
    expect(listener).toHaveBeenCalledTimes(1);

    runtime.update(selectedKey, 'missing');
    expect(readable.current()).toBeUndefined();
    runtime.update(rows, draft => draft.set('unrelated', 9));
    expect(listener).toHaveBeenCalledTimes(2);
    runtime.update(rows, draft => draft.set('missing', 7));
    expect(readable.current()).toBe(7);
    expect(listener).toHaveBeenCalledTimes(3);

    runtime.update(selectedKey, undefined);
    expect(readable.current()).toBeUndefined();
    runtime.update(rows, draft => draft.set('missing', 8));
    expect(listener).toHaveBeenCalledTimes(4);
    runtime.dispose();
  });

  it('does not invalidate scalar keyed lookup for source order-only changes', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const order = input<readonly string[]>(['a', 'b']);
    const ordered = derive.keyed.subset(rows, order);
    const selectedKey = input<string | undefined>('a');
    const selected = derive.keyed.get(ordered, selectedKey);
    const runtime = createProjectionRuntime();
    const readable = runtime.select(selected);
    const listener = vi.fn();
    readable.subscribe(listener);
    expect(readable.current()).toBe(1);
    const revision = readable.revision();

    runtime.update(order, ['b', 'a']);
    expect(readable.current()).toBe(1);
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('routes plural dynamic dependencies only to bound driver keys', () => {
    const sections = input.collection(
      new Map([
        ['s1', { recordIds: ['r1', 'r2'] as const }],
        ['s2', { recordIds: ['r3', 'missing'] as const }],
      ])
    );
    const records = input.collection(
      new Map([
        ['r1', 1],
        ['r2', 2],
        ['r3', 3],
        ['unused', 99],
      ])
    );
    const select = vi.fn(
      (
        section: { readonly recordIds: readonly string[] },
        _key: string,
        dependencies: { readonly records: ReadonlyMap<string, number> }
      ) => section.recordIds.reduce((sum, id) => sum + (dependencies.records.get(id) ?? 0), 0)
    );
    const totals = derive.keyed(
      sections,
      { records: { source: records, keys: section => section.recordIds } },
      select
    );
    const runtime = createProjectionRuntime();
    expect([...runtime.read(totals)]).toEqual([
      ['s1', 3],
      ['s2', 3],
    ]);
    select.mockClear();

    runtime.update(records, draft => draft.set('unused', 100));
    expect(select).not.toHaveBeenCalled();
    runtime.update(records, draft => draft.set('r2', 20));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.read(totals).get('s1')).toBe(21);
    select.mockClear();

    runtime.update(records, draft => draft.set('missing', 4));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.read(totals).get('s2')).toBe(7);
    runtime.dispose();
  });

  it('rejects duplicate plural dependency keys', () => {
    const rows = input.collection(new Map([['a', { ids: ['x', 'x'] as const }]]));
    const source = input.collection(new Map([['x', 1]]));
    const derived = derive.keyed(
      rows,
      { values: { source, keys: row => row.ids } },
      (_row, _key, dependencies) => dependencies.values.get('x')
    );
    const runtime = createProjectionRuntime();
    expect(() => runtime.read(derived)).toThrow(/duplicate/i);
    runtime.dispose();
  });

  it('rejects malformed dynamic keyed dependency declarations at definition time', () => {
    const rows = input.collection(new Map([['a', 1]]));
    const source = input.collection(new Map([['x', 1]]));
    const define = (dependency: unknown) =>
      derive.keyed(rows, { value: dependency } as never, value => value);

    expect(() => define({ source, key: () => 'x', extra: true })).toThrow(/unknown property/i);

    const accessor = { source } as { source: typeof source; key?: () => string };
    Object.defineProperty(accessor, 'key', {
      enumerable: true,
      get: () => () => 'x',
    });
    expect(() => define(accessor)).toThrow(/data properties/i);
    expect(() => define({ source, key: () => 'x', keys: () => ['x'] })).toThrow(/exactly one/i);
    expect(() => define({ source })).toThrow(/exactly one/i);
    expect(() => define({ source: 1, key: () => 'x' })).toThrow(/source must be a projection/i);
  });

  it('owns per-membership state and plural reverse invalidation in incremental.keyed', () => {
    const sections = input.collection(
      new Map([
        ['s1', { recordIds: ['r1', 'r2'] as readonly string[] }],
        ['s2', { recordIds: ['r3'] as readonly string[] }],
      ])
    );
    const records = input.collection(
      new Map([
        ['r1', 1],
        ['r2', 2],
        ['r3', 3],
        ['unused', 100],
      ])
    );
    const createState = vi.fn(() => ({ runs: 0 }));
    const process = vi.fn(
      ({
        dependencies,
        state,
      }: {
        readonly dependencies: { readonly records: ReadonlyMap<string, number> };
        readonly state: { runs: number };
      }) => {
        state.runs++;
        const total = [...dependencies.records.values()].reduce((sum, value) => sum + value, 0);
        return `${state.runs}:${total}`;
      }
    );
    const calculated = incremental.keyed(
      sections,
      { records: { source: records, keys: section => section.recordIds } },
      { state: createState, process }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(calculated).get('s1')).toBe('1:3');
    expect(runtime.read(calculated).get('s2')).toBe('1:3');
    expect(createState).toHaveBeenCalledTimes(2);
    process.mockClear();

    runtime.update(records, draft => draft.set('unused', 101));
    expect(process).not.toHaveBeenCalled();
    runtime.update(records, draft => draft.set('r2', 20));
    expect(process).toHaveBeenCalledTimes(1);
    expect(runtime.read(calculated).get('s1')).toBe('2:21');
    expect(createState).toHaveBeenCalledTimes(2);
    process.mockClear();

    runtime.update(sections, draft => draft.remove('s1'));
    runtime.update(sections, draft => draft.set('s1', { recordIds: ['r1'] as readonly string[] }));
    expect(createState).toHaveBeenCalledTimes(3);
    expect(runtime.read(calculated).get('s1')).toBe('1:1');
    runtime.dispose();
  });

  it('does not rerun incremental.keyed processors for driver order-only changes', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const order = input<readonly string[]>(['a', 'b']);
    const ordered = derive.keyed.subset(rows, order);
    const process = vi.fn(({ value }: { readonly value: number }) => value * 10);
    const projected = incremental.keyed(ordered, {}, { process });
    const runtime = createProjectionRuntime();
    expect([...runtime.read(projected).keys()]).toEqual(['a', 'b']);
    process.mockClear();

    runtime.update(order, ['b', 'a']);
    expect(process).not.toHaveBeenCalled();
    expect([...runtime.read(projected).keys()]).toEqual(['b', 'a']);
    runtime.dispose();
  });

  it('keeps incremental.keyed state across reset intersections and recreates new memberships', () => {
    const schema = object({ rows: map(object({ value: field<number>() })) });
    const document = createDocument({
      schema,
      initial: { rows: { a: { value: 1 }, b: { value: 2 } } },
    });
    const rows = observe(document, path => path.rows);
    const states = new Map<string, number>();
    let sequence = 0;
    const projected = incremental.keyed(
      rows,
      {},
      {
        state: (_value, key) => {
          const id = ++sequence;
          states.set(key, id);
          return { id };
        },
        process: ({ state, value }) => `${state.id}:${value.value}`,
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(projected).get('a')).toBe('1:1');
    expect(runtime.read(projected).get('b')).toBe('2:2');

    document.replace({ rows: { a: { value: 10 }, c: { value: 3 } } });
    expect(runtime.read(projected).get('a')).toBe('1:10');
    expect(runtime.read(projected).get('c')).toBe('3:3');
    expect(states.get('a')).toBe(1);

    document.update(draft => draft.rows.put('b', { value: 20 }));
    expect(runtime.read(projected).get('b')).toBe('4:20');
    document.dispose();
    runtime.dispose();
  });

  it('owns keyed readable identity and eviction through runtime.items', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const runtime = createProjectionRuntime();
    const items = runtime.items(rows);
    expect(runtime.items(rows)).toBe(items);
    const a = items.get('a');
    expect(items.get('a')).toBe(a);
    const aListener = vi.fn();
    const keysListener = vi.fn();
    a.subscribe(aListener);
    items.keys.subscribe(keysListener);

    runtime.update(rows, draft => draft.set('b', 3));
    expect(aListener).not.toHaveBeenCalled();
    expect(keysListener).not.toHaveBeenCalled();

    runtime.update(rows, draft => draft.remove('a'));
    expect(a.current()).toBeUndefined();
    expect(aListener).toHaveBeenCalledTimes(1);
    expect(keysListener).toHaveBeenCalledTimes(1);
    const missing = items.get('a');
    expect(missing).not.toBe(a);

    runtime.update(rows, draft => draft.set('a', 4));
    const nextA = items.get('a');
    expect(nextA).not.toBe(a);
    expect(nextA.current()).toBe(4);
    expect(a.current()).toBeUndefined();

    runtime.dispose();
    expect(() => nextA.current()).toThrow(ProjectionDisposedError);
  });

  it('preserves runtime.items identity for a remove-add collapsed inside one batch', () => {
    const rows = input.collection(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const items = runtime.items(rows);
    const a = items.get('a');
    const listener = vi.fn();
    a.subscribe(listener);

    runtime.batch(() => {
      runtime.update(rows, draft => draft.remove('a'));
      runtime.update(rows, draft => draft.set('a', 2));
    });

    expect(items.get('a')).toBe(a);
    expect(a.current()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('binds scope.items lifetime to the owning scope', () => {
    const rows = input.collection(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const scopedItems = scope.items(rows);
    const scopedA = scopedItems.get('a');
    expect(scope.items(rows)).toBe(scopedItems);

    scope.dispose();
    expect(() => scopedA.current()).toThrow(ProjectionDisposedError);
    expect(() => scopedItems.keys.current()).toThrow(ProjectionDisposedError);

    const rootItems = runtime.items(rows);
    expect(rootItems).not.toBe(scopedItems);
    expect(rootItems.get('a').current()).toBe(1);
    runtime.dispose();
  });

  it('attempts every runtime.items listener when one listener fails', () => {
    const rows = input.collection(new Map([['a', 1]]));
    const errors: unknown[] = [];
    const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
    const item = runtime.items(rows).get('a');
    const failure = new Error('item listener failed');
    const second = vi.fn();
    item.subscribe(() => {
      throw failure;
    });
    item.subscribe(second);

    runtime.update(rows, draft => draft.set('a', 2));
    expect(second).toHaveBeenCalledTimes(1);
    expect(item.current()).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: 'listener', cause: failure });
    runtime.dispose();
  });

  it('attempts every selector readable listener when one listener fails', () => {
    const rows = input.collection(new Map([['a', 1]]));
    const errors: unknown[] = [];
    const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
    const selected = runtime.select(rows, value => value.get('a'));
    const failure = new Error('selector listener failed');
    const second = vi.fn();
    selected.subscribe(() => {
      throw failure;
    });
    selected.subscribe(second);

    runtime.update(rows, draft => draft.set('a', 2));
    expect(second).toHaveBeenCalledTimes(1);
    expect(selected.current()).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: 'listener', cause: failure });
    runtime.dispose();
  });

  it('activates subscribed dormant items and never reuses a completed generation', () => {
    const rows = input.collection<string, number>();
    const runtime = createProjectionRuntime();
    const items = runtime.items(rows);
    const dormant = items.get('a');
    const listener = vi.fn();
    dormant.subscribe(listener);
    expect(dormant.current()).toBeUndefined();

    runtime.update(rows, draft => draft.set('a', 1));
    expect(items.get('a')).toBe(dormant);
    expect(dormant.current()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.update(rows, draft => draft.remove('a'));
    expect(dormant.current()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    runtime.update(rows, draft => draft.set('a', 2));
    expect(dormant.current()).toBeUndefined();
    expect(items.get('a')).not.toBe(dormant);
    runtime.dispose();
  });

  it('preserves runtime.items identities across reset intersections', () => {
    const schema = object({ rows: map(field<number>()) });
    const document = createDocument({ schema, initial: { rows: { a: 1, b: 2 } } });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const items = runtime.items(rows);
    const a = items.get('a');
    const b = items.get('b');

    document.replace({ rows: { a: 10, c: 3 } });
    expect(items.get('a')).toBe(a);
    expect(a.current()).toBe(10);
    expect(b.current()).toBeUndefined();
    expect(items.keys.current()).toEqual(['a', 'c']);
    document.dispose();
    runtime.dispose();
  });

  it('groups by snapshot-deterministic source order and updates only semantic grouping changes', () => {
    const rows = input.collection(
      new Map([
        ['a', { groups: ['x'] as readonly string[] }],
        ['b', { groups: ['y', 'x'] as readonly string[] }],
        ['c', { groups: [] as readonly string[] }],
      ])
    );
    const order = input<readonly string[]>(['a', 'b', 'c']);
    const ordered = derive.keyed.subset(rows, order);
    const grouped = derive.keyed.groupBy(ordered, row => row.groups);
    const runtime = createProjectionRuntime();
    expect([...runtime.read(grouped)]).toEqual([
      ['x', ['a', 'b']],
      ['y', ['b']],
    ]);

    runtime.update(order, ['b', 'a', 'c']);
    expect([...runtime.read(grouped)]).toEqual([
      ['y', ['b']],
      ['x', ['b', 'a']],
    ]);

    runtime.update(rows, draft => draft.set('a', { groups: ['y'] }));
    expect([...runtime.read(grouped)]).toEqual([
      ['y', ['b', 'a']],
      ['x', ['b']],
    ]);
    runtime.dispose();
  });

  it('routes groupBy dynamic keyed dependencies through the shared reverse index', () => {
    const rows = input.collection(
      new Map([
        ['a', { metaId: 'm1' }],
        ['b', { metaId: 'm2' }],
      ])
    );
    const metadata = input.collection(
      new Map([
        ['m1', { group: 'x' }],
        ['m2', { group: 'y' }],
        ['unused', { group: 'z' }],
      ])
    );
    const selector = vi.fn(
      (
        row: { readonly metaId: string },
        _key: string,
        dependencies: { readonly meta: { readonly group: string } | undefined }
      ) => dependencies.meta?.group ?? 'missing'
    );
    const grouped = derive.keyed.groupBy(
      rows,
      { meta: { source: metadata, key: row => row.metaId } },
      selector
    );
    const runtime = createProjectionRuntime();
    expect([...runtime.read(grouped)]).toEqual([
      ['x', ['a']],
      ['y', ['b']],
    ]);
    selector.mockClear();

    runtime.update(metadata, draft => draft.set('unused', { group: 'q' }));
    expect(selector).not.toHaveBeenCalled();

    runtime.update(metadata, draft => draft.set('m2', { group: 'x' }));
    expect(selector).toHaveBeenCalledTimes(1);
    expect([...runtime.read(grouped)]).toEqual([['x', ['a', 'b']]]);
    runtime.dispose();
  });

  it('preserves unrelated groupBy buckets across one assignment change', () => {
    const rows = input.collection(
      new Map([
        ['a', { group: 'x' }],
        ['b', { group: 'y' }],
        ['c', { group: 'y' }],
      ])
    );
    const grouped = derive.keyed.groupBy(rows, row => row.group);
    const runtime = createProjectionRuntime();
    const items = runtime.items(grouped);
    const y = items.get('y');
    const before = y.current();
    const listener = vi.fn();
    y.subscribe(listener);

    runtime.update(rows, draft => draft.set('a', { group: 'z' }));
    expect(y.current()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect([...runtime.read(grouped)]).toEqual([
      ['z', ['a']],
      ['y', ['b', 'c']],
    ]);
    runtime.dispose();
  });

  it('publishes every source entry that enters the same new group in one document commit', () => {
    const schema = object({ rows: map(object({ group: field<string>() })) });
    const document = createDocument({
      schema,
      initial: {
        rows: {
          a: { group: 'x' },
          b: { group: 'y' },
          c: { group: 'y' },
        },
      },
    });
    const rows = observe(document, path => path.rows);
    const grouped = derive.keyed.groupBy(rows, row => row.group);
    const runtime = createProjectionRuntime();
    expect([...runtime.read(grouped)]).toEqual([
      ['x', ['a']],
      ['y', ['b', 'c']],
    ]);

    document.update(draft => {
      draft.rows.get('a')!.group = 'z';
      draft.rows.get('b')!.group = 'z';
    });

    expect([...runtime.read(grouped)]).toEqual([
      ['z', ['a', 'b']],
      ['y', ['c']],
    ]);
    document.dispose();
    runtime.dispose();
  });

  it('removes every source membership from groupBy in one collection edit', () => {
    const rows = input.collection(
      new Map([
        ['a', { group: 'x' }],
        ['b', { group: 'x' }],
        ['c', { group: 'y' }],
      ])
    );
    const grouped = derive.keyed.groupBy(rows, row => row.group);
    const runtime = createProjectionRuntime();
    runtime.read(grouped);

    runtime.update(rows, draft => {
      draft.remove('a');
      draft.remove('b');
    });

    expect([...runtime.read(grouped)]).toEqual([['y', ['c']]]);
    runtime.dispose();
  });

  it('converts an optional scalar to a zero-or-one keyed singleton', () => {
    const current = input<{ readonly id: string; readonly value: number } | undefined>(undefined);
    const singleton = derive.keyed.singleton(current, value => value.id);
    const runtime = createProjectionRuntime();
    expect([...runtime.read(singleton)]).toEqual([]);
    runtime.update(current, { id: 'a', value: 1 });
    expect([...runtime.read(singleton)]).toEqual([['a', { id: 'a', value: 1 }]]);
    runtime.update(current, { id: 'b', value: 2 });
    expect([...runtime.read(singleton)]).toEqual([['b', { id: 'b', value: 2 }]]);
    runtime.update(current, undefined);
    expect([...runtime.read(singleton)]).toEqual([]);
    runtime.dispose();
  });
});
