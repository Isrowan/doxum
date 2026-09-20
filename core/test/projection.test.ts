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
  ProjectionError,
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
    const squared = derive({ source }, ({ source }) => source * source);
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    expect(left.read(squared)).toBe(4);
    expect(right.read(squared)).toBe(4);
    left.update(source, 3);
    expect(left.read(squared)).toBe(9);
    expect(right.read(squared)).toBe(4);
    left.dispose();
    right.dispose();
  });

  it('retains state in the advanced value processor', () => {
    const source = input(1);
    const calls = incremental(
      { source },
      {
        state: () => ({ calls: 0 }),
        process: ({ values, state }) => {
          state.calls += 1;
          return values.source + state.calls;
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(calls)).toBe(2);
    runtime.update(source, 2);
    expect(runtime.read(calls)).toBe(4);
    runtime.dispose();
  });

  it('keeps stateless processor contexts free of retained-state and legacy group fields', () => {
    const source = input(1);
    const value = incremental(
      { source },
      {
        process: context => {
          // @ts-expect-error stateless processors do not expose retained state
          void context.state;
          return context.values.source;
        },
      }
    );
    const group = incremental.group(
      { source },
      {
        output: define => ({ value: define.value<number>() }),
        process: context => {
          // @ts-expect-error stateless processors do not expose retained state
          void context.state;
          // @ts-expect-error group processors expose singular output only
          void context.outputs;
          context.output.value.set(context.values.source);
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(value)).toBe(1);
    expect(runtime.read(group.value)).toBe(1);
    runtime.dispose();
  });

  it('does not publish an equal value after runtime-owned processor recovery', () => {
    const source = input(1);
    const projection = incremental(
      { source },
      {
        process: ({ values, reset }) => {
          if (!reset && values.source === 2) throw new Error('recover');
          return 'stable';
        },
      }
    );
    const runtime = createProjectionRuntime({ onError: () => undefined });
    const readable = runtime.select(projection);
    const listener = vi.fn();
    readable.subscribe(listener);
    expect(readable.current()).toBe('stable');
    const revision = readable.revision();

    runtime.update(source, 2);
    expect(runtime.read(projection)).toBe('stable');
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('recreates retained state after a processor fault', () => {
    const source = input(1);
    const initialize = vi.fn();
    let generation = 0;
    const projection = incremental(
      { source },
      {
        state: () => {
          initialize();
          return { generation: ++generation, calls: 0 };
        },
        process: ({ values, state, reset }) => {
          if (!reset && values.source === 2) throw new Error('fault');
          state.calls += 1;
          return [state.generation, state.calls, values.source].join(':');
        },
      }
    );
    const runtime = createProjectionRuntime({ onError: () => undefined });
    expect(runtime.read(projection)).toBe('1:1:1');
    runtime.update(source, 2);
    expect(runtime.read(projection)).toBe('2:1:2');
    expect(initialize).toHaveBeenCalledTimes(2);
    runtime.update(source, 3);
    expect(runtime.read(projection)).toBe('2:2:3');
    expect(initialize).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('exposes only stable projection failure metadata', () => {
    const source = input(1);
    const cause = new Error('processor failed');
    const projection = incremental(
      { source },
      {
        process: ({ values }) => {
          if (values.source === 2) throw cause;
          return values.source;
        },
      }
    );
    const errors: ProjectionError[] = [];
    const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
    expect(runtime.read(projection)).toBe(1);
    runtime.update(source, 2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProjectionError);
    expect(errors[0]?.phase).toBe('processor');
    expect(errors[0]?.cause).toBe(cause);
    expect(errors[0]).not.toHaveProperty('identity');
    expect(errors[0]).not.toHaveProperty('revisions');
    runtime.dispose();
  });

  it('preserves retained state across ordinary source resets', () => {
    const document = createDocument({
      schema: object({ value: field<number>() }),
      initial: { value: 1 },
    });
    const source = observe(document, path => path.value);
    const initialize = vi.fn(() => ({ calls: 0 }));
    const resets: boolean[] = [];
    const projection = incremental(
      { source },
      {
        state: initialize,
        process: ({ values, state, reset }) => {
          resets.push(reset);
          state.calls += 1;
          return [state.calls, values.source].join(':');
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(projection)).toBe('1:1');
    document.update(draft => {
      draft.value = 2;
    });
    expect(runtime.read(projection)).toBe('2:2');
    document.replace({ value: 3 });
    expect(runtime.read(projection)).toBe('3:3');
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(resets).toEqual([true, false, true]);
    document.dispose();
    runtime.dispose();
  });

  it('unblocks downstream after equal fault recovery without republishing the recovered output', () => {
    const source = input(1);
    const upstream = incremental(
      { source },
      {
        process: ({ values }) => {
          if (values.source === 2) throw new Error('failed');
          return 'stable';
        },
      }
    );
    const downstream = derive({ upstream }, ({ upstream }) => `${upstream}!`);
    const runtime = createProjectionRuntime({ onError: () => undefined });
    const readable = runtime.select(upstream);
    const listener = vi.fn();
    readable.subscribe(listener);

    expect(runtime.read(downstream)).toBe('stable!');
    const revision = readable.revision();
    runtime.update(source, 2);
    expect(() => runtime.read(upstream)).toThrow();
    expect(() => runtime.read(downstream)).toThrow();
    const callsAfterFault = listener.mock.calls.length;

    runtime.update(source, 3);
    expect(runtime.read(upstream)).toBe('stable');
    expect(runtime.read(downstream)).toBe('stable!');
    expect(readable.revision()).toBe(revision);
    expect(listener).toHaveBeenCalledTimes(callsAfterFault);
    runtime.dispose();
  });

  it('isolates retained incremental state between runtimes and rebuilds', () => {
    const source = input(1);
    const projection = incremental(
      { source },
      {
        state: () => ({ count: 0 }),
        process: ({ state, values }) => {
          state.count += 1;
          return values.source + state.count;
        },
      }
    );
    const left = createProjectionRuntime();
    const right = createProjectionRuntime();
    expect(left.read(projection)).toBe(2);
    expect(right.read(projection)).toBe(2);
    left.update(source, 2);
    expect(left.read(projection)).toBe(4);
    expect(right.read(projection)).toBe(2);
    left.dispose();
    right.dispose();
  });

  it('keeps local scope nodes in the parent graph and releases only their lifetime', () => {
    const parent = input(2);
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const local = scope.own(input(3));
    const localRows = scope.own(input.collection(new Map([['a', 1]])));
    const value = scope.own(derive({ parent, local }, ({ parent, local }) => parent * local));
    const calls = vi.fn();
    const selected = scope.select(value);
    selected.subscribe(calls);
    expect(selected.current()).toBe(6);
    runtime.update(parent, 4);
    expect(selected.current()).toBe(12);
    expect(calls).toHaveBeenCalledTimes(1);
    scope.batch(
      () => {
        scope.update(local, 5);
        scope.update(localRows, draft => draft.set('a', 2));
      },
      { cause: 'scope update' }
    );
    expect(selected.current()).toBe(20);
    expect(scope.read(localRows).get('a')).toBe(2);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(() => runtime.read(value)).toThrow('another scope');
    scope.dispose();
    scope.dispose();
    expect(() => selected.current()).toThrow(ProjectionDisposedError);
    expect(() => scope.update(local, 7)).toThrow(ProjectionDisposedError);
    expect(() => scope.update(localRows, draft => draft.set('a', 3))).toThrow(
      ProjectionDisposedError
    );
    runtime.update(parent, 6);
    expect(runtime.read(parent)).toBe(6);
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
    const factor = first.own(input(2));
    const projection = first.own(
      incremental.collection(
        { parent, factor },
        {
          process: ({ values, output }) => {
            for (const [key, value] of values.parent) output.set(key, value * values.factor);
          },
        }
      )
    );
    expect(first.read(projection).get('a')).toBe(2);
    expect(() => second.own(factor)).toThrow('already belongs');
    const rootDependent = derive({ factor }, ({ factor }) => factor + 1);
    expect(() => runtime.read(rootDependent)).toThrow('root projection');
    runtime.update(parent, draft => draft.set('a', 3));
    expect(first.read(projection).get('a')).toBe(6);
    expect(() => second.own(derive({ factor }, ({ factor }) => factor + 1))).toThrow(
      'another scope'
    );
    first.dispose();
    second.dispose();
    expect(runtime.read(parent).get('a')).toBe(3);
    runtime.dispose();
  });

  it('fixes scope ownership before a definition is materialized', () => {
    const source = input(1);
    const runtime = createProjectionRuntime();
    expect(runtime.read(source)).toBe(1);
    const scope = runtime.scope();
    expect(() => scope.own(source)).toThrow('materialized root projection');
    expect(runtime.read(source)).toBe(1);
    scope.dispose();
    runtime.dispose();
  });

  it('rolls back a source producer when external subscription initialization fails', () => {
    const failure = new Error('subscribe failed');
    const subscribe = vi.fn(() => {
      throw failure;
    });
    const source = observe({
      kind: 'value' as const,
      current: () => 1,
      revision: () => 0,
      subscribe,
    });
    const runtime = createProjectionRuntime();
    expect(() => runtime.read(source)).toThrow(failure);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(runtime.read(input(2))).toBe(2);
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('exhaustively releases a scope when one external cleanup fails', () => {
    const failure = new Error('cleanup failed');
    const firstStop = vi.fn(() => {
      throw failure;
    });
    const secondStop = vi.fn();
    const first = observe({
      kind: 'value' as const,
      current: () => 1,
      revision: () => 0,
      subscribe: () => firstStop,
    });
    const second = observe({
      kind: 'value' as const,
      current: () => 2,
      revision: () => 0,
      subscribe: () => secondStop,
    });
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    scope.own({ first, second });
    expect(scope.read(first)).toBe(1);
    expect(scope.read(second)).toBe(2);

    expect(() => scope.dispose()).toThrow(failure);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).toHaveBeenCalledTimes(1);
    expect(() => scope.read(first)).toThrow(ProjectionDisposedError);
    expect(() => scope.dispose()).not.toThrow();
    expect(() => runtime.dispose()).not.toThrow();
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).toHaveBeenCalledTimes(1);
  });

  it('publishes exact net keyed input changes without touching unrelated selectors', () => {
    const rows = input.collection(
      new Map([
        ['a', 1],
        ['b', 2],
      ])
    );
    const seen: unknown[] = [];
    const observed = incremental(
      { rows },
      {
        process: ({ changes, values }) => {
          seen.push(changes.rows);
          return values.rows.size;
        },
      }
    );
    const runtime = createProjectionRuntime();
    const selected = runtime.select(rows, values => values.get('a'));
    const onSelected = vi.fn();
    selected.subscribe(onSelected);
    expect(runtime.read(observed)).toBe(2);
    const first = runtime.read(rows);
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
    expect(runtime.read(rows).get('a')).toBe(1);
    expect(runtime.read(rows)).not.toBe(first);
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

  it('uses per-entry equality to suppress equivalent keyed input updates', () => {
    const rows = input.collection(
      new Map([['a', { value: 1, label: 'A' }]]),
      (previous, next) => previous.value === next.value
    );
    const runtime = createProjectionRuntime();
    const readable = runtime.select(rows);
    const listener = vi.fn();
    readable.subscribe(listener);
    const before = runtime.read(rows);

    runtime.update(rows, draft => draft.set('a', { value: 1, label: 'renamed' }));
    expect(runtime.read(rows)).toBe(before);
    expect(runtime.read(rows).get('a')).toEqual({ value: 1, label: 'A' });
    expect(listener).not.toHaveBeenCalled();

    runtime.update(rows, draft => draft.set('a', { value: 2, label: 'renamed' }));
    expect(runtime.read(rows).get('a')).toEqual({ value: 2, label: 'renamed' });
    expect(listener).toHaveBeenCalledTimes(1);
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
    expect([...runtime.read(rows)]).toEqual([]);
    expect(() =>
      runtime.update(rows, draft => {
        draft.set('a', 2);
        draft.set('b', 3);
        throw new Error('failed');
      })
    ).toThrow('failed');
    expect([...runtime.read(rows)]).toEqual([]);
    runtime.dispose();
  });

  it('keeps a keyed input edit atomic when entry equality fails', () => {
    const failure = new Error('equality failed');
    const rows = input.collection(
      new Map([
        ['a', 0],
        ['b', 0],
      ]),
      (previous, next) => {
        if (next === 99) throw failure;
        return previous === next;
      }
    );
    const runtime = createProjectionRuntime();
    const readable = runtime.select(rows);
    const listener = vi.fn();
    readable.subscribe(listener);
    const before = runtime.read(rows);

    expect(() =>
      runtime.update(rows, draft => {
        draft.set('a', 1);
        draft.set('b', 99);
      })
    ).toThrow(failure);

    expect(runtime.read(rows)).toBe(before);
    expect([...runtime.read(rows)]).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
    expect(listener).not.toHaveBeenCalled();

    runtime.update(rows, draft => {
      expect(draft.get('a')).toBe(0);
      expect(draft.get('b')).toBe(0);
      draft.set('a', 2);
    });
    expect(runtime.read(rows).get('a')).toBe(2);
    expect(runtime.read(rows).get('b')).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('updates one keyed entry without remapping or enumerating unrelated entries', () => {
    const rows = input.collection(
      new Map(Array.from({ length: 2_000 }, (_, index) => [`key-${index}`, index] as const))
    );
    const runtime = createProjectionRuntime();
    runtime.read(rows);
    const { profile } = measureProfile(() =>
      runtime.update(rows, draft => draft.set('key-1000', 42))
    );
    expect(profile.collectionView.mappedItems).toBe(1);
    expect(profile.collectionView.idsScanned).toBe(0);
    expect(runtime.read(rows).get('key-1000')).toBe(42);
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
    const observed = incremental(
      { rows },
      {
        process: ({ changes: next }) => {
          changes.push(next.rows);
          return 0;
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(observed);
    const earlier = runtime.read(rows);
    runtime.batch(() => {
      runtime.update(rows, draft => draft.remove('a'));
      runtime.update(rows, draft => draft.set('a', 1));
    });
    expect([...earlier.keys()]).toEqual(['a', 'b', 'c']);
    expect([...runtime.read(rows).keys()]).toEqual(['b', 'c', 'a']);
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
    const doubled = incremental.collection(
      { source },
      {
        process: ({ values, output, changes }) => {
          if (changes.source?.kind === 'incremental') {
            for (const transition of changes.source.updated) {
              const beforeLabel: string = transition.before.label;
              const afterValue: number = transition.after.value;
              void beforeLabel;
              void afterValue;
            }
          }
          seenChanges.push(changes.source);
          for (const [key, value] of values.source) output.set(key, value.value * 2);
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(doubled).get('a')).toBe(2);
    expect(seenChanges[0]).toEqual({ kind: 'reset' });
    document.update(draft => {
      draft.rows.get('b')!.value = 4;
    });
    expect(runtime.read(doubled).get('a')).toBe(2);
    expect(runtime.read(doubled).get('b')).toBe(8);
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
    const probe = incremental(
      { items },
      {
        process: ({ changes: next }) => {
          changes.push(next.items);
          return changes.length;
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(probe)).toBe(1);
    expect([...runtime.read(items).keys()]).toEqual(['a', 'b']);
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
    expect([...runtime.read(items).keys()]).toEqual(['c', 'a', 'b']);

    document.update(draft => draft.items.reorder(['b', 'c', 'a']));
    expect(changes.at(-1)).toEqual({
      kind: 'incremental',
      added: [],
      updated: [],
      removed: [],
      order: { before: ['c', 'a', 'b'], after: ['b', 'c', 'a'] },
    });
    expect([...runtime.read(items).keys()]).toEqual(['b', 'c', 'a']);

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
    const selected = runtime.select(items, selector);
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
    const probe = incremental(
      { nodes },
      {
        process: ({ changes: next }) => {
          changes.push(next.nodes);
          return changes.length;
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(root)).toBe('root');
    expect([...runtime.read(nodes).keys()]).toEqual(['root', 'a', 'b']);
    expect(runtime.read(a)).toEqual({ parentId: 'root', children: [], value: 1 });
    expect(runtime.read(probe)).toBe(1);

    const rootListener = vi.fn();
    const aListener = vi.fn();
    const stopRoot = runtime.select(root).subscribe(rootListener);
    const stopA = runtime.select(a).subscribe(aListener);
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
    expect(runtime.read(root)).toBe('next');
    expect([...runtime.read(nodes).keys()]).toEqual(['next']);
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
      { root, nodes },
      ({ root, nodes }) => `${root ?? 'none'}:${nodes.size}`
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(combined)).toBe('none:0');
    const listener = vi.fn();
    const stop = runtime.select(combined).subscribe(listener);
    document.update(draft => draft.outline.insert('root', 1));
    expect(runtime.read(combined)).toBe('root:1');
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
    const changes: Array<{ rows: unknown; ordered: unknown; filter: unknown }> = [];
    const projection = incremental(
      { rows, ordered, filter },
      {
        process: ({ changes: next }) => {
          const rowChange = next.rows;
          if (rowChange?.kind === 'incremental') {
            for (const transition of rowChange.updated) {
              const beforeValue: number = transition.before.value;
              const afterLabel: string = transition.after.label;
              void beforeValue;
              void afterLabel;
            }
          }
          changes.push(next as { rows: unknown; ordered: unknown; filter: unknown });
          return 0;
        },
      }
    );
    const runtime = createProjectionRuntime();

    runtime.read(projection);
    expect(changes[0].rows).toEqual({ kind: 'reset' });
    expect(changes[0].ordered).toEqual({ kind: 'reset' });
    expect(changes[0].filter).toBeUndefined();

    document.update(draft => {
      draft.rows.get('b')!.value = 4;
      draft.rows.put('c', { value: 3, label: 'C' });
      draft.rows.remove('a');
    });
    runtime.read(projection);
    const rowChange = changes.at(-1)!.rows as {
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
    expect(changes.at(-1)!.ordered).toBeUndefined();
    expect(changes.at(-1)!.filter).toBeUndefined();

    document.update(draft => draft.ordered.move('b', { at: 'start' }));
    runtime.read(projection);
    const orderChange = changes.at(-1)!.ordered as {
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
    const projection = incremental(
      { rows },
      {
        process: ({ changes: next }) => {
          changes.push(next.rows);
          return 0;
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(projection);
    runtime.batch(() => {
      document.update(draft => {
        draft.rows.get('a')!.value = 2;
      });
      document.update(draft => {
        draft.rows.get('a')!.value = 1;
      });
    });
    runtime.read(projection);
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
    const probe = incremental(
      { values },
      {
        process: ({ changes }) => {
          if (changes.values) seen.push(changes.values);
          return 0;
        },
      }
    );
    const runtime = createProjectionRuntime();

    expect([...runtime.read(values)]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    runtime.read(probe);
    expect(select).toHaveBeenCalledTimes(2);
    seen.length = 0;
    select.mockClear();

    runtime.update(rows, draft => draft.set('a', { value: 1, label: 'renamed' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(runtime.read(values).get('a')).toBe(1);

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
    const probe = incremental(
      { values },
      {
        process: ({ changes: next }) => {
          if (next.values) changes.push(next.values);
          return 0;
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(probe);
    select.mockClear();
    changes.length = 0;

    document.update(draft => draft.ordered.move('b', { at: 'start' }));

    expect(select).not.toHaveBeenCalled();
    expect([...runtime.read(values).keys()]).toEqual(['b', 'a']);
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
    expect([...runtime.read(values)]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    select.mockClear();

    document.replace({
      rows: { b: { value: 20, label: 'B2' }, c: { value: 3, label: 'C' } },
      ordered: { ids: [], byId: {} },
    });

    expect([...runtime.read(values)]).toEqual([
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
        itemId: string,
        dependencies: {
          readonly record: { readonly title: string } | undefined;
          readonly mode: 'compact' | 'full';
        }
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

    expect([...runtime.read(content)]).toEqual([
      ['i1', 'i1:compact:r1:One'],
      ['i2', 'i2:compact:r2:Two'],
    ]);
    select.mockClear();

    runtime.update(records, draft => draft.set('unused', { title: 'Still unused' }));
    expect(select).not.toHaveBeenCalled();

    runtime.update(records, draft => draft.set('r1', { title: 'One+' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.read(content).get('i1')).toBe('i1:compact:r1:One+');
    select.mockClear();

    runtime.update(items, draft => draft.set('i1', { recordId: 'r2' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.read(content).get('i1')).toBe('i1:compact:r2:Two');
    select.mockClear();

    runtime.update(records, draft => draft.set('r1', { title: 'detached' }));
    expect(select).not.toHaveBeenCalled();
    runtime.update(records, draft => draft.set('r2', { title: 'Two+' }));
    expect(select).toHaveBeenCalledTimes(2);
    select.mockClear();

    runtime.update(items, draft => draft.set('i1', { recordId: 'missing' }));
    expect(runtime.read(content).get('i1')).toBe('i1:compact:missing:missing');
    select.mockClear();
    runtime.update(records, draft => draft.set('missing', { title: 'Arrived' }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(runtime.read(content).get('i1')).toBe('i1:compact:missing:Arrived');
    select.mockClear();

    runtime.update(mode, 'full');
    expect(select).toHaveBeenCalledTimes(2);
    expect(runtime.read(content).get('i2')).toBe('i2:full:r2:Two+');
    runtime.dispose();
  });

  it('keeps keyed derivations owned by a projection scope', () => {
    const rows = input.collection(new Map([['a', { value: 1 }]]));
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const values = scope.own(derive.keyed(rows, entry => entry.value));
    expect(scope.read(values).get('a')).toBe(1);
    scope.dispose();
    expect(() => scope.read(values)).toThrow(ProjectionDisposedError);
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
    const result = derive({ source }, ({ source }) => source * 3);
    const runtime = createProjectionRuntime();
    expect(runtime.read(result)).toBe(3);
    value = 2;
    listeners.forEach(listener => listener());
    expect(runtime.read(result)).toBe(6);
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
    const collectionCount = derive(
      { collectionSource },
      ({ collectionSource }) => collectionSource.size
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(valueSource)).toBe(1);
    expect(runtime.read(collectionSource).get('a')).toBe(1);
    expect(runtime.read(collectionCount)).toBe(1);
    value = 2;
    valueListeners.forEach(listener => listener({ value, revision: value }));
    expect(runtime.read(valueSource)).toBe(2);
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
    expect(runtime.read(collectionSource).get('a')).toBe(2);
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
    const selected = runtime.select(rows, value => value.get('a'));
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
    const previous = runtime.read(rows);
    const previousA = previous.get('a');

    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });

    const next = runtime.read(rows);
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
    const mapped = derive({ source }, ({ source }) => new Map(source));
    const runtime = createProjectionRuntime();
    const listener = vi.fn();
    const selected = runtime.select(mapped, value => value.get('a'));
    const stop = selected.subscribe(listener);
    runtime.update(
      source,
      new Map([
        ['a', 1],
        ['b', 3],
      ])
    );
    expect(listener).not.toHaveBeenCalled();
    runtime.update(
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
    const selected = runtime.select(rows, select);
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
    const selected = runtime.select(
      source,
      value => ({ value: value > 0 ? 1 : 1 }),
      (previous, next) => previous.value === next.value
    );
    const listener = vi.fn();
    expect(selected.current().value).toBe(1);
    const stop = selected.subscribe(listener);
    runtime.update(source, 2);
    expect(selected.current().value).toBe(1);
    expect(selected.revision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    stop();
    runtime.dispose();
  });

  it('tracks a collection returned directly from a selector conservatively', () => {
    const source = input(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const selected = runtime.select(source, value => value);
    const listener = vi.fn();
    expect(selected.current().get('a')).toBe(1);
    const stop = selected.subscribe(listener);
    runtime.update(source, new Map([['a', 2]]));
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
    const selected = runtime.select(rows, select);
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
    const readable = runtime.select(source, value => value * 2);
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
      { rows },
      {
        output: define => ({
          node: {
            shell: define.collection<string, number>(),
            content: define.collection<string, string>(),
          },
          labels: define.collection<string, string>(),
        }),
        process: ({ values, output }) => {
          calls();
          for (const [key, value] of values.rows) {
            output.node.shell.set(key, value * 2);
            output.node.content.set(key, 'content');
            output.labels.set(key, `label:${value}`);
          }
        },
      }
    );
    const downstream = incremental.group(
      { shell: graph.node.shell, labels: graph.labels },
      {
        output: define => ({
          rendered: define.collection<string, string>(),
        }),
        process: ({ values, output }) => {
          for (const key of values.shell.keys())
            output.rendered.set(key, `${values.shell.get(key)}:${values.labels.get(key)}`);
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(graph.node.shell).get('a')).toBe(2);
    expect(runtime.read(graph.node.content).get('a')).toBe('content');
    expect(runtime.read(graph.labels).get('a')).toBe('label:1');
    expect(runtime.read(downstream.rendered).get('a')).toBe('2:label:1');
    expect(calls).toHaveBeenCalledTimes(1);

    const shellListener = vi.fn();
    const contentListener = vi.fn();
    const labelsListener = vi.fn();
    runtime.select(graph.node.shell).subscribe(shellListener);
    runtime.select(graph.node.content).subscribe(contentListener);
    runtime.select(graph.labels).subscribe(labelsListener);
    runtime.update(rows, draft => draft.set('b', 3));
    expect(calls).toHaveBeenCalledTimes(2);
    expect(shellListener).toHaveBeenCalledTimes(1);
    expect(contentListener).not.toHaveBeenCalled();
    expect(labelsListener).toHaveBeenCalledTimes(1);
    expect(runtime.read(downstream.rendered).get('b')).toBe('6:label:3');
    runtime.dispose();
  });

  it('composes value and collection leaves in one atomic group', () => {
    const source = input(1);
    const calls = vi.fn();
    const nextValues: Array<string | undefined> = [];
    const previousValues: Array<string | undefined> = [];
    const scene = incremental.group(
      { source },
      {
        output: define => ({
          graph: define.collection<string, number>(),
          scene: {
            chrome: define.value<string>(),
            revision: define.value<number>(),
          },
        }),
        process: ({ values, previous, next, output }) => {
          calls();
          previousValues.push(previous.scene.chrome);
          output.graph.set('value', values.source);
          output.scene.chrome.set('stable');
          nextValues.push(next.scene.chrome);
          output.scene.revision.set(values.source);
        },
      }
    );
    const downstreamCalls = vi.fn();
    const downstream = derive(
      { graph: scene.graph, revision: scene.scene.revision },
      ({ graph, revision }) => {
        downstreamCalls();
        return `${graph.get('value')}:${revision}`;
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(scene.scene.chrome)).toBe('stable');
    expect(runtime.read(scene.graph).get('value')).toBe(1);
    expect(runtime.read(downstream)).toBe('1:1');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(downstreamCalls).toHaveBeenCalledTimes(1);
    expect(previousValues).toEqual([undefined]);
    expect(nextValues).toEqual(['stable']);

    const chromeListener = vi.fn();
    const revisionListener = vi.fn();
    runtime.select(scene.scene.chrome).subscribe(chromeListener);
    runtime.select(scene.scene.revision).subscribe(revisionListener);
    runtime.update(source, 2);
    expect(runtime.read(scene.scene.chrome)).toBe('stable');
    expect(runtime.read(scene.scene.revision)).toBe(2);
    expect(runtime.read(scene.graph).get('value')).toBe(2);
    expect(runtime.read(downstream)).toBe('2:2');
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
      { source },
      {
        output: define => ({ value: define.value<number>() }),
        process: () => undefined,
      }
    );
    const runtime = createProjectionRuntime();
    expect(() => runtime.read(missing.value)).toThrow('Value output must be initialized on reset');
    runtime.dispose();

    const optional = incremental.group(
      {},
      {
        output: define => ({ value: define.value<number | undefined>() }),
        process: ({ output, next }) => {
          output.value.set(undefined);
          expect(next.value).toBeUndefined();
        },
      }
    );
    const second = createProjectionRuntime();
    expect(second.read(optional.value)).toBeUndefined();
    second.dispose();
  });

  it('keeps untouched group value leaves stable', () => {
    const source = input(1);
    const group = incremental.group(
      { source },
      {
        output: define => ({
          current: define.value<number>(),
          initializedOnce: define.value<string>(),
        }),
        process: ({ values, output, reset }) => {
          output.current.set(values.source);
          if (reset) output.initializedOnce.set('ready');
        },
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(group.initializedOnce)).toBe('ready');
    const listener = vi.fn();
    const readable = runtime.select(group.initializedOnce);
    readable.subscribe(listener);
    const beforeRevision = readable.revision();
    runtime.update(source, 2);
    expect(runtime.read(group.current)).toBe(2);
    expect(runtime.read(group.initializedOnce)).toBe('ready');
    expect(readable.revision()).toBe(beforeRevision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('preserves custom collection equality call semantics for changed entries', () => {
    const source = input(1);
    const equality = vi.fn((previous: number, next: number) => previous === next);
    const group = incremental.group(
      { source },
      {
        output: define => ({ values: define.collection<string, number>(equality) }),
        process: ({ values, output }) => output.values.set('current', values.source),
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(group.values).get('current')).toBe(1);
    equality.mockClear();

    runtime.update(source, 2);
    expect(runtime.read(group.values).get('current')).toBe(2);
    expect(equality).toHaveBeenCalledTimes(2);
    expect(equality.mock.calls).toEqual([
      [1, 2],
      [1, 2],
    ]);
    runtime.dispose();
  });

  it('uses per-value-leaf equality before publishing', () => {
    const source = input(1);
    const group = incremental.group(
      { source },
      {
        output: define => ({
          bucket: define.value<{ readonly value: number }>(
            (previous, next) => previous.value === next.value
          ),
        }),
        process: ({ values, output }) =>
          output.bucket.set({ value: Math.floor(values.source / 10) }),
      }
    );
    const runtime = createProjectionRuntime();
    const first = runtime.read(group.bucket);
    const readable = runtime.select(group.bucket);
    const listener = vi.fn();
    readable.subscribe(listener);
    const revision = readable.revision();

    runtime.update(source, 2);
    expect(runtime.read(group.bucket)).toBe(first);
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();

    runtime.update(source, 12);
    expect(runtime.read(group.bucket)).toEqual({ value: 1 });
    expect(readable.revision()).toBe(revision + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('does not publish an equal group value leaf after runtime-owned recovery', () => {
    const source = input(1);
    const group = incremental.group(
      { source },
      {
        output: define => ({ value: define.value<string>() }),
        process: ({ values, output, reset }) => {
          output.value.set('stable');
          if (!reset && values.source === 2) throw new Error('recover');
        },
      }
    );
    const runtime = createProjectionRuntime();
    const readable = runtime.select(group.value);
    const listener = vi.fn();
    readable.subscribe(listener);
    expect(readable.current()).toBe('stable');
    const revision = readable.revision();

    runtime.update(source, 2);
    expect(runtime.read(group.value)).toBe('stable');
    expect(readable.revision()).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps all group outputs unchanged when a processor fails', () => {
    const source = input(1);
    const errors: unknown[] = [];
    const group = incremental.group(
      { source },
      {
        output: define => ({
          first: define.collection<string, number>(),
          second: define.value<number>(),
        }),
        process: ({ values, output }) => {
          output.first.set('value', values.source);
          if (values.source === 2) throw new Error('processor failed');
          output.second.set(values.source * 10);
        },
      }
    );
    const runtime = createProjectionRuntime({ onError: error => errors.push(error) });
    expect(runtime.read(group.first).get('value')).toBe(1);
    expect(runtime.read(group.second)).toBe(10);
    runtime.update(source, 2);
    expect(errors).toHaveLength(1);
    expect(() => runtime.read(group.first)).toThrow();
    expect(() => runtime.read(group.second)).toThrow();
    runtime.update(source, 3);
    expect(runtime.read(group.first).get('value')).toBe(3);
    expect(runtime.read(group.second)).toBe(30);
    runtime.update(source, 1);
    expect(runtime.read(group.first).get('value')).toBe(1);
    expect(runtime.read(group.second)).toBe(10);
    runtime.dispose();
  });

  it('releases a scoped group as one local lifetime', () => {
    const source = input.collection(new Map([['a', 1]]));
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const group = scope.own(
      incremental.group(
        { source },
        {
          output: define => ({
            values: define.collection<string, number>(),
            doubled: define.collection<string, number>(),
            count: define.value<number>(),
          }),
          process: ({ values, output }) => {
            for (const [key, value] of values.source) {
              output.values.set(key, value);
              output.doubled.set(key, value * 2);
            }
            output.count.set(values.source.size);
          },
        }
      )
    );
    expect(scope.read(group.doubled).get('a')).toBe(2);
    expect(scope.read(group.count)).toBe(1);
    scope.dispose();
    expect(() => scope.read(group.values)).toThrow(ProjectionDisposedError);
    expect(() => scope.read(group.count)).toThrow(ProjectionDisposedError);
    expect(runtime.read(source).get('a')).toBe(1);
    runtime.dispose();
  });

  it('settles a downstream group only after all upstream groups publish', () => {
    const left = input(1);
    const right = input(10);
    const leftGroup = incremental.group(
      { left },
      {
        output: define => ({ value: define.collection<string, number>() }),
        process: ({ values, output }) => output.value.set('current', values.left),
      }
    );
    const rightGroup = incremental.group(
      { right },
      {
        output: define => ({ value: define.collection<string, number>() }),
        process: ({ values, output }) => output.value.set('current', values.right),
      }
    );
    const combined = incremental.group(
      { left: leftGroup.value, right: rightGroup.value },
      {
        output: define => ({ value: define.collection<string, string>() }),
        process: ({ values, output }) =>
          output.value.set(
            'current',
            `${values.left.get('current')}:${values.right.get('current')}`
          ),
      }
    );
    const runtime = createProjectionRuntime();
    expect(runtime.read(combined.value).get('current')).toBe('1:10');
    runtime.batch(() => {
      runtime.update(left, 2);
      runtime.update(right, 20);
    });
    expect(runtime.read(combined.value).get('current')).toBe('2:20');
    runtime.dispose();
  });

  it('rejects non-static or reused group output declarations', () => {
    expect(() =>
      incremental.group({}, {
        ['out' + 'puts']: () => ({}),
        process: () => undefined,
      } as never)
    ).toThrow('unknown property');
    expect(() =>
      incremental.group(
        {},
        {
          output: _define => ({}) as never,
          process: (() => undefined) as never,
        }
      )
    ).toThrow('cannot be empty');
    expect(() =>
      incremental.group(
        {},
        {
          output: define => {
            const output = define.collection<string, number>();
            return { first: output, second: output };
          },
          process: () => undefined,
        }
      )
    ).toThrow('cannot be reused');
  });
});
