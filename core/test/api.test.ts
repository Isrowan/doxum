import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  object,
  table,
  variant,
  TransactionRejected,
  type ProjectionValue,
  type Readable,
} from '../src';
import { startProfile } from '../src/profile';
import { assign } from '../src';
describe('projection composition', () => {
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
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const source = projection.document(runtime).collection(path => path.content.rows);
    const mapped = projection.map(source, (_id, row) => row.n);
    expect(mapped.ids.current()).toEqual([]);
    runtime.update(tx =>
      assign(tx, 'content', { kind: 'populated', rows: { ids: ['a'], byId: { a: { n: 1 } } } })
    );
    expect(mapped.item('a').current()).toBe(1);
    runtime.history.undo();
    expect(mapped.ids.current()).toEqual([]);
    runtime.history.redo();
    expect(mapped.item('a').current()).toBe(1);
    projection.dispose();
    runtime.dispose();
  });
  it('updates a two-stage 100k mapping without scanning unrelated keys', () => {
    const ids = Array.from({ length: 100000 }, (_, n) => String(n));
    const model = object({ rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { rows: { ids, byId: Object.fromEntries(ids.map(id => [id, { n: Number(id) }])) } },
    });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const first = projection.map(
      projection.document(runtime).collection(path => path.rows),
      (_id, row) => row.n
    );
    const second = projection.map(first, (_id, n) => ({ n }));
    const stable = second.item('2').current();
    const profile = startProfile();
    runtime.update(tx => (tx.rows.get('1')!.n = 99));
    const counters = profile.stop();
    expect(counters.collectionView.mappedItems).toBe(2);
    expect(counters.collectionView.idsScanned).toBe(0);
    expect(counters.collectionView.arraysCopied).toBe(0);
    expect(second.item('1').current()).toEqual({ n: 99 });
    expect(second.item('2').current()).toBe(stable);
    projection.dispose();
    runtime.dispose();
  });
  it('infers pure and stateful values independently from equality and rejects asynchronous computes', () => {
    const projection = createProjectionRuntime({ onError: () => {} });
    const input = projection.input(1);
    const pure = projection.value({ n: input.source }, ({ n }) => ({ n: n.value % 2 }), {
      isEqual: (a, b) => a.n === b.n,
    });
    const stateful = projection.value(
      {
        sources: { n: input.source },
        build: ({ n }) => ({
          value: { n: n.value },
          update: ({ n }) => ({ kind: 'changed', value: { n: n.value } }),
        }),
      },
      { isEqual: (a, b) => a.n === b.n }
    );
    expectTypeOf(pure).toEqualTypeOf<
      ProjectionValue<{
        n: number;
      }>
    >();
    expectTypeOf(stateful).toEqualTypeOf<
      ProjectionValue<{
        n: number;
      }>
    >();
    const before = pure.current();
    input.set(3);
    expect(pure.current()).toBe(before);
    expect(stateful.current()).toEqual({ n: 3 });
    // @ts-expect-error Pure computations must be synchronous.
    expect(() => projection.value({ n: input.source }, async ({ n }) => n.value)).toThrow(
      'synchronous'
    );
    projection.dispose();
  });
  it('maps projected collections including present undefined values, order changes and disposal', () => {
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const source = projection.input(false);
    const rows = projection.collection<number | undefined>()({
      sources: { source: source.source },
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
    });
    const mapper = vi.fn((_id: string, value: number | undefined) =>
      value === undefined ? 'empty' : String(value)
    );
    const mapped = projection.map(rows, mapper);
    expect(mapped.item('a').current()).toBe('empty');
    mapper.mockClear();
    source.set(true);
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(mapped.ids.current()).toEqual(['b', 'a']);
    source.set(false);
    expect(mapped.ids.current()).toEqual(['b']);
    expect(mapped.item('a').current()).toBeUndefined();
    expect(() => rows.dispose()).toThrow();
    mapped.dispose();
    rows.dispose();
    projection.dispose();
  });
  it('publishes document candidate keys once per batch including net-zero changes and reset', () => {
    const model = object({ title: field<string>(), rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { title: '', rows: { ids: ['a'], byId: { a: { n: 0 } } } },
    });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const rows = projection.document(runtime).collection(path => path.rows);
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
    const summary = projection.value({ rows }, compute);
    runtime.update(tx => (tx.title = 'unrelated'));
    expect(compute).toHaveBeenCalledTimes(1);
    projection.batch(() => {
      runtime.update(tx => (tx.rows.get('a')!.n = 1));
      runtime.update(tx => (tx.rows.get('a')!.n = 0));
      runtime.update(tx => tx.rows.create({ id: 'b', value: { n: 2 } }));
      runtime.update(tx => tx.rows.remove('b'));
    });
    expect(summary.current()).toBe('a,b');
    expect(compute).toHaveBeenCalledTimes(2);
    runtime.replace({ title: '', rows: { ids: [], byId: {} } });
    expect(summary.current()).toBe('reset');
    projection.dispose();
    runtime.dispose();
  });
  it('shares external subscriptions while honoring distinct equality policies atomically', () => {
    const projection = createProjectionRuntime({
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
    const x = projection.fromReadable(readable, { isEqual: equalX });
    const y = projection.fromReadable(readable, { isEqual: (a, b) => a.y === b.y });
    expect(projection.fromReadable(readable, { isEqual: equalX })).toBe(x);
    const compute = vi.fn(
      ({
        x,
        y,
      }: {
        x: {
          value: typeof value;
        };
        y: {
          value: typeof value;
        };
      }) => [x.value.x, y.value.y]
    );
    const result = projection.value({ x, y }, compute);
    value = { x: 1, y: 2 };
    listeners.forEach(listener => listener());
    expect(result.current()).toEqual([1, 2]);
    value = { x: 3, y: 4 };
    listeners.forEach(listener => listener());
    expect(result.current()).toEqual([3, 4]);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(subscribe).toHaveBeenCalledTimes(1);
    projection.dispose();
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
    const projection = createProjectionRuntime({ onError: () => {} });
    const view = projection.value(
      { document: projection.document(runtime) },
      ({ document }) => document.read.n
    );
    const fault = new Error('history listener');
    const observed: number[] = [];
    runtime.history.subscribe(() => {
      throw fault;
    });
    runtime.history.subscribe(() => {
      observed.push(view.current());
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
    projection.dispose();
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
    const projection = createProjectionRuntime({ onError: () => {} });
    const history = projection.fromReadable(runtime.history);
    const count = projection.value({ history }, ({ history }) => history.value.undoDepth);
    const group = runtime.history.group();
    expect(() => runtime.history.group()).toThrow('already active');
    runtime.update(tx => (tx.n = 1));
    expect(count.current()).toBe(1);
    group.end();
    runtime.history.clear();
    expect(count.current()).toBe(0);
    projection.dispose();
    runtime.dispose();
  });
  it('settles document and history sources together before any graph listener', () => {
    const runtime = setup();
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const compute = vi.fn(
      ({
        document,
        history,
      }: {
        document: {
          read: {
            n: number;
          };
        };
        history: {
          value: {
            undoDepth: number;
          };
        };
      }) => `${document.read.n}:${history.value.undoDepth}`
    );
    const summary = projection.value(
      { document: projection.document(runtime), history: projection.fromReadable(runtime.history) },
      compute
    );
    const observed: string[] = [];
    summary.subscribe(() => observed.push(summary.current()));
    runtime.update(tx => (tx.n = 1));
    runtime.history.undo();
    expect(observed).toEqual(['1:1', '0:0']);
    expect(compute).toHaveBeenCalledTimes(3);
    projection.dispose();
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
