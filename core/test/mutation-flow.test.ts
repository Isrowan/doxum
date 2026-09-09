import { describe, expect, it, vi } from 'vitest';
import { replace, createDocument, field, list, map, object, table, tree, variant } from '../src';
import { jsonChanges } from '../src/local-sync/json';
import { startProfile } from '../src/profile';
import { track, subscribeDependencies } from '../src/integration';

const number = (value: unknown): number => {
  if (typeof value !== 'number') throw new Error('Expected number');
  return value;
};

describe('complete container changes', () => {
  const schema = object({ rows: table(object({ n: field(number) })), z: field(number) });
  const initial = { rows: { ids: ['a', 'b'], byId: { a: { n: 1 }, b: { n: 2 } } }, z: 0 };

  it('publishes one member/order group with exact impact and reversible local before values', () => {
    const source = createDocument({ schema, initial });
    const result = source.update(d => {
      d.rows.create('c', { n: 3 }, { at: 'start' });
      d.rows.move('b', { at: 'start' });
      d.rows.get('a')!.n = 4;
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.changes.changes).toEqual([
      {
        kind: 'members',
        at: ['rows'],
        members: [{ key: 'c', kind: 'added', after: { n: 3 } }],
        order: { before: ['a', 'b'], after: ['b', 'c', 'a'] },
      },
      {
        kind: 'members',
        at: ['rows', 'a'],
        members: [{ key: 'n', kind: 'updated', before: 1, after: 4 }],
      },
    ]);
    expect(result.commit.impact.collection(p => p.rows)).toEqual({
      kind: 'incremental',
      added: new Set(['c']),
      removed: new Set(),
      updated: new Set(['a']),
      orderChanged: true,
    });
    expect(result.commit.impact.affects(p => p.rows.item('b').n)).toBe(false);
    expect(() => jsonChanges(result.commit.changes, 'changes', { maxChanges: 2 })).toThrow('count');

    const target = createDocument({ schema, initial });
    const decoded = { changes: [...structuredClone(result.commit.changes).changes].reverse() };
    expect(target.apply(decoded, { expectedRevision: 0 }).status).toBe('committed');
    expect(target.snapshot()).toEqual(source.snapshot());
    expect(target.history.undo().status).toBe('committed');
    expect(target.snapshot()).toEqual(initial);
    expect(target.history.redo().status).toBe('committed');
    expect(target.snapshot()).toEqual(source.snapshot());

    const rejected = createDocument({ schema, initial });
    const listener = vi.fn();
    rejected.subscribe(listener);
    expect(
      rejected.apply(
        {
          changes: [
            ...decoded.changes,
            {
              kind: 'members',
              at: ['z'],
              members: [{ key: 'missing', kind: 'added', after: 1 }],
            },
          ],
        },
        { expectedRevision: 0 }
      ).status
    ).toBe('rejected');
    expect(rejected.snapshot()).toEqual(initial);
    expect(rejected.revision()).toBe(0);
    expect(rejected.history.current().undoDepth).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(
    [
      [{ kind: 'order', at: ['rows'], before: ['a', 'b'], after: ['b', 'a'] }],
      [{ kind: 'members', at: ['rows'], members: [], order: undefined }],
      [
        {
          kind: 'members',
          at: ['rows'],
          members: [],
          order: { before: [], after: [], extra: true },
        },
      ],
      [{ kind: 'members', at: ['rows'], members: [], order: { after: [] } }],
      [
        { kind: 'members', at: ['rows'], members: [{ key: 'c', kind: 'added', after: { n: 3 } }] },
        {
          kind: 'members',
          at: ['rows'],
          members: [],
          order: { before: ['a', 'b'], after: ['a', 'b', 'c'] },
        },
      ],
    ].map(changes => ({ changes }))
  )('rejects obsolete or incomplete container records: %j', input => {
    const runtime = createDocument({ schema, initial });
    expect(runtime.apply(input, { expectedRevision: 0 })).toMatchObject({
      status: 'rejected',
      issues: [{ code: 'invalid-changes' }],
    });
    expect(runtime.snapshot()).toEqual(initial);
  });

  it('publishes order-only changes without revalidating values or notifying value listeners', () => {
    const validate = vi.fn(number);
    const model = object({ rows: table(object({ n: field(validate) })) });
    const runtime = createDocument({ schema: model, initial: { rows: initial.rows } });
    const listener = vi.fn();
    runtime.subscribe(p => p.rows.item('a').n, listener);
    validate.mockClear();
    const result = runtime.update(d => d.rows.move('b', { at: 'start' }));
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.changes.changes).toEqual([
      {
        kind: 'members',
        at: ['rows'],
        members: [],
        order: { before: ['a', 'b'], after: ['b', 'a'] },
      },
    ]);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().rows).toEqual(initial.rows);
    expect(validate).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([1, 1000])('resolves a bulk table operation independently of its %i entries', count => {
    const model = object({ nested: object({ rows: table(object({ n: field<number>() })) }) });
    const runtime = createDocument({
      schema: model,
      initial: { nested: { rows: { ids: [], byId: {} } } },
      history: false,
    });
    const entries = Array.from({ length: count }, (_, i) => ({ id: String(i), value: { n: i } }));
    const profile = startProfile();
    expect(runtime.update(d => d.nested.rows.create(entries)).status).toBe('committed');
    const counters = profile.stop();
    expect(counters.address.schemaSteps).toBeLessThanOrEqual(6);
    expect(counters.address.documentSteps).toBeLessThanOrEqual(6);
    expect(counters.recorder.orderSnapshots).toBe(1);
    expect(counters.recorder.sealed).toBe(1);
    const removal = startProfile();
    expect(runtime.update(d => d.nested.rows.remove(entries.map(e => e.id))).status).toBe(
      'committed'
    );
    expect(removal.stop().address.documentSteps).toBeLessThanOrEqual(6);
    expect(runtime.snapshot().nested.rows).toEqual({ ids: [], byId: {} });
  });
});

describe('collection access lifetime', () => {
  const branch = () =>
    object({
      rows: table(object({ n: field<number>() })),
      items: list(field<{ id: string }>(), { keyOf: v => v.id }),
      outline: tree(field<number>()),
    });
  const values = {
    rows: { ids: ['a'], byId: { a: { n: 1 } } },
    items: [{ id: 'a' }],
    outline: { rootId: 'a', nodes: { a: { value: 1, children: [] } } },
  };

  it('tracks absent table and list gets without subscribing to unrelated members', () => {
    const runtime = createDocument({ schema: branch(), initial: values });
    const tableRead = track(runtime, d => d.rows.get('missing')?.n);
    const listRead = track(runtime, d => d.items.get('missing'));
    const tableListener = vi.fn(),
      listListener = vi.fn();
    subscribeDependencies(runtime, tableRead.targets, tableListener);
    subscribeDependencies(runtime, listRead.targets, listListener);
    runtime.update(d => {
      d.rows.get('a')!.n = 2;
      d.items.replace('a', { id: 'a' });
    });
    expect(tableListener).not.toHaveBeenCalled();
    expect(listListener).not.toHaveBeenCalled();
    runtime.update(d => {
      d.rows.create('missing', { n: 3 });
      d.items.insert({ id: 'missing' });
    });
    expect(tableListener).toHaveBeenCalledTimes(1);
    expect(listListener).toHaveBeenCalledTimes(1);
  });

  it('rejects retained methods after a branch change while fresh methods use the new schema', () => {
    const schema = object({ choice: variant('kind', { a: branch(), b: branch() }) });
    const initial = { choice: { kind: 'a' as const, ...values } };
    const runtime = createDocument({ schema, initial });
    const expired: (() => unknown)[] = [];
    expect(
      runtime.update(d => {
        const { rows, items, outline } = d.choice;
        const getRow = rows.get,
          getItem = items.get,
          getNode = outline.get;
        const reads = [
          rows.ids,
          () => getRow('a'),
          items.ids,
          () => getItem('a'),
          outline.rootId,
          () => getNode('a'),
        ];
        const create = rows.create,
          insert = items.insert,
          replaceNode = outline.replace;
        const writes = [
          () => create('b', { n: 2 }),
          () => insert({ id: 'b' }),
          () => replaceNode('a', 2),
        ];
        expired.push(...reads, ...writes);
        replace(d, 'choice', { kind: 'b', ...values });
        for (const call of expired) expect(call).toThrow('replaced schema branch');
        d.choice.rows.create('b', { n: 2 });
        d.choice.items.insert({ id: 'b' });
        d.choice.outline.replace('a', 2);
      }).status
    ).toBe('committed');
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    expect(() =>
      runtime.update(d => {
        const create = d.choice.rows.create;
        d.choice.rows.get('a')!.n = 10;
        replace(d, 'choice', { kind: 'b', ...values });
        create('b', { n: 2 });
      })
    ).toThrow('replaced schema branch');
    expect(runtime.snapshot()).toEqual(initial);
  });

  it('keeps methods valid across same-schema replacements and reconstructs all collection baselines', () => {
    const schema = object({ entries: map(branch()) });
    const initial = { entries: { a: values } };
    const runtime = createDocument({ schema, initial });
    const update = () =>
      runtime.update(d => {
        const { rows, items, outline } = d.entries.get('a')!;
        const create = rows.create,
          insert = items.insert,
          replaceNode = outline.replace;
        create('b', { n: 2 });
        insert({ id: 'b' });
        replaceNode('a', 2);
        d.entries.put('a', values);
        create('c', { n: 3 });
        insert({ id: 'c' });
        replaceNode('a', 3);
      });
    expect(update().status).toBe('committed');
    expect(runtime.snapshot().entries.a!.rows.ids).toEqual(['a', 'c']);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    const error = new Error('abort after replacement');
    expect(() =>
      runtime.update(d => {
        d.entries.get('a')!.items.insert({ id: 'b' });
        d.entries.get('a')!.rows.create('b', { n: 2 });
        d.entries.get('a')!.outline.replace('a', 2);
        d.entries.put('a', values);
        throw error;
      })
    ).toThrow(error);
    expect(runtime.snapshot()).toEqual(initial);
  });
});
