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
  type PublicCollection,
} from '../src';
import { incremental } from '../src/projection/advanced';

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
          kind: 'updated',
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
    expect(rowChange.added).toEqual([{ key: 'c', kind: 'added', after: { value: 3, label: 'C' } }]);
    expect(rowChange.updated).toEqual([
      {
        key: 'b',
        kind: 'updated',
        before: { value: 2, label: 'B' },
        after: { value: 4, label: 'B' },
      },
    ]);
    expect(rowChange.removed).toEqual([
      { key: 'a', kind: 'removed', before: { value: 1, label: 'A' } },
    ]);
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
        change: {
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
    const select = vi.fn((value: PublicCollection<string, { value: number; label: string }>) =>
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
    const select = vi.fn((value: PublicCollection<string, { value: number; label: string }>) =>
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
