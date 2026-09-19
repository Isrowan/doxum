import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  list,
  map,
  object,
  observe,
  ProjectionDisposedError,
  table,
  tree,
  type ExternalCollectionEvent,
  type ExternalValueEvent,
} from '../src';
import { incremental } from '../src/projection/advanced';
import { measureProfile } from '../src/profile';

const row = object({ value: field<number>(), label: field<string>() });
const model = object({ rows: map(row), ordered: table(row) });

describe('projection runtime', () => {
  it('is lazy and reusable across runtimes', () => {
    const source = input(2);
    const squared = derive([source], value => value * value);
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    expect(left.get(squared)).toBe(4);
    expect(right.get(squared)).toBe(4);
    left.set(source, 3);
    expect(left.get(squared)).toBe(9);
    expect(right.get(squared)).toBe(4);
    left.dispose();
    right.dispose();
  });

  it('retains state in the advanced value processor', () => {
    const source = input(1);
    const calls = incremental([source], ({ sources, state }) => {
      state.calls = Number(state.calls ?? 0) + 1;
      return (sources[0] as number) + Number(state.calls);
    });
    const runtime = createProjectionRuntime();
    expect(runtime.get(calls)).toBe(2);
    runtime.set(source, 2);
    expect(runtime.get(calls)).toBe(4);
    runtime.dispose();
  });

  it('does not publish an equal value after a processor rebuild', () => {
    const source = input(1);
    const projection = incremental([source], ({ sources, reset }) => {
      if (!reset && sources[0] === 2) return { kind: 'rebuild' } as const;
      return 'stable';
    });
    const runtime = createProjectionRuntime();
    const readable = runtime.readable(projection);
    const listener = vi.fn();
    readable.subscribe(listener);
    expect(readable.current()).toBe('stable');
    const revision = readable.revision();

    runtime.set(source, 2);
    expect(runtime.get(projection)).toBe('stable');
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('unblocks downstream after equal fault recovery without republishing the recovered output', () => {
    const source = input(1);
    const upstream = incremental([source], ({ sources }) => {
      if (sources[0] === 2) throw new Error('failed');
      return 'stable';
    });
    const downstream = derive([upstream], value => `${value}!`);
    const runtime = createProjectionRuntime({ onError: () => undefined });
    const readable = runtime.readable(upstream);
    const listener = vi.fn();
    readable.subscribe(listener);

    expect(runtime.get(downstream)).toBe('stable!');
    const revision = readable.revision();
    runtime.set(source, 2);
    expect(() => runtime.get(upstream)).toThrow();
    expect(() => runtime.get(downstream)).toThrow();
    const callsAfterFault = listener.mock.calls.length;

    runtime.set(source, 3);
    expect(runtime.get(upstream)).toBe('stable');
    expect(runtime.get(downstream)).toBe('stable!');
    expect(readable.revision()).toBe(revision);
    expect(listener).toHaveBeenCalledTimes(callsAfterFault);
    runtime.dispose();
  });

  it('isolates retained incremental state between runtimes and rebuilds', () => {
    const source = input(1);
    const projection = incremental([source], ({ state, sources }) => {
      state.count = Number(state.count ?? 0) + 1;
      return Number(sources[0]) + Number(state.count);
    });
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    expect(left.get(projection)).toBe(2);
    expect(right.get(projection)).toBe(2);
    left.set(source, 2);
    expect(left.get(projection)).toBe(4);
    expect(right.get(projection)).toBe(2);
    left.dispose();
    right.dispose();
  });

  it('keeps local scope nodes in the parent graph and releases only their lifetime', () => {
    const parent = input(2);
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const local = scope.input(3);
    const value = scope.derive([parent, local], (a, b) => a * b);
    const calls = vi.fn();
    const selected = scope.readable(value);
    selected.subscribe(calls);
    expect(selected.current()).toBe(6);
    runtime.set(parent, 4);
    expect(selected.current()).toBe(12);
    expect(calls).toHaveBeenCalledTimes(1);
    scope.set(local, 5);
    expect(selected.current()).toBe(20);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(() => runtime.get(value)).toThrow('another scope');
    scope.dispose();
    scope.dispose();
    expect(() => selected.current()).toThrow(ProjectionDisposedError);
    expect(() => scope.set(local, 7)).toThrow(ProjectionDisposedError);
    runtime.set(parent, 6);
    expect(runtime.get(parent)).toBe(6);
    expect(calls).toHaveBeenCalledTimes(2);
    runtime.dispose();
    runtime.dispose();
    expect(() => runtime.scope()).toThrow(ProjectionDisposedError);
  });

  it('supports scope-owned incremental collections and rejects sibling dependencies', () => {
    const parent = input.collection(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const first = runtime.scope();
    const second = runtime.scope();
    const factor = first.input(2);
    const projection = first.incremental.collection([parent, factor], ({ sources, output }) => {
      for (const [key, value] of sources[0]) output.set(key, value * sources[1]);
    });
    expect(first.get(projection).get('a')).toBe(2);
    runtime.update(parent, draft => draft.set('a', 3));
    expect(first.get(projection).get('a')).toBe(6);
    expect(() => second.derive([factor], value => value + 1)).toThrow('another scope');
    first.dispose();
    second.dispose();
    expect(runtime.get(parent).get('a')).toBe(3);
    runtime.dispose();
  });

  it('publishes exact net keyed input changes without touching unrelated selectors', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const seen: unknown[] = [];
    const observed = incremental([rows], ({ changes, sources }) => {
      seen.push(changes[0]);
      return sources[0].size;
    });
    const runtime = createProjectionRuntime();
    const selected = runtime.readable(rows, values => values.get('a'));
    const onSelected = vi.fn();
    selected.subscribe(onSelected);
    expect(runtime.get(observed)).toBe(2);
    const first = runtime.get(rows);
    runtime.batch(() => {
      runtime.update(rows, draft => draft.set('b', 3));
      runtime.update(rows, draft => {
        draft.set('c', 4);
        draft.remove('b');
      });
    });
    expect(seen[1]).toEqual({
      kind: 'incremental',
      added: [{ key: 'c', after: 4 }],
      updated: [],
      removed: [{ key: 'b', before: 2 }],
    });
    expect(runtime.get(rows).get('a')).toBe(1);
    expect(runtime.get(rows)).not.toBe(first);
    expect(onSelected).not.toHaveBeenCalled();
    runtime.batch(() => {
      runtime.update(rows, draft => draft.set('a', 9));
      runtime.update(rows, draft => draft.set('a', 1));
    });
    expect(seen).toHaveLength(2);
    expect(onSelected).not.toHaveBeenCalled();
    runtime.update(rows, draft => draft.set('a', 5));
    expect(onSelected).toHaveBeenCalledTimes(1);
    expect(selected.current()).toBe(5);
    runtime.dispose();
  });

  it('keeps a keyed input edit atomic when its callback fails', () => {
    const rows = input.collection(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    let escaped!: { get(key: string): number | undefined; set(key: string, value: number): void };
    runtime.update(rows, draft => {
      escaped = draft;
      draft.set('a', 4);
      expect(draft.get('a')).toBe(4);
      expect(draft.has('a')).toBe(true);
      draft.remove('a');
      expect(draft.has('a')).toBe(false);
    });
    expect(() => escaped.get('a')).toThrow('no longer active');
    expect(() => escaped.set('a', 5)).toThrow('no longer active');
    expect([...runtime.get(rows)]).toEqual([]);
    expect(() =>
      runtime.update(rows, draft => {
        draft.set('a', 2);
        draft.set('b', 3);
        throw new Error('failed');
      })
    ).toThrow('failed');
    expect([...runtime.get(rows)]).toEqual([]);
    runtime.dispose();
  });

  it('updates one keyed entry without remapping or enumerating unrelated entries', () => {
    const rows = input.collection(
      new Map(Array.from({ length: 2_000 }, (_, index) => [`key-${index}`, index] as const))
    );
    const runtime = createProjectionRuntime();
    runtime.get(rows);
    const { profile } = measureProfile(() =>
      runtime.update(rows, draft => draft.set('key-1000', 42))
    );
    expect(profile.collectionView.mappedItems).toBe(1);
    expect(profile.collectionView.idsScanned).toBe(0);
    expect(runtime.get(rows).get('key-1000')).toBe(42);
    runtime.dispose();
  });

  it('preserves observable order when a keyed input removes and re-adds a key', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ])
    );
    const changes: unknown[] = [];
    const observed = incremental([rows], ({ changes: next }) => {
      changes.push(next[0]);
      return 0;
    });
    const runtime = createProjectionRuntime();
    runtime.get(observed);
    const earlier = runtime.get(rows);
    runtime.batch(() => {
      runtime.update(rows, draft => draft.remove('a'));
      runtime.update(rows, draft => draft.set('a', 1));
    });
    expect([...earlier.keys()]).toEqual(['a', 'b', 'c']);
    expect([...runtime.get(rows).keys()]).toEqual(['b', 'c', 'a']);
    expect(changes[1]).toMatchObject({
      kind: 'incremental',
      added: [],
      updated: [],
      removed: [],
      order: { before: ['a', 'b', 'c'], after: ['b', 'c', 'a'] },
    });
    runtime.dispose();
  });

  it('publishes keyed incremental collection changes', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const source = observe(document, path => path.rows);
    const seenChanges: unknown[] = [];
    const doubled = incremental.collection([source], ({ sources, output, changes }) => {
      if (changes[0]?.kind === 'incremental') {
        for (const transition of changes[0].updated) {
          const beforeLabel: string = transition.before.label;
          const afterValue: number = transition.after.value;
          void beforeLabel;
          void afterValue;
        }
      }
      seenChanges.push(changes[0]);
      for (const [key, value] of sources[0]) output.set(key, value.value * 2);
    });
    const runtime = createProjectionRuntime();
    expect(runtime.get(doubled).get('a')).toBe(2);
    expect(seenChanges[0]).toEqual({ kind: 'reset' });
    document.update(draft => {
      draft.rows.get('b')!.value = 4;
    });
    expect(runtime.get(doubled).get('a')).toBe(2);
    expect(runtime.get(doubled).get('b')).toBe(8);
    expect(seenChanges[1]).toMatchObject({
      kind: 'incremental',
      updated: [
        {
          key: 'b',
          before: { value: 2, label: 'B' },
          after: { value: 4, label: 'B' },
        },
      ],
    });
    document.dispose();
    runtime.dispose();
  });

  it('observes keyed lists through the native collection protocol', () => {
    const schema = object({
      items: list(field<{ id: string; n: number }>(), { keyOf: item => item.id }),
      title: field<string>(),
    });
    const document = createDocument({
      schema,
      initial: {
        items: [
          { id: 'a', n: 1 },
          { id: 'b', n: 2 },
        ],
        title: 'before',
      },
    });
    const items = observe(document, path => path.items);
    const changes: unknown[] = [];
    const probe = incremental([items], ({ changes: next }) => {
      changes.push(next[0]);
      return changes.length;
    });
    const runtime = createProjectionRuntime();
    expect(runtime.get(probe)).toBe(1);
    expect([...runtime.get(items).keys()]).toEqual(['a', 'b']);
    expect(changes[0]).toEqual({ kind: 'reset' });

    document.update(draft => draft.items.replace('b', { id: 'b', n: 3 }));
    expect(changes.at(-1)).toMatchObject({
      kind: 'incremental',
      added: [],
      updated: [{ key: 'b', before: { id: 'b', n: 2 }, after: { id: 'b', n: 3 } }],
      removed: [],
    });

    document.update(draft => draft.items.insert({ id: 'c', n: 4 }));
    expect(changes.at(-1)).toMatchObject({
      kind: 'incremental',
      added: [{ key: 'c', after: { id: 'c', n: 4 } }],
      updated: [],
      removed: [],
    });
    expect((changes.at(-1) as { order?: unknown }).order).toBeUndefined();

    document.update(draft => draft.items.move('c', { at: 'start' }));
    expect(changes.at(-1)).toMatchObject({
      kind: 'incremental',
      added: [],
      updated: [],
      removed: [],
      order: { before: ['a', 'b', 'c'], after: ['c', 'a', 'b'] },
    });
    expect([...runtime.get(items).keys()]).toEqual(['c', 'a', 'b']);

    document.update(draft => draft.items.reorder(['b', 'c', 'a']));
    expect(changes.at(-1)).toEqual({
      kind: 'incremental',
      added: [],
      updated: [],
      removed: [],
      order: { before: ['c', 'a', 'b'], after: ['b', 'c', 'a'] },
    });
    expect([...runtime.get(items).keys()]).toEqual(['b', 'c', 'a']);

    document.update(draft => draft.items.remove('b'));
    expect(changes.at(-1)).toMatchObject({
      kind: 'incremental',
      added: [],
      updated: [],
      removed: [{ key: 'b', before: { id: 'b', n: 3 } }],
    });
    expect((changes.at(-1) as { order?: unknown }).order).toBeUndefined();

    const selector = vi.fn(
      (value: ReadonlyMap<string, { readonly id: string; readonly n: number }>) => value.get('a')?.n
    );
    const selected = runtime.readable(items, selector);
    const listener = vi.fn();
    selected.subscribe(listener);
    expect(selected.current()).toBe(1);
    const calls = selector.mock.calls.length;
    document.update(draft => draft.items.replace('c', { id: 'c', n: 5 }));
    expect(selector).toHaveBeenCalledTimes(calls);
    expect(listener).not.toHaveBeenCalled();

    document.update(draft => {
      draft.title = 'after';
    });
    expect(selector).toHaveBeenCalledTimes(calls);
    expect(changes.at(-1)).toMatchObject({
      kind: 'incremental',
      updated: [{ key: 'c', after: { id: 'c', n: 5 } }],
    });
    document.dispose();
    runtime.dispose();
  });

  it('observes tree root, keyed nodes, and individual nodes through native source protocols', () => {
    const schema = object({ outline: tree(field<number>()) });
    const document = createDocument({
      schema,
      initial: {
        outline: {
          rootId: 'root',
          nodes: {
            root: { children: ['a', 'b'], value: 0 },
            a: { parentId: 'root', children: [], value: 1 },
            b: { parentId: 'root', children: [], value: 2 },
          },
        },
      },
    });
    const root = observe(document, path => path.outline.rootId);
    const nodes = observe(document, path => path.outline.nodes);
    const a = observe(document, path => path.outline.nodes.item('a'));
    const changes: unknown[] = [];
    const probe = incremental([nodes], ({ changes: next }) => {
      changes.push(next[0]);
      return changes.length;
    });
    const runtime = createProjectionRuntime();
    expect(runtime.get(root)).toBe('root');
    expect([...runtime.get(nodes).keys()]).toEqual(['root', 'a', 'b']);
    expect(runtime.get(a)).toEqual({ parentId: 'root', children: [], value: 1 });
    expect(runtime.get(probe)).toBe(1);

    const rootListener = vi.fn();
    const aListener = vi.fn();
    const stopRoot = runtime.readable(root).subscribe(rootListener);
    const stopA = runtime.readable(a).subscribe(aListener);
    const updatedB = document.update(draft => draft.outline.replace('b', 20));
    if (updatedB.status !== 'committed') throw new Error('tree update');
    expect(updatedB.commit.impact.collection(path => path.outline.nodes)).toEqual({
      kind: 'incremental',
      added: new Set(),
      removed: new Set(),
      updated: new Set(['b']),
      orderChanged: false,
    });
    expect(rootListener).not.toHaveBeenCalled();
    expect(aListener).not.toHaveBeenCalled();
    expect(changes.at(-1)).toEqual({
      kind: 'incremental',
      added: [],
      updated: [
        {
          key: 'b',
          before: { parentId: 'root', children: [], value: 2 },
          after: { parentId: 'root', children: [], value: 20 },
        },
      ],
      removed: [],
    });

    document.update(draft => draft.outline.insert('c', 3, { parentId: 'root' }));
    expect(changes.at(-1)).toMatchObject({
      kind: 'incremental',
      added: [{ key: 'c', after: { parentId: 'root', children: [], value: 3 } }],
      updated: [
        {
          key: 'root',
          after: { children: ['a', 'b', 'c'], value: 0 },
        },
      ],
      removed: [],
    });
    expect(rootListener).not.toHaveBeenCalled();

    document.update(draft =>
      draft.outline.replace({
        rootId: 'next',
        nodes: { next: { children: [], value: 30 } },
      })
    );
    expect(changes.at(-1)).toEqual({ kind: 'reset' });
    expect(runtime.get(root)).toBe('next');
    expect([...runtime.get(nodes).keys()]).toEqual(['next']);
    expect(rootListener).toHaveBeenCalledTimes(1);
    expect(aListener).toHaveBeenCalledTimes(1);
    stopRoot();
    stopA();
    document.dispose();
    runtime.dispose();
  });

  it('publishes tree root and node sources atomically in one causal batch', () => {
    const schema = object({ outline: tree(field<number>()) });
    const document = createDocument({ schema, initial: { outline: { nodes: {} } } });
    const root = observe(document, path => path.outline.rootId);
    const nodes = observe(document, path => path.outline.nodes);
    const combined = derive(
      [root, nodes],
      (rootId, values) => `${rootId ?? 'none'}:${values.size}`
    );
    const runtime = createProjectionRuntime();
    expect(runtime.get(combined)).toBe('none:0');
    const listener = vi.fn();
    const stop = runtime.readable(combined).subscribe(listener);
    document.update(draft => draft.outline.insert('root', 1));
    expect(runtime.get(combined)).toBe('root:1');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    document.dispose();
    runtime.dispose();
  });

  it('passes dependency-aligned collection transitions with complete entry values', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const rows = observe(document, path => path.rows);
    const ordered = observe(document, path => path.ordered);
    const filter = input('all');
    const changes: unknown[][] = [];
    const projection = incremental([rows, ordered, filter], ({ changes: next }) => {
      const rowChange = next[0];
      if (rowChange?.kind === 'incremental') {
        for (const transition of rowChange.updated) {
          const beforeValue: number = transition.before.value;
          const afterLabel: string = transition.after.label;
          void beforeValue;
          void afterLabel;
        }
      }
      changes.push(next as unknown as unknown[]);
      return 0;
    });
    const runtime = createProjectionRuntime();

    runtime.get(projection);
    expect(changes[0][0]).toEqual({ kind: 'reset' });
    expect(changes[0][1]).toEqual({ kind: 'reset' });
    expect(changes[0][2]).toBeUndefined();

    document.update(draft => {
      draft.rows.get('b')!.value = 4;
      draft.rows.put('c', { value: 3, label: 'C' });
      draft.rows.remove('a');
    });
    runtime.get(projection);
    const rowChange = changes.at(-1)![0] as {
      kind: 'incremental';
      added: readonly { key: string; after: { value: number; label: string } }[];
      updated: readonly {
        key: string;
        before: { value: number; label: string };
        after: { value: number; label: string };
      }[];
      removed: readonly { key: string; before: { value: number; label: string } }[];
    };
    expect(rowChange.kind).toBe('incremental');
    expect(rowChange.added).toEqual([{ key: 'c', after: { value: 3, label: 'C' } }]);
    expect(rowChange.updated).toEqual([
      {
        key: 'b',
        before: { value: 2, label: 'B' },
        after: { value: 4, label: 'B' },
      },
    ]);
    expect(rowChange.removed).toEqual([{ key: 'a', before: { value: 1, label: 'A' } }]);
    expect(changes.at(-1)![1]).toBeUndefined();
    expect(changes.at(-1)![2]).toBeUndefined();

    document.update(draft => draft.ordered.move('b', { at: 'start' }));
    runtime.get(projection);
    const orderChange = changes.at(-1)![1] as {
      kind: 'incremental';
      order?: { before: readonly string[]; after: readonly string[] };
    };
    expect(orderChange.kind).toBe('incremental');
    expect(orderChange.order).toEqual({ before: ['a', 'b'], after: ['b', 'a'] });

    document.dispose();
    runtime.dispose();
  });

  it('coalesces document collection commits to the net transition', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' } },
        ordered: { ids: ['a'], byId: { a: { value: 1, label: 'A' } } },
      },
    });
    const rows = observe(document, path => path.rows);
    const changes: unknown[] = [];
    const projection = incremental([rows], ({ changes: next }) => {
      changes.push(next[0]);
      return 0;
    });
    const runtime = createProjectionRuntime();
    runtime.get(projection);
    runtime.batch(() => {
      document.update(draft => {
        draft.rows.get('a')!.value = 2;
      });
      document.update(draft => {
        draft.rows.get('a')!.value = 1;
      });
    });
    runtime.get(projection);
    expect(changes).toHaveLength(1);

    document.dispose();
    runtime.dispose();
  });

  it('derives keyed entry values and suppresses equal selected updates', () => {
    const rows = input.collection(
      new Map([
        ['a', { value: 1, label: 'A' }],
        ['b', { value: 2, label: 'B' }],
      ])
    );
    const select = vi.fn(
      (entry: { readonly value: number; readonly label: string }) => entry.value
    );
    const values = derive.keyed(rows, select);
    const seen: unknown[] = [];
    const probe = incremental([values], ({ changes }) => {
      if (changes[0]) seen.push(changes[0]);
      return 0;
    });
    const runtime = createProjectionRuntime();

    expect([...runtime.get(values)]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    runtime.get(probe);
    expect(select).toHaveBeenCalledTimes(2);
    seen.length = 0;
    select.mockClear();

    runtime.update(rows, draft => draft.set('a', { value: 1, label: 'renamed' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(runtime.get(values).get('a')).toBe(1);

    select.mockClear();
    runtime.update(rows, draft => draft.set('b', { value: 3, label: 'B' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      {
        kind: 'incremental',
        added: [],
        updated: [{ key: 'b', before: 2, after: 3 }],
        removed: [],
      },
    ]);
    runtime.dispose();
  });

  it('preserves driver membership and order without recomputing unchanged entries', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: {},
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const ordered = observe(document, path => path.ordered);
    const select = vi.fn((entry: { readonly value: number }) => entry.value);
    const values = derive.keyed(ordered, select);
    const changes: unknown[] = [];
    const probe = incremental([values], ({ changes: next }) => {
      if (next[0]) changes.push(next[0]);
      return 0;
    });
    const runtime = createProjectionRuntime();
    runtime.get(probe);
    select.mockClear();
    changes.length = 0;

    document.update(draft => draft.ordered.move('b', { at: 'start' }));

    expect(select).not.toHaveBeenCalled();
    expect([...runtime.get(values).keys()]).toEqual(['b', 'a']);
    expect(changes).toEqual([
      {
        kind: 'incremental',
        added: [],
        updated: [],
        removed: [],
        order: { before: ['a', 'b'], after: ['b', 'a'] },
      },
    ]);
    document.dispose();
    runtime.dispose();
  });

  it('rebuilds a keyed derivation from the current driver after a document reset', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: { ids: [], byId: {} },
      },
    });
    const rows = observe(document, path => path.rows);
    const select = vi.fn((entry: { readonly value: number }) => entry.value);
    const values = derive.keyed(rows, select);
    const runtime = createProjectionRuntime();
    expect([...runtime.get(values)]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    select.mockClear();

    document.replace({
      rows: { b: { value: 20, label: 'B2' }, c: { value: 3, label: 'C' } },
      ordered: { ids: [], byId: {} },
    });

    expect([...runtime.get(values)]).toEqual([
      ['b', 20],
      ['c', 3],
    ]);
    expect(select).toHaveBeenCalledTimes(2);
    document.dispose();
    runtime.dispose();
  });

  it('owns dynamic keyed dependencies and rebinds them when the driver key changes', () => {
    const items = input.collection(
      new Map([
        ['i1', { recordId: 'r1' }],
        ['i2', { recordId: 'r2' }],
      ])
    );
    const records = input.collection(
      new Map([
        ['r1', { title: 'One' }],
        ['r2', { title: 'Two' }],
        ['unused', { title: 'Unused' }],
      ])
    );
    const mode = input<'compact' | 'full'>('compact');
    const select = vi.fn(
      (
        item: { readonly recordId: string },
        dependencies: {
          readonly record: { readonly title: string } | undefined;
          readonly mode: 'compact' | 'full';
        },
        itemId: string
      ) =>
        `${itemId}:${dependencies.mode}:${item.recordId}:${dependencies.record?.title ?? 'missing'}`
    );
    const content = derive.keyed(
      items,
      {
        record: { source: records, key: item => item.recordId },
        mode,
      },
      select
    );
    const runtime = createProjectionRuntime();

    expect([...runtime.get(content)]).toEqual([
      ['i1', 'i1:compact:r1:One'],
      ['i2', 'i2:compact:r2:Two'],
    ]);
    select.mockClear();

    runtime.update(records, draft => draft.set('unused', { title: 'Still unused' }));
    expect(select).not.toHaveBeenCalled();

    runtime.update(records, draft => draft.set('r1', { title: 'One+' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.get(content).get('i1')).toBe('i1:compact:r1:One+');
    select.mockClear();

    runtime.update(items, draft => draft.set('i1', { recordId: 'r2' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.get(content).get('i1')).toBe('i1:compact:r2:Two');
    select.mockClear();

    runtime.update(records, draft => draft.set('r1', { title: 'detached' }));
    expect(select).not.toHaveBeenCalled();
    runtime.update(records, draft => draft.set('r2', { title: 'Two+' }));
    expect(select).toHaveBeenCalledTimes(2);
    select.mockClear();

    runtime.update(items, draft => draft.set('i1', { recordId: 'missing' }));
    expect(runtime.get(content).get('i1')).toBe('i1:compact:missing:missing');
    select.mockClear();
    runtime.update(records, draft => draft.set('missing', { title: 'Arrived' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.get(content).get('i1')).toBe('i1:compact:missing:Arrived');
    select.mockClear();

    runtime.set(mode, 'full');
    expect(select).toHaveBeenCalledTimes(2);
    expect(runtime.get(content).get('i2')).toBe('i2:full:r2:Two+');
    runtime.dispose();
  });

  it('keeps keyed derivations owned by a projection scope', () => {
    const rows = input.collection(new Map([['a', { value: 1 }]]));
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const values = scope.derive.keyed(rows, entry => entry.value);
    expect(scope.get(values).get('a')).toBe(1);
    scope.dispose();
    expect(() => scope.get(values)).toThrow(ProjectionDisposedError);
    runtime.dispose();
  });

  it('can observe and derive external readables through the same graph', () => {
    let value = 1;
    const listeners = new Set<() => void>();
    const readable = {
      current: () => value,
      revision: () => value,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const source = observe(readable);
    const result = derive([source], current => current * 3);
    const runtime = createProjectionRuntime();
    expect(runtime.get(result)).toBe(3);
    value = 2;
    listeners.forEach(listener => listener());
    expect(runtime.get(result)).toBe(6);
    runtime.dispose();
  });

  it('observes external value and collection sources through the same boundary', () => {
    let value = 1;
    const valueListeners = new Set<(event: ExternalValueEvent<number>) => void>();
    const valueSource = observe({
      kind: 'value' as const,
      current: () => value,
      revision: () => value,
      subscribe: (listener: (event: ExternalValueEvent<number>) => void) => {
        valueListeners.add(listener);
        return () => {
          valueListeners.delete(listener);
        };
      },
    });
    const collection = new Map([['a', 1]]);
    const collectionListeners = new Set<(event: ExternalCollectionEvent<string, number>) => void>();
    const collectionSource = observe({
      kind: 'collection' as const,
      current: () => ({
        get: (key: string) => collection.get(key),
        has: (key: string) => collection.has(key),
        ids: () => [...collection.keys()],
      }),
      revision: () => value,
      subscribe: (listener: (event: ExternalCollectionEvent<string, number>) => void) => {
        collectionListeners.add(listener);
        return () => collectionListeners.delete(listener);
      },
    });
    const collectionCount = derive([collectionSource], rows => rows.size);
    const runtime = createProjectionRuntime();
    expect(runtime.get(valueSource)).toBe(1);
    expect(runtime.get(collectionSource).get('a')).toBe(1);
    expect(runtime.get(collectionCount)).toBe(1);
    value = 2;
    valueListeners.forEach(listener => listener({ value, revision: value }));
    expect(runtime.get(valueSource)).toBe(2);
    collection.set('a', 2);
    value = 3;
    collectionListeners.forEach(listener =>
      listener({
        previous: {
          get: key => (key === 'a' ? 1 : undefined),
          has: key => key === 'a',
          ids: () => ['a'],
        },
        revision: value,
        impact: {
          kind: 'incremental',
          added: new Set(),
          removed: new Set(),
          updated: new Set(['a']),
          orderChanged: false,
        },
      })
    );
    expect(runtime.get(collectionSource).get('a')).toBe(2);
    runtime.dispose();
  });

  it('does not notify an unselected keyed listener for another key', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const listener = vi.fn();
    const selected = runtime.readable(rows, value => value.get('a'));
    const stop = selected.subscribe(listener);
    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });
    expect(listener).not.toHaveBeenCalled();
    document.update(draft => {
      draft.rows.get('a')!.value = 4;
    });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    document.dispose();
    runtime.dispose();
  });

  it('keeps published collection views immutable without copying unchanged entries', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const previous = runtime.get(rows);
    const previousA = previous.get('a');

    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });

    const next = runtime.get(rows);
    expect(next).not.toBe(previous);
    expect(previous.get('b')?.value).toBe(2);
    expect(next.get('b')?.value).toBe(3);
    expect(next.get('a')).toBe(previousA);

    document.dispose();
    runtime.dispose();
  });

  it('keeps keyed selector invalidation for a map returned by derive', () => {
    const source = input(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const mapped = derive([source], values => new Map(values));
    const runtime = createProjectionRuntime();
    const listener = vi.fn();
    const selected = runtime.readable(mapped, value => value.get('a'));
    const stop = selected.subscribe(listener);
    runtime.set(
      source,
      new Map([
        ['a', 1],
        ['b', 3],
      ])
    );
    expect(listener).not.toHaveBeenCalled();
    runtime.set(
      source,
      new Map([
        ['a', 4],
        ['b', 3],
      ])
    );
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    runtime.dispose();
  });

  it('owns selector tracking and equality on runtime readables', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const select = vi.fn((value: ReadonlyMap<string, { value: number; label: string }>) =>
      value.get('a')
    );
    const selected = runtime.readable(rows, select);
    const listener = vi.fn();

    expect(selected.current()?.value).toBe(1);
    expect(select).toHaveBeenCalledTimes(1);
    const stop = selected.subscribe(listener);
    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    document.update(draft => {
      draft.rows.get('a')!.value = 4;
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selected.current()?.value).toBe(4);
    stop();
    document.dispose();
    runtime.dispose();
  });

  it('suppresses equal selected snapshots without changing readable revision', () => {
    const source = input(1);
    const runtime = createProjectionRuntime();
    const selected = runtime.readable(
      source,
      value => ({ value: value > 0 ? 1 : 1 }),
      (previous, next) => previous.value === next.value
    );
    const listener = vi.fn();
    expect(selected.current().value).toBe(1);
    const stop = selected.subscribe(listener);
    runtime.set(source, 2);
    expect(selected.current().value).toBe(1);
    expect(selected.revision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    stop();
    runtime.dispose();
  });

  it('tracks a collection returned directly from a selector conservatively', () => {
    const source = input(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const selected = runtime.readable(source, value => value);
    const listener = vi.fn();
    expect(selected.current().get('a')).toBe(1);
    const stop = selected.subscribe(listener);
    runtime.set(source, new Map([['a', 2]]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selected.current().get('a')).toBe(2);
    stop();
    runtime.dispose();
  });

  it('rebinds dynamic keyed selector dependencies after a branch changes', () => {
    const document = createDocument({
      schema: model,
      initial: {
        rows: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        ordered: {
          ids: ['a', 'b'],
          byId: { a: { value: 1, label: 'A' }, b: { value: 2, label: 'B' } },
        },
      },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const select = vi.fn((value: ReadonlyMap<string, { value: number; label: string }>) =>
      value.has('a') ? value.get('a') : value.get('b')
    );
    const selected = runtime.readable(rows, select);
    const listener = vi.fn();
    expect(selected.current()?.value).toBe(1);
    const stop = selected.subscribe(listener);

    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    document.update(draft => {
      draft.rows.remove('a');
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selected.current()?.value).toBe(3);

    document.update(draft => {
      draft.rows.get('b')!.value = 4;
    });
    expect(select).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(selected.current()?.value).toBe(4);
    stop();
    document.dispose();
    runtime.dispose();
  });

  it('invalidates readable handles when their runtime is disposed', () => {
    const source = input(1);
    const runtime = createProjectionRuntime();
    const readable = runtime.readable(source, value => value * 2);
    expect(readable.current()).toBe(2);
    runtime.dispose();
    expect(() => readable.current()).toThrow(ProjectionDisposedError);
  });

  it('composes atomic multi-output groups with nested namespaces', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const calls = vi.fn();
    const graph = incremental.group(
      [rows],
      define => ({
        node: {
          shell: define.collection<string, number>(),
          content: define.collection<string, string>(),
        },
        labels: define.collection<string, string>(),
      }),
      ({ sources, outputs }) => {
        calls();
        for (const [key, value] of sources[0]) {
          outputs.node.shell.set(key, value * 2);
          outputs.node.content.set(key, 'content');
          outputs.labels.set(key, `label:${value}`);
        }
      }
    );
    const downstream = incremental.group(
      [graph.node.shell, graph.labels],
      define => ({
        rendered: define.collection<string, string>(),
      }),
      ({ sources, outputs }) => {
        for (const key of sources[0].keys())
          outputs.rendered.set(key, `${sources[0].get(key)}:${sources[1].get(key)}`);
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.get(graph.node.shell).get('a')).toBe(2);
    expect(runtime.get(graph.node.content).get('a')).toBe('content');
    expect(runtime.get(graph.labels).get('a')).toBe('label:1');
    expect(runtime.get(downstream.rendered).get('a')).toBe('2:label:1');
    expect(calls).toHaveBeenCalledTimes(1);

    const shellListener = vi.fn();
    const contentListener = vi.fn();
    const labelsListener = vi.fn();
    runtime.readable(graph.node.shell).subscribe(shellListener);
    runtime.readable(graph.node.content).subscribe(contentListener);
    runtime.readable(graph.labels).subscribe(labelsListener);
    runtime.update(rows, draft => draft.set('b', 3));
    expect(calls).toHaveBeenCalledTimes(2);
    expect(shellListener).toHaveBeenCalledTimes(1);
    expect(contentListener).not.toHaveBeenCalled();
    expect(labelsListener).toHaveBeenCalledTimes(1);
    expect(runtime.get(downstream.rendered).get('b')).toBe('6:label:3');
    runtime.dispose();
  });

  it('composes value and collection leaves in one atomic group', () => {
    const source = input(1);
    const calls = vi.fn();
    const nextValues: Array<string | undefined> = [];
    const previousValues: Array<string | undefined> = [];
    const scene = incremental.group(
      [source],
      define => ({
        graph: define.collection<string, number>(),
        scene: {
          chrome: define.value<string>(),
          revision: define.value<number>(),
        },
      }),
      ({ sources, previous, next, outputs }) => {
        calls();
        previousValues.push(previous.scene.chrome);
        outputs.graph.set('value', sources[0]);
        outputs.scene.chrome.set('stable');
        nextValues.push(next.scene.chrome);
        outputs.scene.revision.set(sources[0]);
      }
    );
    const downstreamCalls = vi.fn();
    const downstream = derive([scene.graph, scene.scene.revision], (graph, revision) => {
      downstreamCalls();
      return `${graph.get('value')}:${revision}`;
    });
    const runtime = createProjectionRuntime();
    expect(runtime.get(scene.scene.chrome)).toBe('stable');
    expect(runtime.get(scene.graph).get('value')).toBe(1);
    expect(runtime.get(downstream)).toBe('1:1');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(downstreamCalls).toHaveBeenCalledTimes(1);
    expect(previousValues).toEqual([undefined]);
    expect(nextValues).toEqual(['stable']);

    const chromeListener = vi.fn();
    const revisionListener = vi.fn();
    runtime.readable(scene.scene.chrome).subscribe(chromeListener);
    runtime.readable(scene.scene.revision).subscribe(revisionListener);
    runtime.set(source, 2);
    expect(runtime.get(scene.scene.chrome)).toBe('stable');
    expect(runtime.get(scene.scene.revision)).toBe(2);
    expect(runtime.get(scene.graph).get('value')).toBe(2);
    expect(runtime.get(downstream)).toBe('2:2');
    expect(calls).toHaveBeenCalledTimes(2);
    expect(downstreamCalls).toHaveBeenCalledTimes(2);
    expect(chromeListener).not.toHaveBeenCalled();
    expect(revisionListener).toHaveBeenCalledTimes(1);
    expect(previousValues).toEqual([undefined, 'stable']);
    expect(nextValues).toEqual(['stable', 'stable']);
    runtime.dispose();
  });

  it('requires value leaves on reset and distinguishes an explicit undefined value', () => {
    const source = input(1);
    const missing = incremental.group(
      [source],
      define => ({ value: define.value<number>() }),
      () => undefined
    );
    const runtime = createProjectionRuntime();
    expect(() => runtime.get(missing.value)).toThrow('Value output must be initialized on reset');
    runtime.dispose();

    const optional = incremental.group(
      [] as const,
      define => ({ value: define.value<number | undefined>() }),
      ({ outputs, next }) => {
        outputs.value.set(undefined);
        expect(next.value).toBeUndefined();
      }
    );
    const second = createProjectionRuntime();
    expect(second.get(optional.value)).toBeUndefined();
    second.dispose();
  });

  it('keeps untouched group value leaves stable', () => {
    const source = input(1);
    const group = incremental.group(
      [source],
      define => ({
        current: define.value<number>(),
        initializedOnce: define.value<string>(),
      }),
      ({ sources, outputs, reset }) => {
        outputs.current.set(sources[0]);
        if (reset) outputs.initializedOnce.set('ready');
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.get(group.initializedOnce)).toBe('ready');
    const listener = vi.fn();
    const readable = runtime.readable(group.initializedOnce);
    readable.subscribe(listener);
    const beforeRevision = readable.revision();
    runtime.set(source, 2);
    expect(runtime.get(group.current)).toBe(2);
    expect(runtime.get(group.initializedOnce)).toBe('ready');
    expect(readable.revision()).toBe(beforeRevision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('uses per-value-leaf equality before publishing', () => {
    const source = input(1);
    const group = incremental.group(
      [source],
      define => ({
        bucket: define.value<{ readonly value: number }>(
          (previous, next) => previous.value === next.value
        ),
      }),
      ({ sources, outputs }) => outputs.bucket.set({ value: Math.floor(sources[0] / 10) })
    );
    const runtime = createProjectionRuntime();
    const first = runtime.get(group.bucket);
    const readable = runtime.readable(group.bucket);
    const listener = vi.fn();
    readable.subscribe(listener);
    const revision = readable.revision();

    runtime.set(source, 2);
    expect(runtime.get(group.bucket)).toBe(first);
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();

    runtime.set(source, 12);
    expect(runtime.get(group.bucket)).toEqual({ value: 1 });
    expect(readable.revision()).toBe(revision + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('does not publish an equal group value leaf after rebuild', () => {
    const source = input(1);
    const group = incremental.group(
      [source],
      define => ({ value: define.value<string>() }),
      ({ sources, outputs, reset }) => {
        outputs.value.set('stable');
        if (!reset && sources[0] === 2) return { kind: 'rebuild' } as const;
      }
    );
    const runtime = createProjectionRuntime();
    const readable = runtime.readable(group.value);
    const listener = vi.fn();
    readable.subscribe(listener);
    expect(readable.current()).toBe('stable');
    const revision = readable.revision();

    runtime.set(source, 2);
    expect(runtime.get(group.value)).toBe('stable');
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps all group outputs unchanged when a processor fails', () => {
    const source = input(1);
    const errors: unknown[] = [];
    const group = incremental.group(
      [source],
      define => ({
        first: define.collection<string, number>(),
        second: define.value<number>(),
      }),
      ({ sources, outputs }) => {
        outputs.first.set('value', sources[0]);
        if (sources[0] === 2) throw new Error('processor failed');
        outputs.second.set(sources[0] * 10);
      }
    );
    const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
    expect(runtime.get(group.first).get('value')).toBe(1);
    expect(runtime.get(group.second)).toBe(10);
    runtime.set(source, 2);
    expect(errors).toHaveLength(1);
    expect(() => runtime.get(group.first)).toThrow();
    expect(() => runtime.get(group.second)).toThrow();
    runtime.set(source, 3);
    expect(runtime.get(group.first).get('value')).toBe(3);
    expect(runtime.get(group.second)).toBe(30);
    runtime.set(source, 1);
    expect(runtime.get(group.first).get('value')).toBe(1);
    expect(runtime.get(group.second)).toBe(10);
    runtime.dispose();
  });

  it('releases a scoped group as one local lifetime', () => {
    const source = input.collection(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const group = scope.incremental.group(
      [source],
      define => ({
        values: define.collection<string, number>(),
        doubled: define.collection<string, number>(),
        count: define.value<number>(),
      }),
      ({ sources, outputs }) => {
        for (const [key, value] of sources[0]) {
          outputs.values.set(key, value);
          outputs.doubled.set(key, value * 2);
        }
        outputs.count.set(sources[0].size);
      }
    );
    expect(scope.get(group.doubled).get('a')).toBe(2);
    expect(scope.get(group.count)).toBe(1);
    scope.dispose();
    expect(() => scope.get(group.values)).toThrow(ProjectionDisposedError);
    expect(() => scope.get(group.count)).toThrow(ProjectionDisposedError);
    expect(runtime.get(source).get('a')).toBe(1);
    runtime.dispose();
  });

  it('settles a downstream group only after all upstream groups publish', () => {
    const left = input(1);
    const right = input(10);
    const leftGroup = incremental.group(
      [left],
      define => ({ value: define.collection<string, number>() }),
      ({ sources, outputs }) => outputs.value.set('current', sources[0])
    );
    const rightGroup = incremental.group(
      [right],
      define => ({ value: define.collection<string, number>() }),
      ({ sources, outputs }) => outputs.value.set('current', sources[0])
    );
    const combined = incremental.group(
      [leftGroup.value, rightGroup.value],
      define => ({ value: define.collection<string, string>() }),
      ({ sources, outputs }) =>
        outputs.value.set('current', `${sources[0].get('current')}:${sources[1].get('current')}`)
    );
    const runtime = createProjectionRuntime();
    expect(runtime.get(combined.value).get('current')).toBe('1:10');
    runtime.batch(() => {
      runtime.set(left, 2);
      runtime.set(right, 20);
    });
    expect(runtime.get(combined.value).get('current')).toBe('2:20');
    runtime.dispose();
  });

  it('rejects non-static or reused group output declarations', () => {
    expect(() =>
      incremental.group([] as const, _define => ({}) as never, (() => undefined) as never)
    ).toThrow('cannot be empty');
    expect(() =>
      incremental.group(
        [] as const,
        define => {
          const output = define.collection<string, number>();
          return { first: output, second: output };
        },
        () => undefined
      )
    ).toThrow('cannot be reused');
  });
});
