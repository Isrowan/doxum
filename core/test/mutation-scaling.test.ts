import { describe, expect, it } from 'vitest';
import { createDocument, field, list, map, object, optional, replace, table, variant } from 'doxum';
import { startProfile } from '@/profile';
import { decodeChanges } from '@/mutation/changes';
import { jsonChanges } from '@/local-sync/json';

describe('mutation scaling and ownership', () => {
  it('validates only the changed table value during apply and history', () => {
    let validations = 0;
    const schema = object({
      rows: table(
        object({
          n: field((value: unknown) => {
            validations++;
            if (typeof value !== 'number') throw new Error('number');
          }),
        })
      ),
    });
    const ids = Array.from({ length: 100000 }, (_, i) => String(i));
    const runtime = createDocument({
      schema,
      initial: { rows: { ids, byId: Object.fromEntries(ids.map(id => [id, { n: 0 }])) } },
    });
    validations = 0;
    const profile = startProfile();
    const result = runtime.apply(
      {
        changes: [
          {
            kind: 'members',
            at: ['rows'],
            members: [{ key: '0', kind: 'added', after: { n: 1 } }],
          },
        ],
      },
      { expectedRevision: 0 }
    );
    expect(result.status).toBe('committed');
    expect(validations).toBe(1);
    expect(profile.stop().recorder.orderItems).toBe(0);
    validations = 0;
    expect(runtime.history.undo().status).toBe('committed');
    expect(validations).toBe(1);
    expect(runtime.snapshot().rows.byId['0']).toEqual({ n: 0 });
    validations = 0;
    expect(
      runtime.apply(
        {
          changes: [
            {
              kind: 'members',
              at: ['rows'],
              members: [],
              order: { before: ids, after: [...ids].reverse() },
            },
          ],
        },
        { expectedRevision: runtime.revision() }
      ).status
    ).toBe('committed');
    expect(validations).toBe(0);
    runtime.dispose();
  });

  it('checks actual membership and rolls back partial value and structural work', () => {
    const schema = object({ rows: table(object({ n: field<number>() })) });
    const initial = { rows: { ids: ['a'], byId: { a: { n: 1 } } } };
    const runtime = createDocument({ schema, initial });
    const result = runtime.apply(
      {
        changes: [
          {
            kind: 'members',
            at: ['rows'],
            members: [
              { key: 'a', kind: 'updated', before: 999, after: { n: 2 } },
              { key: 'b', kind: 'updated', before: 999, after: { n: 3 } },
            ],
          },
        ],
      },
      { expectedRevision: 0 }
    );
    expect(result.status).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.revision()).toBe(0);
    const applied = runtime.apply(
      {
        changes: [
          {
            kind: 'members',
            at: ['rows'],
            members: [{ key: 'b', kind: 'updated', before: 999, after: { n: 3 } }],
            order: { before: [], after: ['b', 'a'] },
          },
        ],
      },
      { expectedRevision: 0 }
    );
    expect(applied.status).toBe('committed');
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    runtime.dispose();
  });

  it('indexes list keys once for reads, repeated writes and sealing', () => {
    const count = 2000;
    let keys = 0;
    const schema = object({
      rows: list(field<{ id: string; n: number }>(), {
        keyOf: value => {
          keys++;
          return value.id;
        },
      }),
    });
    const initial = { rows: Array.from({ length: count }, (_, i) => ({ id: String(i), n: 0 })) };
    const runtime = createDocument({ schema, initial });
    keys = 0;
    const profile = startProfile();
    expect(
      runtime.update(d => {
        for (let i = 0; i < count; i++) {
          const id = String(i);
          d.rows.replace(id, { id, n: d.rows.get(id)!.n + 1 });
        }
      }).status
    ).toBe('committed');
    expect(keys).toBeLessThanOrEqual(count * 2);
    expect(profile.stop().address).toMatchObject({ listIndexes: 1, listItems: count });
    keys = 0;
    expect(runtime.history.undo().status).toBe('committed');
    expect(keys).toBeLessThanOrEqual(count);
    expect(runtime.snapshot()).toEqual(initial);
    runtime.dispose();
  });

  it('invalidates list positions after moves, insertion, removal and rollback', () => {
    const schema = object({
      rows: list(field<{ id: string; n: number }>(), { keyOf: value => value.id }),
      valid: field((v: unknown) => {
        if (typeof v !== 'number') throw new Error('number');
      }),
    });
    const initial = {
      rows: [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
        { id: 'c', n: 3 },
      ],
      valid: 0,
    };
    const runtime = createDocument({ schema, initial });
    const mutate = (d: Parameters<Parameters<typeof runtime.update>[0]>[0]) => {
      expect(d.rows.get('b')!.n).toBe(2);
      d.rows.move('c', { at: 'start' });
      d.rows.replace('b', { id: 'b', n: 20 });
      d.rows.remove('a');
      d.rows.insert({ id: 'd', n: 4 }, { before: 'b' });
      expect(d.rows.get('b')!.n).toBe(20);
      expect(d.rows.ids()).toEqual(['c', 'd', 'b']);
    };
    expect(
      runtime.update(d => {
        mutate(d);
        Reflect.set(d, 'valid', 'bad');
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.update(mutate).status).toBe('committed');
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    runtime.dispose();
  });

  it('does not build a disposable list index for a standalone order edit', () => {
    const schema = object({ rows: list(field<string>(), { keyOf: v => v }) });
    const runtime = createDocument({ schema, initial: { rows: ['a', 'b', 'c'] } });
    const profile = startProfile();
    expect(runtime.update(d => d.rows.move('a')).status).toBe('committed');
    expect(profile.stop().address.listIndexes).toBe(0);
    expect(runtime.snapshot().rows).toEqual(['b', 'c', 'a']);
    runtime.dispose();
  });

  it('bulk-moves a large list with one bounded key scan and one order capture', () => {
    const count = 10_000;
    const movedCount = 1_000;
    let keyCalls = 0;
    const key = (id: string | number) => `node\0${id}`;
    const schema = object({
      rows: list(field<{ kind: string; id: string }>(), {
        keyOf: value => {
          keyCalls++;
          return key(value.id);
        },
      }),
    });
    const values = Array.from({ length: count }, (_, index) => ({
      kind: 'node',
      id: String(index),
    }));
    const runtime = createDocument({ schema, initial: { rows: values } });
    const moved = Array.from({ length: movedCount }, (_, index) => key(movedCount - index - 1));
    keyCalls = 0;
    const profile = startProfile();
    const result = runtime.update(d => d.rows.move(moved, { before: key(9000) }));
    const measured = profile.stop();
    expect(result.status).toBe('committed');
    expect(keyCalls).toBe(count);
    expect(measured.address).toMatchObject({ listIndexes: 0, listItems: 0 });
    expect(measured.recorder).toMatchObject({
      orderCaptures: 1,
      orderSnapshots: 1,
      orderItems: count,
      publishedOrderItems: count,
    });
    if (result.status !== 'committed') throw new Error('move');
    const order = result.commit.changes.changes[0];
    expect(order).toMatchObject({ kind: 'members', at: ['rows'], members: [] });
    if (order.kind !== 'members' || !order.order) throw new Error('order');
    expect(order.order.after.slice(7_998, 8_005)).toEqual([
      key(8998),
      key(8999),
      key(0),
      key(1),
      key(2),
      key(3),
      key(4),
    ]);
    expect(order.order.after.at(-1)).toBe(key(9999));
    runtime.dispose();
  });

  it('reorders a large list without repeated keyOf scans', () => {
    const count = 10_000;
    let keyCalls = 0;
    const schema = object({
      rows: list(field<{ id: string }>(), {
        keyOf: value => {
          keyCalls++;
          return value.id;
        },
      }),
    });
    const ids = Array.from({ length: count }, (_, index) => String(index));
    const runtime = createDocument({
      schema,
      initial: { rows: ids.map(id => ({ id })) },
    });
    keyCalls = 0;
    const profile = startProfile();
    const result = runtime.update(d => d.rows.reorder([...ids].reverse()));
    const measured = profile.stop();
    expect(result.status).toBe('committed');
    expect(keyCalls).toBe(count);
    expect(measured.address.listIndexes).toBe(0);
    expect(measured.recorder).toMatchObject({ orderCaptures: 1, orderSnapshots: 1 });
    runtime.dispose();
  });

  it.each([false, true])(
    'keeps unrelated order changes out of the scalar coverage index (first=%s)',
    first => {
      const count = 1000;
      const schema = object({
        rows: map(object({ x: field<number>(), y: field<number>() })),
        order: list(field<string>(), { keyOf: v => v }),
      });
      const runtime = createDocument({
        schema,
        initial: {
          rows: Object.fromEntries(
            Array.from({ length: count }, (_, i) => [String(i), { x: 0, y: 0 }])
          ),
          order: ['a', 'b'],
        },
      });
      const profile = startProfile();
      expect(
        runtime.update(d => {
          if (first) d.order.move('a');
          for (let i = 0; i < count; i++) {
            d.rows.get(String(i))!.x++;
            d.rows.get(String(i))!.y++;
          }
          if (!first) d.order.move('a');
        }).status
      ).toBe('committed');
      expect(profile.stop().recorder).toMatchObject({
        groups: count + 1,
        indexedGroups: 0,
        transitions: count * 2,
      });
      expect(runtime.history.undo().status).toBe('committed');
      expect(runtime.snapshot().rows['0']).toEqual({ x: 0, y: 0 });
      runtime.dispose();
    }
  );

  it('indexes owning groups for absorption and preserves uncovered members', () => {
    const row = object({ a: optional(map(field<number>())), z: field<number>() });
    const schema = object({ rows: map(row) });
    const initial = {
      rows: { one: { a: { x: 1, y: 2 }, z: 3 }, two: { a: { x: 4, y: 5 }, z: 6 } },
    };
    const runtime = createDocument({ schema, initial });
    const profile = startProfile();
    expect(
      runtime.update(d => {
        const one = d.rows.get('one')!;
        one.a!.put('x', 10);
        one.a!.put('y', 20);
        one.z = 30;
        d.rows.get('two')!.z = 60;
        replace(one, 'a', { x: 100, y: 200 });
        one.a!.put('x', 101);
      }).status
    ).toBe('committed');
    expect(profile.stop().recorder.indexedGroups).toBe(3);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    runtime.dispose();
  });

  it('keeps retained accesses correct across different fixed schema slot layouts', () => {
    const schema = object({
      choice: variant('kind', {
        a: object({ nested: object({ z: object({ n: field<number>() }) }) }),
        b: object({
          nested: object({ a: object({ n: field<number>() }), z: object({ n: field<number>() }) }),
        }),
      }),
    });
    const runtime = createDocument({
      schema,
      initial: { choice: { kind: 'a', nested: { z: { n: 1 } } } },
    });
    expect(
      runtime.update(d => {
        const retained = d.choice.nested.z;
        d.choice = { kind: 'b', nested: { a: { n: 2 }, z: { n: 3 } } };
        expect(d.choice.nested.a.n).toBe(2);
        expect(retained.n).toBe(3);
        retained.n = 4;
        expect(d.choice.nested.z.n).toBe(4);
      }).status
    ).toBe('committed');
    runtime.dispose();
  });

  it('retains the validated ChangeSet through JSON and apply without trusting raw envelopes', () => {
    const runtime = createDocument({ schema: object({ n: field<number>() }), initial: { n: 0 } });
    const result = runtime.update(d => {
      d.n = 1;
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(decodeChanges(result.commit.changes)).toBe(result.commit.changes);
    expect(jsonChanges(result.commit.changes, 'commit', {})).toBe(result.commit.changes);
    const stored = jsonChanges(JSON.parse(JSON.stringify(result.commit.changes)), 'stored');
    expect(decodeChanges(stored)).toBe(stored);
    const raw = {
      changes: [
        { kind: 'members', at: [], members: [{ key: 'n', kind: 'updated', before: 0, after: 1 }] },
      ],
    };
    decodeChanges(raw);
    raw.changes[0].kind = 'invalid';
    expect(() => decodeChanges(raw)).toThrow('change');
    runtime.dispose();
  });
});
