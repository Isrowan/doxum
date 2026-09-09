import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionStore,
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
} from '../src';
import { startProfile } from '../src/profile';
import { assign } from '../src';
describe('projection composition', () => {
  it('materializes one reusable definition independently in each store', () => {
    const n = input(1);
    const doubled = project({ n }, ({ n }) => n * 2);
    const first = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const second = createProjectionStore({
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
    const store = createProjectionStore({ onError: () => {} });

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
    const store = createProjectionStore({
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
      assign(tx, 'content', { kind: 'populated', rows: { ids: ['a'], byId: { a: { n: 1 } } } })
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
    const store = createProjectionStore({
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
    const store = createProjectionStore({ onError: () => {} });
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
  it('maps projected collections including present undefined values, order changes and disposal', () => {
    const store = createProjectionStore({
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
  it('publishes document candidate keys once per batch including net-zero changes and reset', () => {
    const model = object({ title: field<string>(), rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { title: '', rows: { ids: ['a'], byId: { a: { n: 0 } } } },
    });
    const store = createProjectionStore({
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
      runtime.update(tx => tx.rows.create({ id: 'b', value: { n: 2 } }));
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
    const store = createProjectionStore({
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
    const store = createProjectionStore({ onError: () => {} });
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
    runtime.update(tx => tx.rows.create({ id: 'b', value: { n: 2 } }));
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
    const store = createProjectionStore({ onError: () => {} });
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
    const store = createProjectionStore({
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
