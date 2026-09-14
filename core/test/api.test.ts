import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  input,
  object,
  project,
  table,
  variant,
  TransactionRejected,
  type ValueProjection,
  type AdvancedCollectionSpec,
  type Readable,
  type ProjectionValueSource,
  type ProjectionCollectionSource,
  type CollectionInput,
  type CollectionRead,
  type ValueInput,
} from '../src';
import { startProfile } from '../src/profile';
import { replace } from '../src';
describe('projection composition', () => {
  it('materializes one reusable definition independently in each store', () => {
    const n = input(1);
    const doubled = project({ n }, ({ n }) => n * 2);
    const first = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const second = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });

    expect(first.get(doubled)).toBe(2);
    expect(second.get(doubled)).toBe(2);
    first.set(n, 3);
    expect(first.get(doubled)).toBe(6);
    expect(second.get(doubled)).toBe(2);

    first.dispose();
    second.dispose();
  });
  it('captures the declared source map before lazy materialization', () => {
    const first = input(1);
    const second = input(10);
    const sources: { value: typeof first | typeof second } = { value: first };
    const doubled = project(sources, ({ value }) => value * 2);
    sources.value = second;
    const store = createProjectionRuntime({ onError: () => {} });

    expect(store.get(doubled)).toBe(2);
    store.set(first, 3);
    expect(store.get(doubled)).toBe(6);
    store.set(second, 20);
    expect(store.get(doubled)).toBe(6);

    store.dispose();
  });
  it('binds collections in inactive variant branches and rebuilds across branch changes', () => {
    const model = object({
      content: variant('kind', {
        empty: object({ label: field<string>() }),
        populated: object({ rows: table(object({ n: field<number>() })) }),
      }),
    });
    const runtime = createDocument({
      schema: model,
      initial: { content: { kind: 'empty', label: '' } },
    });
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const mapped = project(
      runtime,
      path => path.content.rows,
      (_id, row) => row.n
    );
    expect(store.get(mapped).ids()).toEqual([]);
    runtime.update(tx =>
      replace(tx, 'content', { kind: 'populated', rows: { ids: ['a'], byId: { a: { n: 1 } } } })
    );
    expect(store.get(mapped).get('a')).toBe(1);
    runtime.history.undo();
    expect(store.get(mapped).ids()).toEqual([]);
    runtime.history.redo();
    expect(store.get(mapped).get('a')).toBe(1);
    store.dispose();
    runtime.dispose();
  });
  it('updates a two-stage 100k mapping without scanning unrelated keys', () => {
    const ids = Array.from({ length: 100000 }, (_, n) => String(n));
    const model = object({ rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { rows: { ids, byId: Object.fromEntries(ids.map(id => [id, { n: Number(id) }])) } },
    });
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const first = project(
      runtime,
      path => path.rows,
      (_id, row) => row.n
    );
    const second = project(first, (_id, n) => ({ n }));
    const stable = store.get(second).get('2');
    const profile = startProfile();
    runtime.update(tx => (tx.rows.get('1')!.n = 99));
    const counters = profile.stop();
    expect(counters.collectionView.mappedItems).toBe(2);
    expect(counters.collectionView.idsScanned).toBe(0);
    expect(counters.collectionView.arraysCopied).toBe(0);
    expect(store.get(second).get('1')).toEqual({ n: 99 });
    expect(store.get(second).get('2')).toBe(stable);
    store.dispose();
    runtime.dispose();
  });
  it('infers pure and stateful values independently from equality and rejects asynchronous computes', () => {
    const store = createProjectionRuntime({ onError: () => {} });
    const n = input(1);
    const pure = project({ n }, ({ n }) => ({ n: n % 2 }), {
      isEqual: (a, b) => a.n === b.n,
    });
    const stateful = project({
      kind: 'value',
      sources: { n },
      build: ({ n }) => ({
        value: { n: n.value },
        update: ({ n }) => ({ kind: 'changed', value: { n: n.value } }),
      }),
      isEqual: (a, b) => a.n === b.n,
    });
    expectTypeOf(pure).toEqualTypeOf<
      ValueProjection<{
        n: number;
      }>
    >();
    expectTypeOf(stateful).toEqualTypeOf<
      ValueProjection<{
        n: number;
      }>
    >();
    const before = store.get(pure);
    store.set(n, 3);
    expect(store.get(pure)).toBe(before);
    expect(store.get(stateful)).toEqual({ n: 3 });
    const asyncValue = project({ n }, (async ({ n }: { n: number }) => n) as never);
    expect(() => store.get(asyncValue)).toThrow('synchronous');
    store.dispose();
  });
  it('keeps a local value source previous at the beginning of a batch', () => {
    const value = input(1);
    const seen: Array<readonly [number, number]> = [];
    const projected = project({
      kind: 'value',
      sources: { value },
      build: ({ value }) => ({
        value: value.value,
        update: ({ value }) => {
          seen.push([value.previous, value.value]);
          return { kind: 'changed', value: value.value };
        },
      }),
    });
    const runtime = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    expect(runtime.get(projected)).toBe(1);
    runtime.batch(() => {
      runtime.set(value, 2);
      runtime.set(value, 3);
    });
    expect(runtime.get(projected)).toBe(3);
    expect(seen).toEqual([[1, 3]]);
    runtime.dispose();
  });
  it('maps projected collections including present undefined values, order changes and disposal', () => {
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const source = input(false);
    const rows = project({
      kind: 'collection',
      sources: { source },
      build: ({ writer }) => {
        writer.replace([
          ['a', undefined],
          ['b', 2],
        ]);
        return {
          update: ({ sources, writer }) => {
            if (sources.source.value) {
              writer.set('a', 1);
              writer.order(['b', 'a']);
            } else writer.remove('a');
          },
        };
      },
    } satisfies AdvancedCollectionSpec<{ source: typeof source }, string, number | undefined>);
    const mapper = vi.fn((_id: string, value: number | undefined) =>
      value === undefined ? 'empty' : String(value)
    );
    const mapped = project(rows, mapper);
    expect(store.get(mapped).get('a')).toBe('empty');
    mapper.mockClear();
    store.set(source, true);
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(store.get(mapped).ids()).toEqual(['b', 'a']);
    store.set(source, false);
    expect(store.get(mapped).ids()).toEqual(['b']);
    expect(store.get(mapped).has('a')).toBe(false);
    expect(() => store.release(rows)).toThrow();
    store.release(mapped);
    store.release(rows);
    store.dispose();
  });
  it('exposes stable keyed collection readables with precise membership notifications', () => {
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const source = input(0);
    const rows = project({
      kind: 'collection',
      sources: { source },
      build: ({ writer }) => {
        writer.set('a', 1);
        return {
          update: ({ sources, writer }) => {
            if (sources.source.value === 1) writer.set('b', undefined);
            else if (sources.source.value === 2) writer.set('a', 2);
            else if (sources.source.value === 3) writer.order(['b', 'a']);
            else if (sources.source.value === 4) writer.remove('b');
          },
        };
      },
    } satisfies AdvancedCollectionSpec<{ source: typeof source }, string, number | undefined>);

    const a = store.item(rows, 'a');
    const b = store.item(rows, 'b');
    expect(store.item(rows, 'a')).toBe(a);
    expectTypeOf(a).toEqualTypeOf<Readable<number | undefined>>();
    expect(a.current()).toBe(1);
    expect(b.current()).toBeUndefined();
    const aListener = vi.fn();
    const bListener = vi.fn();
    a.subscribe(aListener);
    b.subscribe(bListener);

    store.set(source, 1);
    expect(b.current()).toBeUndefined();
    expect(b.revision()).toBe(1);
    expect(bListener).toHaveBeenCalledTimes(1);
    expect(aListener).not.toHaveBeenCalled();
    store.set(source, 2);
    expect(a.current()).toBe(2);
    expect(aListener).toHaveBeenCalledTimes(1);
    expect(bListener).toHaveBeenCalledTimes(1);
    store.set(source, 3);
    expect(aListener).toHaveBeenCalledTimes(1);
    expect(bListener).toHaveBeenCalledTimes(1);
    store.set(source, 4);
    expect(b.current()).toBeUndefined();
    expect(b.revision()).toBe(2);
    expect(bListener).toHaveBeenCalledTimes(2);

    store.release(rows);
    expect(() => a.current()).toThrow('disposed');
    store.dispose();
  });
  it('provides the current batch before-state to downstream collection processors', () => {
    const n = input(1);
    const rows = project({
      kind: 'collection',
      sources: { n },
      build: ({ sources, writer }) => {
        writer.set('a', sources.n.value);
        return {
          update: ({ sources, writer }) => writer.set('a', sources.n.value),
        };
      },
    });
    const transition = project({
      kind: 'value',
      sources: { rows },
      build: ({ rows }) => ({
        value: [rows.previous.get('a'), rows.get('a'), rows.transitions()] as const,
        update: ({ rows }) => ({
          kind: 'changed',
          value: [rows.previous.get('a'), rows.get('a'), rows.transitions()] as const,
        }),
      }),
    });
    const runtime = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    expect(runtime.get(transition)).toEqual([1, 1, []]);
    runtime.set(n, 2);
    expect(runtime.get(transition)).toEqual([
      1,
      2,
      [{ key: 'a', kind: 'updated', before: 1, after: 2 }],
    ]);
    runtime.dispose();
  });
  it('composes external value sources into one causal batch', () => {
    let value = 1;
    let revision = 0;
    let emit!: (event: ValueInput<number, { readonly source: string }>) => void;
    const port = {
      kind: 'value' as const,
      current: () => value,
      revision: () => revision,
      subscribe(listener: (event: ValueInput<number, { readonly source: string }>) => void) {
        emit = listener;
        return () => {
          emit = undefined!;
        };
      },
    } satisfies ProjectionValueSource<number, { readonly source: string }>;
    const source = project(port);
    const seen: { value: number; previous: number; cause: unknown }[] = [];
    const projected = project({
      kind: 'value',
      sources: { source },
      build: ({ source }) => ({
        value: source.value,
        update: ({ source }) => {
          seen.push({ value: source.value, previous: source.previous, cause: source.batch?.cause });
          return { kind: 'changed', value: source.value };
        },
      }),
    });
    const runtime = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    expect(runtime.get(projected)).toBe(1);
    const listener = vi.fn();
    runtime.subscribe(projected, listener);
    runtime.batch({ cause: { kind: 'user-action', id: 'move-1' } }, () => {
      value = 2;
      revision = 1;
      emit({
        value,
        previous: 1,
        changed: true,
        revision,
        reset: false,
        detail: { source: 'editor' },
      });
      value = 3;
      revision = 2;
      emit({
        value,
        previous: 2,
        changed: true,
        revision,
        reset: false,
        detail: { source: 'editor' },
      });
    });
    expect(runtime.get(projected)).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ value: 3, previous: 1, cause: { kind: 'user-action', id: 'move-1' } }]);
    runtime.dispose();
  });
  it('exposes external collection views with stable entry transitions', () => {
    let values = new Map<string, number>([['a', 1]]);
    let ids = ['a'];
    let revision = 0;
    let emit!: (event: CollectionInput<string, number, { readonly source: string }>) => void;
    const read = (): CollectionRead<string, number> => {
      const snapshot = new Map(values);
      const order = [...ids];
      return {
        get: key => snapshot.get(key),
        has: key => snapshot.has(key),
        ids: () => order,
      };
    };
    const port = {
      kind: 'collection' as const,
      current: read,
      revision: () => revision,
      subscribe(
        listener: (event: CollectionInput<string, number, { readonly source: string }>) => void
      ) {
        emit = listener;
        return () => {
          emit = undefined!;
        };
      },
    } satisfies ProjectionCollectionSource<string, number, { readonly source: string }>;
    const source = project(port);
    const mapped = project(source, (_id, value) => value * 2);
    const runtime = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const view = runtime.collection(mapped);
    const a = view.item('a');
    const b = view.item('b');
    const aListener = vi.fn();
    const bListener = vi.fn();
    a.subscribe(aListener);
    b.subscribe(bListener);
    expect(a.current()).toBe(2);
    const before = read();
    values = new Map([['a', 2]]);
    revision = 1;
    emit({
      ...read(),
      previous: before,
      change: {
        kind: 'incremental',
        added: new Set(),
        removed: new Set(),
        updated: new Set(['a']),
        orderChanged: false,
      },
      revision,
      reset: false,
      transitions: () => [{ key: 'a', kind: 'updated', before: 1, after: 2 }],
      detail: { source: 'document' },
    });
    expect(a.current()).toBe(4);
    expect(aListener).toHaveBeenCalledTimes(1);
    expect(bListener).not.toHaveBeenCalled();
    runtime.dispose();
  });
  it('coalesces external collection transitions from the beginning to the end of a batch', () => {
    let values = new Map<string, number>([['a', 1]]);
    let ids = ['a'];
    let revision = 0;
    let emit!: (event: CollectionInput<string, number>) => void;
    const read = (): CollectionRead<string, number> => {
      const snapshot = new Map(values);
      const order = [...ids];
      return {
        get: key => snapshot.get(key),
        has: key => snapshot.has(key),
        ids: () => order,
      };
    };
    const port = {
      kind: 'collection' as const,
      current: read,
      revision: () => revision,
      subscribe(listener: (event: CollectionInput<string, number>) => void) {
        emit = listener;
        return () => {
          emit = undefined!;
        };
      },
    } satisfies ProjectionCollectionSource<string, number>;
    const source = project(port);
    const transitions = project({
      kind: 'value',
      sources: { source },
      build: ({ source }) => ({
        value: source.transitions(),
        update: ({ source }) => ({ kind: 'changed', value: source.transitions() }),
      }),
    });
    const runtime = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    expect(runtime.get(transitions)).toEqual([]);
    runtime.batch(() => {
      const before = new Map(values);
      values = new Map([['a', 2]]);
      revision = 1;
      emit({
        ...read(),
        previous: {
          get: key => before.get(key),
          has: key => before.has(key),
          ids: () => ['a'],
        },
        change: {
          kind: 'incremental',
          added: new Set(),
          removed: new Set(),
          updated: new Set(['a']),
          orderChanged: false,
        },
        revision,
        reset: false,
        transitions: () => [{ key: 'a', kind: 'updated', before: 1, after: 2 }],
      });
      const previous = new Map(values);
      values = new Map([['a', 3]]);
      revision = 2;
      emit({
        ...read(),
        previous: {
          get: key => previous.get(key),
          has: key => previous.has(key),
          ids: () => ['a'],
        },
        change: {
          kind: 'incremental',
          added: new Set(),
          removed: new Set(),
          updated: new Set(['a']),
          orderChanged: false,
        },
        revision,
        reset: false,
        transitions: () => [{ key: 'a', kind: 'updated', before: 2, after: 3 }],
      });
    });
    expect(runtime.get(transitions)).toEqual([{ key: 'a', kind: 'updated', before: 1, after: 3 }]);
    runtime.dispose();
  });
  it('publishes document candidate keys once per batch including net-zero changes and reset', () => {
    const model = object({ title: field<string>(), rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { title: '', rows: { ids: ['a'], byId: { a: { n: 0 } } } },
    });
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const rows = project(runtime, path => path.rows);
    const compute = vi.fn(
      ({
        rows,
      }: {
        rows: {
          reset: boolean;
          candidates: {
            keys: readonly string[];
            orderDirty: boolean;
          };
        };
      }) => (rows.reset ? 'reset' : rows.candidates.keys.join(','))
    );
    const summary = project({
      kind: 'value',
      sources: { rows },
      build: events => ({
        value: compute(events),
        update: events => ({ kind: 'changed', value: compute(events) }),
      }),
    });
    expect(store.get(summary)).toBe('');
    runtime.update(tx => (tx.title = 'unrelated'));
    expect(compute).toHaveBeenCalledTimes(1);
    store.batch(() => {
      runtime.update(tx => (tx.rows.get('a')!.n = 1));
      runtime.update(tx => (tx.rows.get('a')!.n = 0));
      runtime.update(tx => tx.rows.create('b', { n: 2 }));
      runtime.update(tx => tx.rows.remove('b'));
    });
    expect(store.get(summary)).toBe('a,b');
    expect(compute).toHaveBeenCalledTimes(2);
    runtime.replace({ title: '', rows: { ids: [], byId: {} } });
    expect(store.get(summary)).toBe('reset');
    store.dispose();
    runtime.dispose();
  });
  it('shares external subscriptions while honoring distinct equality policies atomically', () => {
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    let value = { x: 1, y: 1 };
    const listeners = new Set<() => void>();
    const subscribe = vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
    const readable: Readable<typeof value> = { current: () => value, revision: () => 0, subscribe };
    const equalX = (a: typeof value, b: typeof value) => a.x === b.x;
    const external = project(readable);
    const x = project({ external }, ({ external }) => external, { isEqual: equalX });
    const y = project({ external }, ({ external }) => external, { isEqual: (a, b) => a.y === b.y });
    const compute = vi.fn(({ x, y }: { x: typeof value; y: typeof value }) => [x.x, y.y]);
    const result = project({ x, y }, compute);
    expect(store.get(result)).toEqual([1, 1]);
    value = { x: 1, y: 2 };
    listeners.forEach(listener => listener());
    expect(store.get(result)).toEqual([1, 2]);
    value = { x: 3, y: 4 };
    listeners.forEach(listener => listener());
    expect(store.get(result)).toEqual([3, 4]);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(listeners.size).toBe(0);
  });
});
describe('observable grouped history', () => {
  const setup = () =>
    createDocument({
      schema: object({ n: field<number>(), title: field<string>() }),
      initial: { n: 0, title: '' },
    });
  it('records continuous commits as one undo entry and exposes settled state to listeners', () => {
    const runtime = setup();
    const initial = runtime.history.current();
    const group = runtime.history.group();
    runtime.update(tx => (tx.n = 1));
    const first = runtime.history.current();
    runtime.update(tx => (tx.n = 2));
    runtime.update(tx => (tx.title = 'done'));
    expect(runtime.history.current()).toBe(first);
    expect(runtime.history.revision()).toBe(1);
    expect(first).not.toBe(initial);
    group.end();
    const observed: number[] = [];
    runtime.subscribe(() => observed.push(runtime.history.current().undoDepth));
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual({ n: 0, title: '' });
    expect(observed).toEqual([0]);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual({ n: 2, title: 'done' });
    expect(observed).toEqual([0, 1]);
    runtime.dispose();
  });
  it('cancels groups atomically and closes them across non-history writes and replacements', () => {
    const runtime = setup();
    const group = runtime.history.group();
    runtime.update(tx => (tx.n = 1));
    runtime.update(tx => {
      tx.title = 'rejected';
      (() => {
        throw new TransactionRejected({ code: 'no', message: 'No' });
      })();
    });
    runtime.update(tx => (tx.n = 2));
    expect(group.cancel().status).toBe('committed');
    expect(runtime.snapshot()).toEqual({ n: 0, title: '' });
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    const interrupted = runtime.history.group();
    runtime.update(tx => (tx.n = 3));
    runtime.update(tx => (tx.title = 'system'), { history: false });
    runtime.update(tx => (tx.n = 4));
    expect(interrupted.cancel().status).toBe('unchanged');
    expect(runtime.history.current().undoDepth).toBe(2);
    const replaced = runtime.history.group();
    runtime.replace({ n: 9, title: 'remote' }, { source: 'remote' });
    expect(replaced.cancel().status).toBe('unchanged');
    expect(runtime.history.current().undoDepth).toBe(0);
    runtime.dispose();
  });
  it('isolates history listener errors after projections settle and forbids observer writes', () => {
    const runtime = setup();
    const store = createProjectionRuntime({ onError: () => {} });
    const view = project({ document: project(runtime) }, ({ document }) => document.n);
    const fault = new Error('history listener');
    const observed: number[] = [];
    runtime.history.subscribe(() => {
      throw fault;
    });
    runtime.history.subscribe(() => {
      observed.push(store.get(view));
      runtime.update(tx => (tx.n = 99));
    });
    runtime.history.subscribe(() => observed.push(runtime.history.current().undoDepth));
    const result = runtime.update(tx => (tx.n = 1));
    expect(result.status).toBe('committed');
    if (result.status === 'committed') expect(result.observerErrors).toHaveLength(2);
    expect(observed).toEqual([1, 1]);
    expect(runtime.snapshot().n).toBe(1);
    const undo = runtime.history.undo();
    expect(undo.status).toBe('committed');
    if (undo.status === 'committed') expect(undo.observerErrors).toHaveLength(2);
    expect(runtime.snapshot().n).toBe(0);
    store.dispose();
    runtime.dispose();
  });
  it('restores the undo stack when a grouped inverse is rejected after partial work', () => {
    const model = object({ rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { rows: { ids: ['a'], byId: { a: { n: 0 } } } },
    });
    const group = runtime.history.group();
    runtime.update(tx => (tx.rows.get('a')!.n = 1));
    runtime.update(tx => tx.rows.create('b', { n: 2 }));
    group.end();
    runtime.update(tx => tx.rows.remove('a'), { history: false });
    const before = runtime.snapshot();
    const history = runtime.history.current();
    expect(runtime.history.undo().status).toBe('rejected');
    expect(runtime.snapshot()).toEqual(before);
    expect(runtime.history.current()).toBe(history);
    runtime.dispose();
  });
  it('feeds history into projections and protects an active group from nested ownership', () => {
    const runtime = setup();
    const store = createProjectionRuntime({ onError: () => {} });
    const history = project(runtime.history);
    const count = project({ history }, ({ history }) => history.undoDepth);
    const group = runtime.history.group();
    expect(() => runtime.history.group()).toThrow('already active');
    runtime.update(tx => (tx.n = 1));
    expect(store.get(count)).toBe(1);
    group.end();
    runtime.history.clear();
    expect(store.get(count)).toBe(0);
    store.dispose();
    runtime.dispose();
  });
  it('settles document and history sources together before any graph listener', () => {
    const runtime = setup();
    const store = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const compute = vi.fn(
      ({
        document,
        history,
      }: {
        document: { readonly n: number; readonly title: string };
        history: { readonly undoDepth: number; readonly redoDepth: number };
      }) => `${document.n}:${history.undoDepth}`
    );
    const summary = project(
      { document: project(runtime), history: project(runtime.history) },
      compute
    );
    const observed: string[] = [];
    store.subscribe(summary, () => observed.push(store.get(summary)));
    expect(store.get(summary)).toBe('0:0');
    runtime.update(tx => (tx.n = 1));
    runtime.history.undo();
    expect(observed).toEqual(['1:1', '0:0']);
    expect(compute).toHaveBeenCalledTimes(3);
    store.dispose();
    runtime.dispose();
  });
  it('consumes a net-zero group without creating a document commit', () => {
    const runtime = setup();
    const group = runtime.history.group();
    runtime.update(tx => (tx.n = 1));
    runtime.update(tx => (tx.n = 0));
    const revision = runtime.revision();
    expect(group.cancel().status).toBe('unchanged');
    expect(runtime.history.current().undoDepth).toBe(0);
    expect(runtime.revision()).toBe(revision);
    const next = runtime.history.group();
    next.end();
    runtime.dispose();
  });
  it('restores pre-group history after cancellation, including capacity eviction and redo entries', () => {
    const runtime = createDocument({
      schema: object({ n: field<number>() }),
      initial: { n: 0 },
      history: { capacity: 1 },
    });
    runtime.update(tx => (tx.n = 1));
    const first = runtime.history.group();
    runtime.update(tx => (tx.n = 2));
    expect(first.cancel().status).toBe('committed');
    expect(runtime.history.current().undoDepth).toBe(1);
    runtime.history.undo();
    expect(runtime.snapshot().n).toBe(0);
    const second = runtime.history.group();
    runtime.update(tx => (tx.n = 9));
    expect(second.cancel().status).toBe('committed');
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 1 });
    runtime.history.redo();
    expect(runtime.snapshot().n).toBe(1);
    runtime.dispose();
  });
});
