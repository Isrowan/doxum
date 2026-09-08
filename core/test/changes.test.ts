import { describe, expect, it, vi } from 'vitest';
import { createDocument, field, object, map, table, tree, list, type ChangeSet } from '../src';
const model = object({ n: field<number>(), rows: map(object({ n: field<number>() })) });
const setup = () => createDocument({ schema: model, initial: { n: 0, rows: { a: { n: 1 } } } });
const set = (at: readonly string[], before: unknown, after: unknown) => ({
  kind: 'value' as const,
  at,
  before: { present: true as const, value: before },
  after: { present: true as const, value: after },
});

describe('ChangeSet boundary', () => {
  it('rejects sparse address and order arrays before schema validation or mutation', () => {
    const validator = vi.fn((value: unknown) => value as number);
    const schema = object({
      undefined: field(validator),
      rows: table(object({ n: field<number>() })),
    });
    const runtime = createDocument({
      schema,
      initial: { undefined: 0, rows: { ids: [], byId: {} } },
    });
    validator.mockClear();
    for (const changes of [
      { changes: [set(new Array(1), 0, 1)] },
      { changes: [{ kind: 'order', at: ['rows'], before: [], after: new Array(1) }] },
    ]) {
      const result = runtime.apply(changes, { expectedRevision: 0 });
      expect(result).toMatchObject({ status: 'rejected', issues: [{ code: 'invalid-changes' }] });
      expect(runtime.revision()).toBe(0);
      expect(runtime.snapshot().undefined).toBe(0);
    }
    expect(validator).not.toHaveBeenCalled();
  });
  it('rejects a list value whose key disagrees with its address and restores preceding work', () => {
    const schema = object({
      a: field<number>(),
      rows: list(field<{ id: string }>(), { keyOf: v => v.id }),
    });
    const initial = { a: 0, rows: [{ id: 'a' }] },
      runtime = createDocument({ schema, initial });
    const listener = vi.fn();
    runtime.subscribe(listener);
    expect(
      runtime.apply(
        { changes: [set(['a'], 0, 1), set(['rows', 'a'], { id: 'a' }, { id: 'b' })] },
        { expectedRevision: 0 }
      ).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current().undoDepth).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
  it('replays normalized final changes and owns its actual rollback state', () => {
    const a = setup(),
      b = setup();
    const result = a.update(d => {
      d.n = 1;
      d.n = 2;
      d.rows.b = { n: 3 };
      d.rows.b.n++;
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(b.apply(result.commit.changes, { expectedRevision: 0 }).status).toBe('committed');
    expect(b.snapshot()).toEqual(a.snapshot());
    b.history.undo();
    expect(b.snapshot()).toEqual(setup().snapshot());
    expect(Object.isFrozen(result.commit.changes.changes[1])).toBe(true);
  });
  it('requires a revision baseline and records actual old state instead of trusting incoming before', () => {
    const runtime = setup();
    runtime.update(d => d.n++);
    const changes = { changes: [set(['n'], 1, 2)] };
    expect(runtime.apply(changes, { expectedRevision: 0 }).status).toBe('rejected');
    // @ts-expect-error An explicit expected revision is required.
    expect(runtime.apply(changes).status).toBe('rejected');
    const result = runtime.apply({ changes: [set(['n'], 99, 2)] }, { expectedRevision: 1 });
    expect(result.status).toBe('committed');
    if (result.status === 'committed')
      expect(result.commit.changes.changes[0]).toMatchObject({ before: { value: 1 } });
    runtime.history.undo();
    expect(runtime.snapshot().n).toBe(1);
  });
  it.each([
    null,
    [],
    {},
    { changes: 'bad' },
    { changes: [{ kind: 'other', at: [] }] },
    {
      changes: [{ kind: 'value', at: [1], before: { present: false }, after: { present: false } }],
    },
    {
      changes: [{ kind: 'value', at: ['n'], before: { present: true }, after: { present: false } }],
    },
    { changes: [set(['n'], 0, 1), set(['n'], 0, 2)] },
    { changes: [set(['rows'], { a: { n: 1 } }, {}), set(['rows', 'a', 'n'], 1, 2)] },
    { changes: [{ kind: 'order', at: ['rows'], before: [], after: ['a', 'a'] }] },
    {
      changes: [
        {
          kind: 'tree',
          at: ['rows'],
          before: { present: false },
          after: { present: false },
          nodes: [
            { id: 'a', before: { present: false }, after: { present: false } },
            { id: 'a', before: { present: false }, after: { present: false } },
          ],
        },
      ],
    },
  ])('rejects malformed, duplicate and overlapping facts: %j', changes => {
    const runtime = setup(),
      listener = vi.fn();
    runtime.subscribe(listener);
    expect(runtime.apply(changes, { expectedRevision: 0 }).status).toBe('rejected');
    expect(runtime.snapshot()).toEqual(setup().snapshot());
    expect(runtime.revision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
  it('rolls back partial application when later schema validation fails', () => {
    const number = (v: unknown): number => {
      if (typeof v !== 'number') throw new Error('number');
      return v;
    };
    const schema = object({ a: field(number), z: field(number) });
    const runtime = createDocument({ schema, initial: { a: 0, z: 0 } });
    expect(
      runtime.apply({ changes: [set(['a'], 0, 3), set(['z'], 0, 'bad')] }, { expectedRevision: 0 })
        .status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual({ a: 0, z: 0 });
    expect(runtime.history.current().undoDepth).toBe(0);
  });
  it('installs entries before final order and rejects inconsistent order atomically', () => {
    const schema = object({ rows: table(object({ n: field<number>() })) });
    const initial = { rows: { ids: ['a'], byId: { a: { n: 1 } } } };
    const runtime = createDocument({ schema, initial });
    const changes: ChangeSet = {
      changes: [
        { kind: 'order', at: ['rows'], before: ['a'], after: ['b', 'a'] },
        {
          kind: 'value',
          at: ['rows', 'b'],
          before: { present: false },
          after: { present: true, value: { n: 2 } },
        },
      ],
    };
    expect(runtime.apply(changes, { expectedRevision: 0 }).status).toBe('committed');
    expect(runtime.snapshot().rows.ids).toEqual(['b', 'a']);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial);
    expect(
      runtime.apply(
        { changes: [{ ...changes.changes[0], before: ['a'], after: ['missing'] }] },
        { expectedRevision: runtime.revision() }
      ).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
  });
  it('rejects topology that is orphaned, cyclic, disconnected or missing its root', () => {
    const schema = object({ outline: tree(field<number>()) });
    for (const value of [
      { nodes: { a: { children: [], value: 1 } } },
      { rootId: 'a', nodes: { a: { children: ['b'], value: 1 } } },
      { rootId: 'a', nodes: { a: { children: [], value: 1 }, b: { children: [], value: 2 } } },
      {
        rootId: 'a',
        nodes: { a: { children: ['b'], parentId: 'b' }, b: { children: ['a'], parentId: 'a' } },
      },
    ]) {
      const runtime = createDocument({ schema, initial: { outline: { nodes: {} } } });
      expect(
        runtime.apply(
          { changes: [set(['outline'], { nodes: {} }, value)] },
          { expectedRevision: 0 }
        ).status
      ).toBe('rejected');
      expect(runtime.snapshot()).toEqual({ outline: { nodes: {} } });
    }
  });
  it('rejects malformed incremental tree node payloads and restores earlier changes', () => {
    const schema = object({ a: field<number>(), outline: tree(field<number>()) });
    const initial = { a: 0, outline: { nodes: {} } },
      runtime = createDocument({ schema, initial });
    expect(
      runtime.apply(
        {
          changes: [
            set(['a'], 0, 1),
            {
              kind: 'tree',
              at: ['outline'],
              before: { present: false },
              after: { present: true, value: 'x' },
              nodes: [
                {
                  id: 'x',
                  before: { present: false },
                  after: { present: true, value: { children: 'not an array' } },
                },
              ],
            },
          ],
        },
        { expectedRevision: 0 }
      ).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
  });
  it('replays list entry values and order in both directions', () => {
    const schema = object({ rows: list(field<{ id: string; n: number }>(), { keyOf: v => v.id }) });
    const initial = {
      rows: [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ],
    };
    const a = createDocument({ schema, initial }),
      b = createDocument({ schema, initial });
    const result = a.update(d => {
      d.rows.remove('a');
      d.rows.insert({ id: 'c', n: 3 }, { at: 'start' });
      d.rows.set('b', { id: 'b', n: 4 });
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(b.apply(result.commit.changes, { expectedRevision: 0 }).status).toBe('committed');
    expect(b.snapshot()).toEqual(a.snapshot());
    b.history.undo();
    expect(b.snapshot()).toEqual(initial);
    b.history.redo();
    expect(b.snapshot()).toEqual(a.snapshot());
  });
});
