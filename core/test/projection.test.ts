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
  table,
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
});
