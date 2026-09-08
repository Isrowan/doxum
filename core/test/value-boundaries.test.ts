import { describe, expect, it, vi } from 'vitest';
import {
  assign,
  createDocument,
  createProjectionRuntime,
  field,
  list,
  map,
  object,
  optional,
  parse,
  ParseError,
  select,
  snapshot,
  table,
  tree,
  variant,
  type Validator,
} from '../src';
import { track, subscribeDependencies } from '../src/integration';
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Expected finite number');
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected text');
  return value;
};

describe('schema validation and snapshots', () => {
  it('snapshots retained descendants through missing and restored parents within their scope', () => {
    const schema = object({ entries: map(object({ nested: object({ n: field<number>() }) })) });
    const runtime = createDocument({ schema, initial: { entries: { a: { nested: { n: 1 } } } } });
    let escapedSnapshot!: () => unknown;
    runtime.update(d => {
      const nested = d.entries.a!.nested;
      escapedSnapshot = () => snapshot(nested);
      expect(snapshot(nested)).toEqual({ n: 1 });
      delete d.entries.a;
      expect(snapshot(nested)).toBeUndefined();
      d.entries.a = { nested: { n: 2 } };
      expect(snapshot(nested)).toEqual({ n: 2 });
    });
    expect(escapedSnapshot).toThrow('expired');
  });
  it('rejects undeclared object properties at construction, parse and root replacement', () => {
    const schema = object({ n: field(number) });
    const invalid = { n: 1, extra: 2 };
    expect(() => createDocument({ schema, initial: invalid })).toThrow('not declared');
    expect(() => parse(schema, invalid)).toThrow('not declared');
    const runtime = createDocument({ schema, initial: { n: 0 } });
    expect(runtime.replace(invalid).status).toBe('rejected');
    expect(runtime.snapshot()).toEqual({ n: 0 });
    expect(runtime.revision()).toBe(0);
  });

  it('rejects undeclared symbols and non-enumerable properties on structural objects', () => {
    const schema = object({ n: field(number) });
    const symbol = { n: 1, [Symbol('extra')]: 2 };
    const hidden = Object.defineProperty({ n: 1 }, 'extra', { value: 2 });
    expect(() => parse(schema, symbol)).toThrow('not declared');
    expect(() => parse(schema, hidden)).toThrow('not declared');
  });

  it('rolls back earlier edits when a replacement contains undeclared structural members', () => {
    const schema = object({ n: field(number), rows: map(object({ value: field(number) })) });
    const initial = { n: 0, rows: { a: { value: 1 } } };
    const runtime = createDocument({ schema, initial });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const invalid = { value: 2, extra: 3 };
    expect(
      runtime.update(d => {
        d.n = 1;
        assign(d.rows, 'a', invalid);
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(
      runtime.apply(
        {
          changes: [
            {
              kind: 'members',
              at: [],
              members: [{ key: 'n', kind: 'updated', before: 0, after: 1 }],
            },
            {
              kind: 'members',
              at: ['rows'],
              members: [{ key: 'a', kind: 'updated', before: {}, after: invalid }],
            },
          ],
        },
        { expectedRevision: 0 }
      ).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.revision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('allows only the active variant branch and preserves precise replacement history', () => {
    const schema = object({
      choice: variant('kind', {
        a: object({ n: field(number), stable: field(text) }),
        b: object({ text: field(text) }),
      }),
    });
    const initial = { choice: { kind: 'a' as const, n: 1, stable: 'same' } };
    expect(parse(schema, initial)).toEqual(initial);
    expect(() => parse(schema, { choice: { ...initial.choice, text: 'wrong branch' } })).toThrow(
      'not declared'
    );
    const runtime = createDocument({ schema, initial });
    const listener = vi.fn();
    runtime.subscribe(p => p.choice.stable, listener);
    expect(
      runtime.update(d => {
        d.choice = { kind: 'a', n: 2, stable: 'same' };
      }).status
    ).toBe('committed');
    expect(listener).not.toHaveBeenCalled();
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.history.redo().status).toBe('committed');
    expect(listener).not.toHaveBeenCalled();
    expect(
      runtime.update(d => {
        d.choice = { kind: 'b', text: 'next' };
      }).status
    ).toBe('committed');
    expect(runtime.snapshot().choice).toEqual({ kind: 'b', text: 'next' });
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().choice).toEqual({ kind: 'a', n: 2, stable: 'same' });
  });

  it('keeps arbitrary payload properties inside fields and dynamic members inside maps', () => {
    const payload = Object.defineProperty({ [Symbol('payload')]: 1 }, 'hidden', { value: 2 });
    const schema = object({
      payload: field(),
      values: map(field(number)),
      missing: optional(field(number)),
    });
    const runtime = createDocument({ schema, initial: { payload, values: { arbitrary: 1 } } });
    expect(runtime.snapshot().payload).toBe(payload);
    expect(
      runtime.update(d => {
        d.values.another = 2;
        d.missing = undefined;
      }).status
    ).toBe('committed');
    expect(Object.hasOwn(runtime.snapshot(), 'missing')).toBe(true);
    expect(runtime.history.undo().status).toBe('committed');
    expect(Object.hasOwn(runtime.snapshot(), 'missing')).toBe(false);
    expect(runtime.snapshot().payload).toBe(payload);
  });

  it('seals primitive fields with exact presence and Object.is semantics', () => {
    const token = Symbol('value');
    const schema = object({ values: map(field<unknown>()) });
    const initial = {
      values: { zero: 0, nan: NaN, text: 'old', flag: false, big: 1n, empty: 1, symbol: null },
    };
    const runtime = createDocument({ schema, initial });
    const unchanged = vi.fn();
    runtime.subscribe(p => p.values.item('nan'), unchanged);
    const result = runtime.update(d => {
      d.values.zero = -0;
      d.values.nan = 1;
      d.values.nan = NaN;
      d.values.text = 'new';
      d.values.flag = true;
      d.values.big = 2n;
      d.values.empty = null;
      d.values.symbol = token;
      d.values.missing = undefined;
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected commit');
    expect(result.commit.changes.changes).toHaveLength(1);
    const group = result.commit.changes.changes[0];
    if (group.kind !== 'members') throw new Error('Expected member group');
    expect(group.members).toHaveLength(7);
    expect(group.members.find(c => c.key === 'missing')).toEqual({
      key: 'missing',
      kind: 'added',
      after: undefined,
    });
    expect(unchanged).not.toHaveBeenCalled();
    expect(Object.is(runtime.snapshot().values.zero, -0)).toBe(true);
    expect(runtime.snapshot().values.symbol).toBe(token);
    expect(result.commit.changes.changes[0].kind).toBe('members');
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    expect(Object.hasOwn(runtime.snapshot().values, 'missing')).toBe(false);
    expect(runtime.history.redo().status).toBe('committed');
    expect(Object.hasOwn(runtime.snapshot().values, 'missing')).toBe(true);
  });
  it('shares object and function payloads across commits, snapshots and history', () => {
    const before = { n: 0 },
      after = { n: 1 },
      fn = () => 1;
    const runtime = createDocument({
      schema: object({ payload: field<unknown>() }),
      initial: { payload: before },
    });
    const old = runtime.snapshot();
    const result = runtime.update(d => {
      d.payload = after;
    });
    if (result.status !== 'committed') throw new Error('Expected commit');
    const change = result.commit.changes.changes[0];
    if (change.kind !== 'members') throw new Error('Expected members');
    const member = change.members[0];
    if (member.kind !== 'updated') throw new Error('Expected updated member');
    expect(member.before).toBe(before);
    expect(member.after).toBe(after);
    expect(runtime.snapshot().payload).toBe(after);
    expect(snapshot(after)).toBe(after);
    expect(old.payload).toBe(before);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().payload).toBe(before);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot().payload).toBe(after);
    runtime.update(d => {
      d.payload = fn;
    });
    expect(runtime.snapshot().payload).toBe(fn);
    expect(snapshot(fn)).toBe(fn);
    runtime.history.undo();
    expect(runtime.snapshot().payload).toBe(after);
  });
  it('rejects a retained descendant write while its containing entry is absent and restores prior edits', () => {
    const schema = object({ rows: map(object({ position: object({ x: field<number>() }) })) });
    const initial = { rows: { a: { position: { x: 1 } } } };
    const runtime = createDocument({ schema, initial });
    expect(
      runtime.update(d => {
        const position = d.rows.a!.position;
        position.x = 2;
        delete d.rows.a;
        expect(position.x).toBeUndefined();
        position.x = 3;
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.revision()).toBe(0);
  });
  it('uses the current schema for retained descendants when variants reuse a member name', () => {
    const schema = object({
      choice: variant('kind', {
        n: object({ payload: object({ value: field(number) }) }),
        s: object({ payload: object({ value: field(text) }) }),
      }),
    });
    const initial = { choice: { kind: 'n' as const, payload: { value: 1 } } };
    const runtime = createDocument({ schema, initial });
    expect(
      runtime.update(d => {
        const payload = d.choice.payload;
        Reflect.set(payload, 'value', 2);
        d.choice = { kind: 's', payload: { value: 'A' } };
        expect(Reflect.get(payload, 'value')).toBe('A');
        Reflect.set(payload, 'value', 3);
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(
      runtime.update(d => {
        const payload = d.choice.payload;
        d.choice = { kind: 's', payload: { value: 'A' } };
        Reflect.set(payload, 'value', 'B');
        expect(d.choice.payload).toBe(payload);
      }).status
    ).toBe('committed');
    expect(runtime.snapshot().choice).toEqual({ kind: 's', payload: { value: 'B' } });
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
  });
  it('keeps access metadata out of business fields, enumeration and snapshots', () => {
    const names = [
      'at',
      'parent',
      'key',
      'node',
      'value',
      'generation',
      'children',
      'proxy',
      'container',
      'owner',
      'identity',
      '__proto__',
    ];
    const schema = object(
      Object.fromEntries(names.map(name => [name, object({ n: field<number>() })]))
    );
    const initial = Object.fromEntries(names.map(name => [name, { n: 0 }]));
    const runtime = createDocument({ schema, initial });
    expect(
      runtime.update(d => {
        expect(Object.keys(d)).toEqual(names);
        for (const name of names) d[name].n++;
        expect(Object.keys(snapshot(d))).toEqual(names);
      }).status
    ).toBe('committed');
    expect(runtime.snapshot()).toEqual(Object.fromEntries(names.map(name => [name, { n: 1 }])));
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
  });
  it('parses every container through value schemas', () => {
    const row = field((input: unknown): { id: string; n: number } => {
      const v = input as { id: string; n: number };
      text(v.id);
      number(v.n);
      return v;
    });
    const schema = object({
      title: field(text),
      optional: optional(field(text)),
      values: map(field(number)),
      people: table(object({ name: field(text) })),
      rows: list(row, { keyOf: r => r.id }),
      outline: tree(field(text)),
      choice: variant('kind', { n: object({ n: field(number) }) }),
    });
    const input = {
      title: 'T',
      values: { a: 1 },
      people: { ids: ['a'], byId: { a: { name: 'A' } } },
      rows: [{ id: 'a', n: 1 }],
      outline: { nodes: {} },
      choice: { kind: 'n' as const, n: 1 },
    };
    const parsed = parse(schema, input);
    expect(parsed).toEqual(input);
    expect(parsed.rows).not.toBe(input.rows);
    expect(parsed.rows[0]).toBe(input.rows[0]);
    expect(() => parse(schema, { ...input, rows: [input.rows[0], input.rows[0]] })).toThrow(
      'unique'
    );
    expect(() => parse(field<string>(), 'unchecked')).toThrow('validator is required');
    expect(parse(optional(field(text)), undefined)).toBeUndefined();
  });
  it('accepts Standard Schema, preserves paths, ignores output and rejects asynchronous validation', () => {
    const validator: Validator<number> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value =>
          typeof value === 'number'
            ? { value }
            : { issues: [{ message: 'number', path: ['nested'] }] },
      },
    };
    const schema = object({ n: field(validator) });
    expect(parse(schema, { n: 2 })).toEqual({ n: 2 });
    try {
      parse(schema, { n: 'bad' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).issues[0].address).toEqual(['n', 'nested']);
    }
    expect(
      parse(
        field(value => Number(value)),
        '2'
      )
    ).toBe('2');
    const outputIgnored: Validator<number> = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ value: 99 }) },
    };
    expect(parse(field(outputIgnored), 2)).toBe(2);
    expect(() =>
      parse(
        field(async value => value),
        2
      )
    ).toThrow('synchronous');
  });
  it('passes the original payload to pure validators and rejects reentrant writes', () => {
    const source = { n: 1 };
    const validate = vi.fn((input: unknown) => input as typeof source);
    expect(parse(field(validate), source)).toBe(source);
    expect(validate).toHaveBeenCalledExactlyOnceWith(source);
    let hook = () => {};
    const schema = object({
      n: field(value => {
        hook();
        return number(value);
      }),
      other: field(number),
    });
    const runtime = createDocument({ schema, initial: { n: 0, other: 0 } });
    hook = () =>
      runtime.update(d => {
        d.other = 10;
      });
    expect(
      runtime.update(d => {
        d.other = 2;
        d.n = 1;
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual({ n: 0, other: 0 });
  });
  it('validates only touched fields and rolls back a late invalid value', () => {
    const validate = vi.fn(number),
      schema = object({ rows: map(object({ n: field(validate) })) });
    const runtime = createDocument({
      schema,
      initial: {
        rows: Object.fromEntries(Array.from({ length: 10000 }, (_, n) => [String(n), { n }])),
      },
    });
    validate.mockClear();
    runtime.update(d => d.rows['1']!.n++);
    expect(validate).toHaveBeenCalledTimes(1);
    const before = runtime.snapshot();
    expect(
      runtime.update(d => {
        d.rows['1']!.n++;
        d.rows['2']!.n = NaN;
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(before);
  });
  it('rejects invalid initial, replacement, variant and tree values before publication', () => {
    const schema = object({ n: field(number), rows: table(object({ n: field(number) })) });
    expect(() => createDocument({ schema, initial: {} as never })).toThrow('Required');
    expect(() =>
      createDocument({ schema, initial: { n: 1, rows: { ids: ['x'], byId: {} } } })
    ).toThrow('agree');
    const runtime = createDocument({ schema, initial: { n: 1, rows: { ids: [], byId: {} } } });
    expect(runtime.replace({ n: NaN, rows: { ids: [], byId: {} } }).status).toBe('rejected');
    expect(runtime.revision()).toBe(0);
  });
  it('shares atomic builtins, symbols and sparse arrays without traversing payloads', () => {
    const key = Symbol('payload');
    const initial = {
      payload: { [key]: { n: 1 }, holes: new Array<number>(3) },
      date: new Date(0),
      values: new Map([['a', { n: 1 }]]),
    };
    const runtime = createDocument({
      schema: object({
        payload: field<typeof initial.payload>(),
        date: field<Date>(),
        values: field<typeof initial.values>(),
      }),
      initial,
    });
    const copy = select(runtime, state => snapshot(state));
    expect(copy).not.toBe(initial);
    expect(copy.payload).toBe(initial.payload);
    expect(copy.date).toBe(initial.date);
    expect(copy.values).toBe(initial.values);
    expect(0 in copy.payload.holes).toBe(false);
    expect(copy.payload.holes.length).toBe(3);
    expect(select(runtime, state => snapshot(state.date))).toBe(initial.date);
  });
  it('copies object, list and tree structure while sharing opaque payloads', () => {
    class Point {
      constructor(public readonly x: number) {}
    }
    const value = field<Point>();
    const schema = object({
      point: value,
      rows: list(value, { keyOf: p => String(p.x) }),
      outline: tree(value),
    });
    const initial = {
      point: new Point(1),
      rows: [new Point(2)],
      outline: { rootId: 'r', nodes: { r: { children: [], value: new Point(3) } } },
    };
    const runtime = createDocument({ schema, initial });
    const saved = runtime.snapshot();
    expect(saved.point).toBe(initial.point);
    expect(saved.rows[0]).toBe(initial.rows[0]);
    expect(saved.outline.nodes.r.value).toBe(initial.outline.nodes.r.value);
    expect(saved.rows).not.toBe(initial.rows);
    expect(saved.outline.nodes.r.children).not.toBe(initial.outline.nodes.r.children);
    runtime.update(d => {
      d.point = new Point(4);
      d.rows.insert(new Point(5));
      d.outline.insert('child', new Point(6), { parentId: 'r' });
    });
    expect(saved.rows).toHaveLength(1);
    expect(saved.outline.nodes.r.children).toEqual([]);
    expect(initial.rows).toHaveLength(1);
    expect(initial.outline.nodes.r.children).toEqual([]);
    runtime.history.undo();
    expect(runtime.snapshot().point).toBe(initial.point);
    expect(runtime.snapshot().rows[0]).toBe(initial.rows[0]);
    runtime.history.redo();
    expect(saved.point).toBe(initial.point);
  });
  it('records exact dependencies for field reads, presence, membership and subtrees', () => {
    const schema = object({ rows: map(object({ n: field<number>(), title: field<string>() })) });
    const runtime = createDocument({ schema, initial: { rows: { a: { n: 1, title: 'A' } } } });
    const selected = track(runtime, s => s.rows.a?.n),
      listener = vi.fn();
    subscribeDependencies(runtime, selected.targets, listener);
    runtime.update(d => (d.rows.a!.title = 'new'));
    expect(listener).not.toHaveBeenCalled();
    runtime.update(d => d.rows.a!.n++);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.update(d => {
      delete d.rows.a;
    });
    expect(listener).toHaveBeenCalledTimes(2);
    runtime.update(d => (d.rows.a = { n: 2, title: 'A' }));
    expect(listener).toHaveBeenCalledTimes(3);
    const missing = track(runtime, s => s.rows.missing?.n),
      missingListener = vi.fn();
    subscribeDependencies(runtime, missing.targets, missingListener);
    runtime.update(d => (d.rows.other = { n: 1, title: 'O' }));
    expect(missingListener).not.toHaveBeenCalled();
    runtime.update(d => (d.rows.missing = { n: 1, title: 'M' }));
    expect(missingListener).toHaveBeenCalledTimes(1);
  });
  it('updates atomic map projections, including present undefined entries', () => {
    const schema = object({ values: map(field<number | undefined>()) }),
      runtime = createDocument({ schema, initial: { values: { a: 1 } } });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const view = projection.map(
      projection.document(runtime).collection(p => p.values),
      (id, n) => `${id}:${n}`
    );
    runtime.update(d => {
      d.values.b = undefined;
      d.values.a = 2;
    });
    expect(view.ids.current()).toEqual(['a', 'b']);
    expect(view.item('b').current()).toBe('b:undefined');
    runtime.update(d => {
      delete d.values.a;
    });
    expect(view.ids.current()).toEqual(['b']);
    projection.dispose();
  });
  it('uses typed assignment for a replacement containing structural collection data', () => {
    const schema = object({
      entries: map(object({ rows: table(object({ n: field<number>() })) })),
    });
    const runtime = createDocument({ schema, initial: { entries: {} } });
    runtime.update(d => assign(d.entries, 'a', { rows: { ids: ['x'], byId: { x: { n: 1 } } } }));
    runtime.update(d => d.entries.a!.rows.get('x')!.n++);
    expect(runtime.snapshot().entries.a.rows.byId.x.n).toBe(2);
  });
  it('rejects detached collection reads after their schema branch is replaced', () => {
    const item = field<{ id: string; other: string }>();
    const schema = object({
      choice: variant('kind', {
        a: object({ rows: list(item, { keyOf: v => v.id }) }),
        b: object({ rows: list(item, { keyOf: v => v.other }) }),
      }),
    });
    const runtime = createDocument({
      schema,
      initial: { choice: { kind: 'a', rows: [{ id: 'a', other: 'b' }] } },
    });
    runtime.update(d => {
      const ids = d.choice.rows.ids;
      assign(d, 'choice', { kind: 'b', rows: [{ id: 'a', other: 'b' }] });
      expect(() => ids()).toThrow('replaced schema branch');
      expect(d.choice.rows.ids()).toEqual(['b']);
    });
  });
  it('undoes atomic builtin and opaque values using the actual captured state', () => {
    class Point {
      constructor(public x: number) {}
    }
    const schema = object({
      date: field<Date>(),
      point: field<Point>(),
    });
    const runtime = createDocument({ schema, initial: { date: new Date(1), point: new Point(1) } });
    runtime.update(d => {
      d.date = new Date(2);
      d.point = new Point(2);
    });
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot().date.getTime()).toBe(1);
    expect(runtime.snapshot().point.x).toBe(1);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot().date.getTime()).toBe(2);
    expect(runtime.snapshot().point.x).toBe(2);
  });
  it('initializes and clears optional containers in the same transaction protocol', () => {
    const schema = object({
      rows: optional(list(field<string>(), { keyOf: v => v })),
      values: optional(map(field<number>())),
      outline: optional(tree(field<string>())),
    });
    const runtime = createDocument({ schema, initial: {} });
    runtime.update(d => {
      assign(d, 'rows', ['a']);
      assign(d, 'outline', { nodes: {} });
      d.values = { a: 1 };
      d.rows!.insert('b');
      d.outline!.insert('r', 'R');
    });
    const value = runtime.snapshot();
    expect(value.rows).toEqual(['a', 'b']);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual({});
    runtime.history.redo();
    expect(runtime.snapshot()).toEqual(value);
    runtime.update(d => {
      delete d.rows;
      delete d.outline;
      delete d.values;
    });
    expect(runtime.snapshot()).toEqual({});
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(value);
  });
});
