import { describe, expect, it, vi } from 'vitest';
import { createDocument, field, map, object, table, type ChangeSet } from '../src';
import { type ImpactTarget } from '../src/schema';
import { startProfile } from '../src/profile';
import { createImpact, affectsTarget } from '../src/impact';
import { SubscriptionIndex } from '../src/impact-target';
import { subscribeDependencies } from '../src/integration';
import { MutationSession } from '../src/mutation/session';
import { jsonArray } from '../src/local-sync/json';

describe('grouped mutation architecture', () => {
  it('retains a stable collection impact result for an explicit root reset', () => {
    const schema = object({ values: map(field<number>()) });
    const runtime = createDocument({ schema, initial: { values: {} } });
    const result = runtime.replace({ values: { a: 1 } });
    if (result.status !== 'committed') throw new Error('commit');
    const impact = result.commit.impact.collection(p => p.values);
    expect(impact).toEqual({ kind: 'reset' });
    expect(result.commit.impact.collection(p => p.values)).toBe(impact);
  });
  it('keeps atomic collection updates in the same resolved generation and rejects foreign handles', () => {
    const schema = object({ values: map(field<number>()) });
    const runtime = createDocument({ schema, initial: { values: { a: 0 } }, history: false });
    runtime.update(d => {
      d.values.a = 0;
    });
    const profile = startProfile();
    runtime.update(d => {
      for (let i = 0; i < 100000; i++) d.values.a = i + 1;
    });
    const counters = profile.stop();
    expect(counters.access).toMatchObject({ addresses: 1, resolutions: 1 });
    expect(counters.recorder).toMatchObject({ facts: 1, groups: 1, transitions: 1 });
    const a = new MutationSession({ schema, document: { values: { a: 0 } } });
    const b = new MutationSession({ schema, document: { values: { a: 0 } } });
    expect(() => b.setMember(a.resolve(['values']), 'a', 1)).toThrow('another mutation session');
    expect(b.state.document).toEqual({ values: { a: 0 } });
  });
  it('publishes identical lexical member groups regardless of write order', () => {
    const schema = object({ z: field<number>(), a: field<number>(), m: field<number>() });
    const forward = createDocument({ schema, initial: { z: 0, a: 0, m: 0 } });
    const reverse = createDocument({ schema, initial: { z: 0, a: 0, m: 0 } });
    const a = forward.update(d => {
      d.a = 1;
      d.m = 2;
      d.z = 3;
    });
    const b = reverse.update(d => {
      d.z = 3;
      d.m = 2;
      d.a = 1;
    });
    if (a.status !== 'committed' || b.status !== 'committed') throw new Error('commit');
    expect(a.commit.changes).toEqual(b.commit.changes);
    expect(a.commit.changes.changes).toEqual([
      {
        kind: 'members',
        at: [],
        members: [
          { key: 'a', kind: 'updated', before: 0, after: 1 },
          { key: 'm', kind: 'updated', before: 0, after: 2 },
          { key: 'z', kind: 'updated', before: 0, after: 3 },
        ],
      },
    ]);
    const replay = createDocument({ schema, initial: { z: 0, a: 0, m: 0 } });
    expect(
      replay.apply(
        {
          changes: [
            {
              kind: 'members',
              at: [],
              members: [
                { key: 'z', kind: 'updated', before: 0, after: 3 },
                { key: 'a', kind: 'updated', before: 0, after: 1 },
                { key: 'm', kind: 'updated', before: 0, after: 2 },
              ],
            },
          ],
        },
        { expectedRevision: 0 }
      ).status
    ).toBe('committed');
    expect(replay.snapshot()).toEqual(forward.snapshot());
  });
  it.each([false, true])(
    'bounds repeated nested writes independently of write count (changed=%s)',
    changed => {
      const validate = vi.fn((n: unknown) => n as number);
      const runtime = createDocument({
        schema: object({ nested: object({ n: field(validate) }) }),
        initial: { nested: { n: 0 } },
        history: false,
      });
      runtime.update(d => {
        d.nested.n = 0;
      });
      validate.mockClear();
      const profile = startProfile();
      runtime.update(d => {
        const nested = d.nested;
        for (let i = 0; i < 100000; i++) nested.n = changed ? i + 1 : 0;
      });
      const counters = profile.stop();
      expect(counters.access.addresses).toBe(1);
      expect(counters.address.schemaSteps).toBe(0);
      expect(counters.recorder).toMatchObject({
        facts: changed ? 1 : 0,
        groups: changed ? 1 : 0,
        transitions: changed ? 1 : 0,
      });
      expect(validate).toHaveBeenCalledTimes(changed ? 100000 : 0);
      runtime.dispose();
    }
  );

  it.each([0, 1, 1000])(
    'publishes 10k two-field groups without a notification impact index (%i listeners)',
    listeners => {
      const count = 10000;
      const schema = object({ rows: map(object({ x: field<number>(), y: field<number>() })) });
      const runtime = createDocument({
        schema,
        initial: {
          rows: Object.fromEntries(
            Array.from({ length: count }, (_, i) => [String(i), { x: 0, y: 0 }])
          ),
        },
        history: false,
      });
      let notices = 0;
      for (let i = 0; i < listeners; i++)
        runtime.subscribe(
          p => p.rows.item(String(i)).x,
          () => notices++
        );
      const profile = startProfile();
      const result = runtime.update(d => {
        for (let i = 0; i < count; i++) {
          const row = d.rows[String(i)]!;
          row.x++;
          row.y++;
        }
      });
      const counters = profile.stop();
      expect(counters.recorder).toMatchObject({
        facts: 20000,
        groups: 10000,
        transitions: 20000,
        sealed: 10000,
      });
      expect(counters.impact).toEqual({ affectsChecks: 0, indexes: 0 });
      expect(counters.copy.structures).toBe(0);
      expect(notices).toBe(listeners);
      if (result.status !== 'committed') throw new Error('commit');
      const explicit = startProfile();
      expect(result.commit.impact.affects(p => p.rows.item('0').x)).toBe(true);
      expect(result.commit.impact.affects(p => p.rows.item('0').y)).toBe(true);
      expect(explicit.stop().impact.indexes).toBe(1);
      runtime.dispose();
    }
  );

  it('keeps root field changes incremental and preserves published structures across later edits', () => {
    const schema = object({
      a: field<number>(),
      b: field<number>(),
      rows: map(object({ n: field<number>() })),
    });
    const runtime = createDocument({ schema, initial: { a: 0, b: 0, rows: {} } });
    const listener = vi.fn();
    runtime.subscribe(p => p.b, listener);
    const result = runtime.update(d => {
      d.a++;
      d.rows.x = { n: 1 };
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.impact.kind).toBe('incremental');
    expect(listener).not.toHaveBeenCalled();
    const saved = structuredClone(result.commit.changes);
    runtime.update(d => {
      d.rows.x!.n++;
    });
    expect(result.commit.changes).toEqual(saved);
    runtime.history.undo();
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual({ a: 0, b: 0, rows: {} });
  });

  it('restores all initial members when a child group is absorbed and a later member fails', () => {
    const schema = object({
      rows: map(object({ x: field<number>(), y: field<number>() })),
      z: field((v: unknown) => {
        if (typeof v !== 'number') throw new Error('number');
        return v;
      }),
    });
    const initial = { rows: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, z: 0 };
    const runtime = createDocument({ schema, initial });
    expect(
      runtime.update(d => {
        d.rows.a!.x = 10;
        d.rows.a!.y = 20;
        d.rows.b!.x = 30;
        delete d.rows.a;
        d.rows.a = { x: 40, y: 50 };
        d.rows.a.x = 60;
        Reflect.set(d, 'z', 'bad');
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    const state = { schema, document: structuredClone(initial) };
    const session = new MutationSession(state);
    session.set(['rows', 'a', 'x'], 9);
    session.set([], { ...initial, z: 10 }, true, true);
    session.set(['rows', 'a', 'y'], 99);
    session.rollback();
    expect(state.document).toEqual(initial);
  });

  it.each([
    { changes: [{ kind: 'members', at: [], members: new Array(1) }] },
    { changes: [{ kind: 'members', at: [], members: [] }] },
    { changes: [{ kind: 'members', at: [], members: [{ key: 'a', kind: 'added' }] }] },
    {
      changes: [
        {
          kind: 'members',
          at: [],
          members: [
            { key: 'a', kind: 'updated', before: 0, after: 1 },
            { key: 'a', kind: 'removed', before: 0 },
          ],
        },
      ],
    },
    {
      changes: [
        { kind: 'reset', before: {}, after: {} },
        { kind: 'members', at: [], members: [{ key: 'a', kind: 'added', after: 1 }] },
      ],
    },
    {
      changes: [
        {
          kind: 'members',
          at: [],
          members: [{ key: 'rows', kind: 'updated', before: {}, after: {} }],
        },
        { kind: 'order', at: ['rows'], before: [], after: [] },
      ],
    },
    {
      changes: [
        { kind: 'members', at: [], members: [{ key: 'a', kind: 'added', after: 1, extra: 1 }] },
      ],
    },
  ])('rejects malformed grouped input without changing revision: %j', changes => {
    const runtime = createDocument({ schema: object({ a: field<number>() }), initial: { a: 0 } });
    expect(runtime.apply(changes, { expectedRevision: 0 }).status).toBe('rejected');
    expect(runtime.revision()).toBe(0);
    expect(runtime.snapshot()).toEqual({ a: 0 });
  });

  it('counts members and tree nodes in JSON limits and rejects old envelopes', () => {
    const members = [
      {
        kind: 'members',
        at: [],
        members: [
          { key: 'a', kind: 'updated', before: 0, after: 1 },
          { key: 'b', kind: 'added', after: 2 },
        ],
      },
    ];
    expect(() => jsonArray(members, 'changes', { maxChanges: 1 })).toThrow('count');
    expect(jsonArray(members, 'changes', { maxChanges: 2 })).toBe(members);
    expect(() =>
      jsonArray(
        [
          {
            kind: 'tree',
            at: ['outline'],
            before: null,
            after: 'r',
            nodes: [{ id: 'r', kind: 'added', after: { children: [] } }],
          },
        ],
        'changes',
        { maxChanges: 1 }
      )
    ).toThrow('count');
    expect(() =>
      jsonArray(
        [
          {
            kind: 'value',
            at: ['a'],
            before: { present: false },
            after: { present: true, value: 1 },
          },
        ],
        'changes'
      )
    ).toThrow('invalid ChangeSet');
  });
});

describe('exact subscription matching', () => {
  it('matches both query directions against an independent path relation oracle', () => {
    const schema = object({ rows: table(object({ x: field<number>(), y: field<number>() })) });
    const otherSchema = object({ rows: table(object({ x: field<number>(), y: field<number>() })) });
    const paths = [
      [],
      ['rows'],
      ['rows', 'a'],
      ['rows', 'b'],
      ['rows', 'a', 'x'],
      ['rows', 'a', 'y'],
      ['other'],
    ];
    const targets: ImpactTarget[] = paths.flatMap(at => [
      { kind: 'value' as const, at },
      { kind: 'collection' as const, at },
      { kind: 'collection' as const, at, id: 'x' },
    ]);
    targets.push({ kind: 'value', schema: otherSchema, address: [] });
    const index = new SubscriptionIndex<number>(schema);
    targets.forEach((target, i) => index.add(target, i));
    const prefix = (a: readonly string[], b: readonly string[]) =>
      a.length <= b.length && a.every((v, i) => v === b[i]);
    let seed = 71;
    for (let trial = 0; trial < 300; trial++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const at = paths[seed % paths.length];
      const kind = trial % 4;
      const changes: ChangeSet = {
        changes:
          kind === 0
            ? [
                {
                  kind: 'members',
                  at,
                  members: [
                    { key: 'x', kind: 'updated', before: 0, after: 1 },
                    { key: 'y', kind: 'added', after: 2 },
                  ],
                },
              ]
            : kind === 1
              ? [{ kind: 'order', at, before: ['a', 'b'], after: ['b', 'a'] }]
              : kind === 2
                ? [{ kind: 'tree', at, before: null, after: 'r', nodes: [] }]
                : [{ kind: 'reset', before: {}, after: {} }],
      };
      const expected = new Set<number>();
      targets.forEach((target, i) => {
        if ('schema' in target) return;
        const membership = 'id' in target;
        const t = membership ? target.at.concat(target.id!) : target.at;
        const logical = kind === 0 ? [at.concat('x'), at.concat('y')] : [at];
        if (
          kind === 3 ||
          logical.some(c =>
            kind === 1 ? !membership && prefix(t, c) : prefix(c, t) || (!membership && prefix(t, c))
          )
        )
          expected.add(i);
      });
      const actual = new Set<number>();
      index.collect(changes, i => actual.add(i));
      expect(actual).toEqual(expected);
      const impact = createImpact(schema, changes);
      targets.forEach((target, i) => expect(affectsTarget(impact, target)).toBe(expected.has(i)));
    }
  });

  it('deduplicates targets and preserves subscription removal and addition during notification', () => {
    const schema = object({ a: field<number>(), b: field<number>() });
    const runtime = createDocument({ schema, initial: { a: 0, b: 0 } });
    const events: string[] = [];
    let stop = () => {};
    runtime.subscribe([p => p.a, p => p.b], () => {
      events.push('first');
      stop();
      runtime.subscribe(
        p => p.a,
        () => events.push('new-filtered')
      );
      runtime.subscribe(() => events.push('new-root'));
    });
    stop = runtime.subscribe(
      p => p.a,
      () => events.push('removed')
    );
    subscribeDependencies(
      runtime,
      [{ kind: 'value', schema: object({ a: field<number>() }), address: [] }],
      () => events.push('wrong-schema')
    );
    runtime.update(d => {
      d.a++;
      d.b++;
    });
    expect(events).toEqual(['first', 'new-root']);
    events.length = 0;
    runtime.update(d => {
      d.a++;
    });
    expect(events).toEqual(['first', 'new-filtered', 'new-root', 'new-root']);
  });
});
