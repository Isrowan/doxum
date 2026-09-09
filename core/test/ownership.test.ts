import { describe, expect, it, vi } from 'vitest';
import {
  replace,
  createDocument,
  createProjectionStore,
  field,
  list,
  map,
  object,
  parse,
  project,
  select,
  snapshot,
  table,
  tree,
  TransactionRejected,
  type ObjectNode,
} from '../src';
import { startProfile } from '../src/profile';

describe('shared immutable payload ownership', () => {
  it('diffs a deep replacement without rechecking every ancestor subtree', () => {
    let visits = 0;
    const observe = <T extends object>(node: T): T =>
      new Proxy(node, {
        get(target, key, receiver) {
          if (key === 'kind') visits++;
          return Reflect.get(target, key, receiver);
        },
      });
    let node: ObjectNode = observe(object({ n: observe(field<number>()) }));
    let before: Record<string, unknown> = { n: 0 },
      after: Record<string, unknown> = { n: 1 };
    const depth = 80;
    for (let i = 0; i < depth; i++) {
      node = observe(object({ child: node }));
      before = { child: before };
      after = { child: after };
    }
    const schema = object({ rows: map(node) });
    const runtime = createDocument({ schema, initial: { rows: { a: before } } });
    visits = 0;
    const result = runtime.update(d => {
      d.rows.put('a', after);
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected commit');
    expect(result.commit.changes.changes).toHaveLength(1);
    expect(visits).toBeLessThan(depth * 40);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().rows.a).toEqual(before);
  });
  it('never enumerates large payloads during validation, publication, snapshots or replay', () => {
    const enumerate = vi.fn(() => {
      throw new Error('Payload was traversed');
    });
    const payload = new Proxy({ values: new Array(100000).fill(1) }, { ownKeys: enumerate });
    const validate = vi.fn((value: unknown) => value as typeof payload);
    const schema = object({ payload: field(validate) });
    const original = { values: [0] };
    const runtime = createDocument({ schema, initial: { payload: original } });
    const mirror = createDocument({ schema, initial: { payload: original } });
    validate.mockClear();
    const profile = startProfile();
    const result = runtime.update(d => {
      d.payload = payload;
    });
    const counters = profile.stop();
    expect(counters.copy.structures).toBe(0);
    expect(validate.mock.calls).toHaveLength(1);
    expect(validate.mock.calls[0][0]).toBe(payload);
    if (result.status !== 'committed') throw new Error('Expected commit');
    expect(runtime.snapshot().payload).toBe(payload);
    expect(select(runtime, d => snapshot(d.payload))).toBe(payload);
    expect(parse(field(validate), payload)).toBe(payload);
    expect(mirror.apply(result.commit.changes, { expectedRevision: 0 }).status).toBe('committed');
    expect(mirror.snapshot().payload).toBe(payload);
    runtime.history.undo();
    expect(runtime.snapshot().payload).toBe(original);
    runtime.history.redo();
    expect(runtime.snapshot().payload).toBe(payload);
    expect(enumerate).not.toHaveBeenCalled();
  });

  it('keeps published structures stable across future writes and repeated history travel', () => {
    const payload = { data: [1, 2, 3] };
    const row = object({ n: field<number>(), payload: field<typeof payload>() });
    const schema = object({
      rows: map(row),
      ordered: table(row),
      items: list(field<{ id: string; payload: typeof payload }>(), { keyOf: v => v.id }),
      outline: tree(field<typeof payload>()),
    });
    const initial = { rows: {}, ordered: { ids: [], byId: {} }, items: [], outline: { nodes: {} } };
    const runtime = createDocument({ schema, initial });
    const input = { n: 1, payload };
    const item = { id: 'a', payload };
    const result = runtime.update(d => {
      d.rows.put('a', input);
      d.ordered.create('a', input);
      d.items.insert(item);
      d.outline.insert('root', payload);
    });
    if (result.status !== 'committed') throw new Error('Expected commit');
    const changes = result.commit.changes;
    const saved = runtime.snapshot();
    const serialized = JSON.stringify(changes);
    const mirror = createDocument({ schema, initial });
    mirror.apply(changes, { expectedRevision: 0 });
    runtime.update(d => {
      d.rows.get('a')!.n = 2;
      d.ordered.get('a')!.n = 3;
      d.items.insert({ id: 'b', payload });
      d.outline.insert('child', payload, { parentId: 'root' });
    });
    expect(input.n).toBe(1);
    expect(saved.rows.a.n).toBe(1);
    expect(saved.ordered.byId.a.n).toBe(1);
    expect(saved.items).toEqual([item]);
    expect(saved.outline.nodes.root.children).toEqual([]);
    expect(saved.rows.a.payload).toBe(payload);
    expect(saved.items[0]).toBe(item);
    expect(saved.outline.nodes.root.value).toBe(payload);
    for (let i = 0; i < 2; i++) {
      runtime.history.undo();
      runtime.history.undo();
      runtime.history.redo();
      runtime.history.redo();
    }
    mirror.update(d => {
      d.rows.get('a')!.n = 9;
      d.outline.insert('other', payload, { parentId: 'root' });
    });
    expect(JSON.stringify(changes)).toBe(serialized);
    expect(saved.outline.nodes.root.children).toEqual([]);
  });

  it('absorbs replaced parents without losing payload identity or notifying unchanged fields', () => {
    const before = { n: 1 },
      after = { n: 2 };
    const schema = object({
      rows: map(object({ payload: field<typeof before>(), n: field<number>() })),
    });
    const runtime = createDocument({ schema, initial: { rows: { a: { payload: before, n: 0 } } } });
    const listener = vi.fn();
    runtime.subscribe(p => p.rows.item('a').payload, listener);
    const group = runtime.history.group();
    runtime.update(d => {
      d.rows.get('a')!.payload = after;
    });
    runtime.update(d => {
      d.rows.get('a')!.payload = before;
    });
    group.end();
    listener.mockClear();
    expect(runtime.history.undo().status).toBe('unchanged');
    expect(listener).not.toHaveBeenCalled();
    expect(
      runtime.update(d => {
        d.rows.get('a')!.payload = after;
        d.rows.remove('a');
        d.rows.put('a', { payload: before, n: 0 });
      }).status
    ).toBe('unchanged');
    expect(listener).not.toHaveBeenCalled();
    runtime.update(d => {
      d.rows.get('a')!.payload = after;
      d.rows.remove('a');
      d.rows.put('a', { payload: before, n: 1 });
    });
    expect(listener).not.toHaveBeenCalled();
    runtime.history.undo();
    expect(runtime.snapshot().rows.a.payload).toBe(before);
  });

  it('restores exact references after late validator rejection and ordinary exceptions', () => {
    const before = { n: 1 },
      after = { n: 2 };
    const schema = object({
      payload: field<typeof before>(),
      z: field((v: unknown) => {
        if (typeof v !== 'number') throw new Error('number');
        return v;
      }),
    });
    const runtime = createDocument({ schema, initial: { payload: before, z: 0 } });
    const listener = vi.fn();
    runtime.subscribe(listener);
    expect(
      runtime.apply(
        {
          changes: [
            {
              kind: 'members',
              at: [],
              members: [
                { key: 'payload', kind: 'updated', before: 'untrusted', after },
                { key: 'z', kind: 'updated', before: 0, after: 'bad' },
              ],
            },
          ],
        },
        { expectedRevision: 0 }
      ).status
    ).toBe('rejected');
    expect(runtime.snapshot().payload).toBe(before);
    const error = new Error('aborted');
    expect(() =>
      runtime.update(d => {
        d.payload = after;
        throw error;
      })
    ).toThrow(error);
    expect(runtime.snapshot().payload).toBe(before);
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current().undoDepth).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps root and nested structural replacements reversible with shared payloads', () => {
    const payload = { n: 1 };
    const schema = object({
      rows: map(object({ payload: field<typeof payload>(), n: field<number>() })),
    });
    const initial = { rows: { a: { payload, n: 0 } } };
    const runtime = createDocument({ schema, initial });
    const group = runtime.history.group();
    runtime.update(d => {
      d.rows.get('a')!.n = 1;
    });
    const reset = runtime.replace({ rows: { a: { payload, n: 2 } } });
    group.end();
    if (reset.status !== 'committed') throw new Error('Expected reset');
    const serialized = JSON.stringify(reset.commit.changes);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().rows.a.payload).toBe(payload);
    expect(runtime.snapshot()).toEqual(initial);
    runtime.history.redo();
    expect(
      runtime.update(d => {
        d.rows.get('a')!.n = 3;
        d.rows.put('a', { payload, n: 4 });
        throw new TransactionRejected({ code: 'abort', message: 'abort' });
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot().rows.a.n).toBe(2);
    expect(JSON.stringify(reset.commit.changes)).toBe(serialized);
  });

  it('retains projected payload references and leaves unrelated items stable', () => {
    const a = { n: 1 },
      b = { n: 2 },
      next = { n: 3 };
    const runtime = createDocument({
      schema: object({ rows: map(field<typeof a>()) }),
      initial: { rows: { a, b } },
    });
    const store = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const view = project(
      runtime,
      p => p.rows,
      (_id, value) => snapshot(value)
    );
    expect(store.get(view).get('a')).toBe(a);
    runtime.update(d => {
      d.rows.put('a', next);
    });
    expect(store.get(view).get('a')).toBe(next);
    expect(store.get(view).get('b')).toBe(b);
    runtime.history.undo();
    expect(store.get(view).get('a')).toBe(a);
    store.dispose();
  });
});
