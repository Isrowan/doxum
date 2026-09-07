import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  dict,
  field,
  list,
  object,
  optional,
  schema,
  select,
  table,
  tree,
  variant,
  type ProjectionValue,
  type Readable,
} from '../src';
import { startProfile } from '../src/profile';

describe('public schema and access contracts', () => {
  it('reads variants as discriminated values and initializes optional variants reversibly', () => {
    const choice = variant('kind', {
      note: object({ text: field<string>() }),
      task: object({ done: field<boolean>() }),
    });
    const model = schema({ choice: optional(choice) });
    const runtime = createDocument({ schema: model, initial: {} });
    expect(select(runtime, read => read.choice.get())).toBeUndefined();
    const listener = vi.fn();
    runtime.subscribe(
      model.value(path => path.choice),
      listener
    );
    const result = runtime.update(tx => tx.write.choice.replace({ kind: 'note', text: 'A' }));
    expect(result.status).toBe('committed');
    const value = select(runtime, read => read.choice.get());
    if (value?.kind === 'note') expectTypeOf(value.text).toEqualTypeOf<string>();
    expect(value).toEqual({ kind: 'note', text: 'A' });
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual({});
    expect(runtime.history.redo().status).toBe('committed');
    expect(
      runtime.update(tx => {
        tx.write.choice.replace({ kind: 'task', done: true });
        tx.reject({ code: 'invalid', message: 'No' });
      }).status
    ).toBe('rejected');
    expect(select(runtime, read => read.choice.get())).toEqual(value);
    expect(listener).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  it('validates selector identity and permits business fields named address and item', () => {
    const model = schema({
      address: field<string>(),
      item: object({ address: field<number>() }),
      rows: table(object({ item: field<string>() })),
    });
    expect(model.value(path => path.address).address).toEqual(['address']);
    expect(model.value(path => path.item.address).address).toEqual(['item', 'address']);
    expect(model.value(path => path.rows.item('a').item).address).toEqual(['rows', 'a', 'item']);
    // @ts-expect-error Only collection paths are accepted.
    expect(() => model.collection(path => path.address)).toThrow('table or map');
    // @ts-expect-error Plain objects are not paths.
    expect(() => model.value(() => ({ address: ['rows'] }))).toThrow('return a path');
    // @ts-expect-error Non-collection nodes have no item traversal method.
    expect(() => model.value(path => path.address.item('x'))).toThrow('Invalid schema');
    // @ts-expect-error Optional objects do not have a complete presence protocol.
    expect(() => optional(object({ title: field<string>() }))).toThrow('optional presence');
  });

  it('reads dictionary keys without copying unrelated values and lists by their stable keys', () => {
    const model = schema({
      values: dict<string, { n: number }>(),
      rows: list<{ id: string; n: number }>({ keyOf: value => value.id }),
    });
    const values = Object.fromEntries(Array.from({ length: 10_000 }, (_, n) => [String(n), { n }]));
    const runtime = createDocument({
      schema: model,
      initial: {
        values,
        rows: [
          { id: 'a', n: 1 },
          { id: 'b', n: 2 },
        ],
      },
    });
    const profile = startProfile();
    expect(select(runtime, read => read.values.get('5'))).toEqual({ n: 5 });
    expect(select(runtime, read => read.values.has('missing'))).toBe(false);
    expect(profile.stop().reader.structuralSnapshots).toBe(0);
    expect(
      runtime.update(tx => {
        tx.write.values.set('5', { n: 6 });
        tx.write.rows.move('b', { at: 'start' });
        expect(tx.read.rows.get('b')).toEqual({ id: 'b', n: 2 });
        tx.write.rows.remove('b');
        expect(tx.read.rows.has('b')).toBe(false);
        tx.reject({ code: 'cancel', message: 'No' });
      }).status
    ).toBe('rejected');
    expect(select(runtime, read => read.values.get('5'))).toEqual({ n: 5 });
    expect(select(runtime, read => read.rows.get('b'))).toEqual({ id: 'b', n: 2 });
    runtime.dispose();
  });

  it('uses named tree positions and preserves inverse, impact and rollback', () => {
    const model = schema({ outline: tree<string>() });
    const runtime = createDocument({ schema: model, initial: { outline: { nodes: {} } } });
    const listener = vi.fn();
    runtime.subscribe(
      model.value(path => path.outline),
      listener
    );
    runtime.update(tx => {
      tx.write.outline.insert('root', 'Root');
      tx.write.outline.insert('a', 'A', { parentId: 'root' });
      tx.write.outline.insert('b', 'B', { parentId: 'root', index: 0 });
    });
    expect(select(runtime, read => read.outline.children('root'))).toEqual(['b', 'a']);
    expect(
      runtime.update(tx => {
        tx.write.outline.move('a', { parentId: 'root', index: 0 });
        tx.write.outline.move('root', { parentId: 'a' });
      }).status
    ).toBe('rejected');
    expect(select(runtime, read => read.outline.children('root'))).toEqual(['b', 'a']);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual({ outline: { nodes: {} } });
    runtime.history.redo();
    expect(listener).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  it('rejects async transactions at compile time and rolls back synchronous work at runtime', () => {
    const runtime = createDocument({ schema: schema({ n: field<number>() }), initial: { n: 0 } });
    expect(() =>
      // @ts-expect-error Async transactions are not accepted.
      runtime.update(async tx => {
        tx.write.n.set(1);
      })
    ).toThrow('synchronous');
    expect(() =>
      // @ts-expect-error Async preparations are not accepted.
      runtime.prepare(async tx => {
        tx.write.n.set(2);
      })
    ).toThrow('synchronous');
    expect(runtime.snapshot()).toEqual({ n: 0 });
    runtime.dispose();
  });
});

describe('projection composition', () => {
  it('binds collections in inactive variant branches and rebuilds across branch changes', () => {
    const model = schema({
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
    const mapped = projection.map(source, (_id, row) => row.n.get());
    expect(mapped.ids.current()).toEqual([]);
    runtime.update(tx =>
      tx.write.content.replace({ kind: 'populated', rows: { ids: ['a'], byId: { a: { n: 1 } } } })
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
    const ids = Array.from({ length: 100_000 }, (_, n) => String(n));
    const model = schema({ rows: table(object({ n: field<number>() })) });
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
      (_id, row) => row.n.get()
    );
    const second = projection.map(first, (_id, n) => ({ n }));
    const stable = second.item('2').current();
    const profile = startProfile();
    runtime.update(tx => tx.write.rows.item('1').n.set(99));
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
    expectTypeOf(pure).toEqualTypeOf<ProjectionValue<{ n: number }>>();
    expectTypeOf(stateful).toEqualTypeOf<ProjectionValue<{ n: number }>>();
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
    const model = schema({ title: field<string>(), rows: table(object({ n: field<number>() })) });
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
        rows: { reset: boolean; candidates: { keys: readonly string[]; orderDirty: boolean } };
      }) => (rows.reset ? 'reset' : rows.candidates.keys.join(','))
    );
    const summary = projection.value({ rows }, compute);
    runtime.update(tx => tx.write.title.set('unrelated'));
    expect(compute).toHaveBeenCalledTimes(1);
    projection.batch(() => {
      runtime.update(tx => tx.write.rows.item('a').n.set(1));
      runtime.update(tx => tx.write.rows.item('a').n.set(0));
      runtime.update(tx => tx.write.rows.create({ id: 'b', value: { n: 2 } }));
      runtime.update(tx => tx.write.rows.remove('b'));
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
      ({ x, y }: { x: { value: typeof value }; y: { value: typeof value } }) => [
        x.value.x,
        y.value.y,
      ]
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
      schema: schema({ n: field<number>(), title: field<string>() }),
      initial: { n: 0, title: '' },
    });

  it('records continuous commits as one undo entry and exposes settled state to listeners', () => {
    const runtime = setup();
    const initial = runtime.history.current();
    const group = runtime.history.group();
    runtime.update(tx => tx.write.n.set(1));
    const first = runtime.history.current();
    runtime.update(tx => tx.write.n.set(2));
    runtime.update(tx => tx.write.title.set('done'));
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
    runtime.update(tx => tx.write.n.set(1));
    runtime.update(tx => {
      tx.write.title.set('rejected');
      tx.reject({ code: 'no', message: 'No' });
    });
    runtime.update(tx => tx.write.n.set(2));
    expect(group.cancel().status).toBe('committed');
    expect(runtime.snapshot()).toEqual({ n: 0, title: '' });
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    const interrupted = runtime.history.group();
    runtime.update(tx => tx.write.n.set(3));
    runtime.update(tx => tx.write.title.set('system'), { history: false });
    runtime.update(tx => tx.write.n.set(4));
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
    const view = projection.value({ document: projection.document(runtime) }, ({ document }) =>
      document.read.n.get()
    );
    const fault = new Error('history listener');
    const observed: number[] = [];
    runtime.history.subscribe(() => {
      throw fault;
    });
    runtime.history.subscribe(() => {
      observed.push(view.current());
      runtime.update(tx => tx.write.n.set(99));
    });
    runtime.history.subscribe(() => observed.push(runtime.history.current().undoDepth));
    const result = runtime.update(tx => tx.write.n.set(1));
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
    const model = schema({ rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { rows: { ids: ['a'], byId: { a: { n: 0 } } } },
    });
    const group = runtime.history.group();
    runtime.update(tx => tx.write.rows.item('a').n.set(1));
    runtime.update(tx => tx.write.rows.create({ id: 'b', value: { n: 2 } }));
    group.end();
    runtime.update(tx => tx.write.rows.remove('a'), { history: false });
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
    runtime.update(tx => tx.write.n.set(1));
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
        document: { read: { n: { get(): number } } };
        history: { value: { undoDepth: number } };
      }) => `${document.read.n.get()}:${history.value.undoDepth}`
    );
    const summary = projection.value(
      { document: projection.document(runtime), history: projection.fromReadable(runtime.history) },
      compute
    );
    const observed: string[] = [];
    summary.subscribe(() => observed.push(summary.current()));
    runtime.update(tx => tx.write.n.set(1));
    runtime.history.undo();
    expect(observed).toEqual(['1:1', '0:0']);
    expect(compute).toHaveBeenCalledTimes(3);
    projection.dispose();
    runtime.dispose();
  });

  it('consumes a net-zero group without creating a document commit', () => {
    const runtime = setup();
    const group = runtime.history.group();
    runtime.update(tx => tx.write.n.set(1));
    runtime.update(tx => tx.write.n.set(0));
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
      schema: schema({ n: field<number>() }),
      initial: { n: 0 },
      history: { capacity: 1 },
    });
    runtime.update(tx => tx.write.n.set(1));
    const first = runtime.history.group();
    runtime.update(tx => tx.write.n.set(2));
    expect(first.cancel().status).toBe('committed');
    expect(runtime.history.current().undoDepth).toBe(1);
    runtime.history.undo();
    expect(runtime.snapshot().n).toBe(0);
    const second = runtime.history.group();
    runtime.update(tx => tx.write.n.set(9));
    expect(second.cancel().status).toBe('committed');
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 1 });
    runtime.history.redo();
    expect(runtime.snapshot().n).toBe(1);
    runtime.dispose();
  });
});
