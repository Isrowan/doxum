import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  list,
  map,
  object,
  select,
  snapshot,
  table,
  tree,
} from '../src';
import { startProfile } from '../src/profile';
describe('bounded mutation work', () => {
  it('reads nested entities without materializing addresses and writes from their resolved parents', () => {
    const count = 2000;
    const schema = object({
      rows: map(object({ position: object({ x: field<number>(), y: field<number>() }) })),
    });
    const ids = Array.from({ length: count }, (_, i) => String(i));
    const runtime = createDocument({
      schema,
      initial: { rows: Object.fromEntries(ids.map(id => [id, { position: { x: 1, y: 2 } }])) },
      history: false,
    });
    const reads = startProfile();
    const result = runtime.update(d => {
      let sum = 0;
      for (const id of ids) {
        const p = d.rows[id]!.position;
        sum += p.x + p.y;
      }
      return sum;
    });
    const readWork = reads.stop();
    expect(result).toMatchObject({ status: 'unchanged', value: count * 3 });
    expect(readWork.access).toMatchObject({ proxies: count * 2 + 2, addresses: 0, resolutions: 1 });
    expect(readWork.recorder.facts).toBe(0);
    const writes = startProfile();
    const changed = runtime.update(d => {
      for (const id of ids) {
        const p = d.rows[id]!.position;
        p.x++;
        p.y += 2;
      }
    });
    const writeWork = writes.stop();
    expect(changed.status).toBe('committed');
    expect(writeWork.access).toMatchObject({
      proxies: count * 2 + 2,
      addresses: count * 4 + 1,
      resolutions: 1,
    });
    expect(writeWork.address).toMatchObject({ schemaSteps: count * 2, documentSteps: count * 2 });
    expect(writeWork.recorder).toMatchObject({
      facts: count * 2,
      sealed: count * 2,
      orderSnapshots: 0,
    });
    expect(writeWork.copy.structures).toBe(0);
    expect(runtime.snapshot().rows['0'].position).toEqual({ x: 2, y: 4 });
    runtime.dispose();
  });
  it('shares renewed parent resolutions between retained descendants after a structural edit', () => {
    const schema = object({
      rows: map(object({ position: object({ x: field<number>(), y: field<number>() }) })),
    });
    const initial = { rows: { a: { position: { x: 1, y: 2 } } } };
    const runtime = createDocument({ schema, initial });
    const work = startProfile();
    const result = runtime.update(d => {
      const row = d.rows.a!,
        position = row.position;
      position.x = 3;
      d.rows.b = { position: { x: 5, y: 6 } };
      position.y = position.x + 1;
      expect(row.position).toBe(position);
      delete d.rows.a;
      d.rows.a = { position: { x: 8, y: 9 } };
      position.x = 10;
      expect(row.position).toBe(position);
    });
    const counters = work.stop();
    expect(result.status).toBe('committed');
    expect(counters.access.proxies).toBe(4);
    expect(counters.access.resolutions).toBeLessThanOrEqual(10);
    expect(runtime.snapshot().rows.a.position).toEqual({ x: 10, y: 9 });
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot().rows.a.position).toEqual({ x: 10, y: 9 });
  });
  it('inserts and removes a large table batch without argument limits or repeated order scans', () => {
    const schema = object({ rows: table(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema,
      initial: { rows: { ids: ['start', 'end'], byId: { start: { n: -1 }, end: { n: -2 } } } },
      history: false,
    });
    const entries = Array.from({ length: 130000 }, (_, i) => ({ id: String(i), value: { n: i } }));
    expect(runtime.update(d => d.rows.create(entries, { before: 'end' })).status).toBe('committed');
    const ids = select(runtime, d => d.rows.ids());
    expect(ids.length).toBe(entries.length + 2);
    expect(ids.slice(0, 3)).toEqual(['start', '0', '1']);
    expect(ids.slice(-2)).toEqual(['129999', 'end']);
    expect(runtime.update(d => d.rows.remove(entries.map(entry => entry.id))).status).toBe(
      'committed'
    );
    expect(select(runtime, d => d.rows.ids())).toEqual(['start', 'end']);
  });
  it('retains one first-touch fact for a million writes and none for unchanged writes', () => {
    const runtime = createDocument({
      schema: object({ n: field<number>() }),
      initial: { n: 0 },
      history: false,
    });
    const profile = startProfile();
    runtime.update(d => {
      for (let n = 0; n < 1000000; n++) d.n++;
    });
    expect(profile.stop().recorder).toMatchObject({ facts: 1, sealed: 1, orderSnapshots: 0 });
    const unchanged = startProfile();
    runtime.update(d => {
      for (let n = 0; n < 1000; n++) d.n = d.n;
    });
    expect(unchanged.stop().recorder.facts).toBe(0);
  });
  it('updates a 100k collection without cloning, enumerating, or validating unrelated entries', () => {
    const validator = vi.fn((n: unknown) => n as number),
      row = object({ n: field(validator), m: field<number>() });
    const schema = object({ rows: map(row) });
    const runtime = createDocument({
      schema,
      initial: {
        rows: Object.fromEntries(
          Array.from({ length: 100000 }, (_, n) => [String(n), { n, m: 0 }])
        ),
      },
      history: false,
    });
    validator.mockClear();
    const listener = vi.fn();
    for (let i = 0; i < 1000; i++) runtime.subscribe(p => p.rows.item(String(i)).n, listener);
    const profile = startProfile();
    const result = runtime.update(d => {
      d.rows['2000']!.n++;
    });
    const counters = profile.stop();
    expect(validator).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(counters.impact.affectsChecks).toBe(0);
    expect(counters.recorder).toMatchObject({ facts: 1, orderSnapshots: 0, sealed: 1 });
    expect(counters.copy.structures).toBe(0);
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.impact.collection(p => p.rows)).toMatchObject({
      updated: new Set(['2000']),
    });
  });
  it('copies one order baseline across many edits and records no order for table field edits', () => {
    const schema = object({ rows: table(object({ n: field<number>() })) });
    const ids = Array.from({ length: 10000 }, (_, n) => String(n));
    const runtime = createDocument({
      schema,
      initial: { rows: { ids, byId: Object.fromEntries(ids.map(n => [n, { n: 0 }])) } },
    });
    let profile = startProfile();
    runtime.update(d => d.rows.get('1')!.n++);
    expect(profile.stop().recorder.orderSnapshots).toBe(0);
    profile = startProfile();
    runtime.update(d => {
      for (const id of ids.slice(0, 100)) d.rows.move(id);
      d.rows.remove(['500', '700']);
    });
    expect(profile.stop().recorder).toMatchObject({ orderSnapshots: 1, orderItems: 10000 });
    runtime.history.undo();
    expect(runtime.snapshot().rows.ids).toEqual(ids);
  });
  it('captures only touched tree nodes for a value edit and reverses a 10k deep subtree iteratively', () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 10000 }, (_, i) => [
        String(i),
        {
          ...(i ? { parentId: String(i - 1) } : {}),
          children: i === 9999 ? [] : [String(i + 1)],
          value: i,
        },
      ])
    );
    const schema = object({ outline: tree(field<number>()) }),
      initial = { outline: { rootId: '0', nodes } },
      runtime = createDocument({ schema, initial });
    const profile = startProfile();
    runtime.update(d => d.outline.set('9999', 10000));
    expect(profile.stop().recorder.treeNodes).toBe(1);
    runtime.history.undo();
    runtime.update(d => d.outline.remove('1'));
    expect(Object.keys(runtime.snapshot().outline.nodes)).toEqual(['0']);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial);
  });
  it('replaces and restores a 100k list without argument spreading limits', () => {
    const schema = object({ rows: list(field<number>(), { keyOf: n => String(n) }) });
    const rows = Array.from({ length: 100000 }, (_, i) => i),
      runtime = createDocument({ schema, initial: { rows } });
    runtime.update(d => d.rows.replace([...rows].reverse()));
    expect(runtime.snapshot().rows[0]).toBe(99999);
    runtime.history.undo();
    expect(runtime.snapshot().rows).toEqual(rows);
  });
  it('replays a 150k list order without argument limits or quadratic key checks', () => {
    const schema = object({ rows: list(field<number>(), { keyOf: String }) });
    const rows = Array.from({ length: 150000 }, (_, i) => i);
    const runtime = createDocument({ schema, initial: { rows } });
    runtime.update(d => d.rows.move('0'));
    expect(runtime.snapshot().rows.at(-1)).toBe(0);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().rows).toEqual(rows);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot().rows.at(-1)).toBe(0);
  });
  it('keeps unrelated projected references stable after a sparse mutation', () => {
    const schema = object({ rows: map(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema,
      initial: {
        rows: Object.fromEntries(Array.from({ length: 10000 }, (_, n) => [String(n), { n }])),
      },
    });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const view = projection.map(
      projection.document(runtime).collection(p => p.rows),
      (_id, row) => snapshot(row)
    );
    const stable = view.item('1').current(),
      profile = startProfile();
    runtime.update(d => d.rows['2']!.n++);
    const counters = profile.stop();
    expect(view.item('1').current()).toBe(stable);
    expect(counters.collectionView).toMatchObject({
      mappedItems: 1,
      idsScanned: 0,
      arraysCopied: 0,
    });
    expect(counters.access.snapshots).toBe(1);
    projection.dispose();
  });
  it('rolls back a root replacement and subsequent edits in grouped history', () => {
    const runtime = createDocument({ schema: object({ n: field<number>() }), initial: { n: 0 } });
    const group = runtime.history.group();
    runtime.replace({ n: 1 });
    runtime.update(d => d.n++);
    group.end();
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().n).toBe(0);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot().n).toBe(2);
  });
  it('preserves address identity under slash, tilde, empty, and collision-like keys', () => {
    const schema = object({ rows: map(object({ n: field<number>() })) });
    const ids = ['', 'a/b', 'a~b', 'field-4534', 'field-76340'];
    const runtime = createDocument({
      schema,
      initial: { rows: Object.fromEntries(ids.map(id => [id, { n: 0 }])) },
    });
    const listeners = ids.map(id => {
      const listener = vi.fn();
      runtime.subscribe(p => p.rows.item(id).n, listener);
      return listener;
    });
    ids.forEach(id => runtime.update(d => d.rows[id]!.n++));
    listeners.forEach(listener => expect(listener).toHaveBeenCalledTimes(1));
    expect(select(runtime, d => ids.map(id => d.rows[id]!.n))).toEqual([1, 1, 1, 1, 1]);
  });
});
