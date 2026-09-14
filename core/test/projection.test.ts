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
  table,
  type ExternalCollectionEvent,
  type ExternalValueEvent,
} from '../src';
import { incremental } from '../src/projection/advanced';
import { subscribeProjection, trackProjection } from '../src/integration';

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
    const doubled = incremental.collection([source], ({ sources, output }) => {
      for (const [key, value] of sources[0]) output.set(key, value.value * 2);
    });
    const runtime = createProjectionRuntime();
    expect(runtime.get(doubled).get('a')).toBe(2);
    document.update(draft => {
      draft.rows.get('b')!.value = 4;
    });
    expect(runtime.get(doubled).get('a')).toBe(2);
    expect(runtime.get(doubled).get('b')).toBe(8);
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
    const selection = { keys: new Set(['a']), all: false, structure: false } as const;
    const stop = subscribeProjection(runtime, rows, selection, listener);
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
    const tracked = trackProjection(runtime, mapped, value => value.get('a'));
    const stop = subscribeProjection(runtime, mapped, tracked.selection, listener);
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
});
