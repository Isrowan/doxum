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
    input.rows[0].n = 9;
    expect(parsed.rows[0].n).toBe(1);
    expect(() => parse(schema, { ...input, rows: [input.rows[0], input.rows[0]] })).toThrow(
      'unique'
    );
    expect(() => parse(field<string>(), 'unchecked')).toThrow('validator is required');
    expect(parse(optional(field(text)), undefined)).toBeUndefined();
  });
  it('accepts Standard Schema, preserves paths, rejects transformations and asynchronous validation', () => {
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
    expect(() =>
      parse(
        field(value => Number(value)),
        '2'
      )
    ).toThrow('preserve');
    expect(() =>
      parse(
        field(async value => value),
        2
      )
    ).toThrow('synchronous');
  });
  it('isolates validator payload mutation and rejects attempted reentrant writes', () => {
    const source = { n: 1 };
    expect(() =>
      parse(
        field(input => {
          (input as { n: number }).n++;
          return input;
        }),
        source
      )
    ).toThrow('preserve');
    expect(source.n).toBe(1);
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
  it('snapshots atomic builtins, symbols and sparse arrays independently', () => {
    const key = Symbol('payload');
    const schema = object({
      payload: field<{ [key]: { n: number }; holes: number[] }>(),
      date: field<Date>(),
      values: field<Map<string, { n: number }>>(),
    });
    const runtime = createDocument({
      schema,
      initial: {
        payload: { [key]: { n: 1 }, holes: new Array(3) },
        date: new Date(0),
        values: new Map([['a', { n: 1 }]]),
      },
    });
    const copy = select(runtime, state => snapshot(state));
    expect(0 in copy.payload.holes).toBe(false);
    expect(copy.payload.holes.length).toBe(3);
    copy.payload[key].n = 5;
    copy.date.setTime(9);
    copy.values.get('a')!.n = 5;
    expect(select(runtime, s => s.payload[key].n)).toBe(1);
    expect(select(runtime, s => s.date.getTime())).toBe(0);
    expect(select(runtime, s => s.values.get('a')!.n)).toBe(1);
  });
  it('uses field copiers for object, list and tree snapshot values', () => {
    class Point {
      constructor(public x: number) {}
    }
    const value = field<Point>(undefined, { snapshot: p => new Point(p.x) });
    const schema = object({
      point: value,
      rows: list(value, { keyOf: p => String(p.x) }),
      outline: tree(value),
    });
    const runtime = createDocument({
      schema,
      initial: {
        point: new Point(1),
        rows: [new Point(2)],
        outline: { rootId: 'r', nodes: { r: { children: [], value: new Point(3) } } },
      },
    });
    const copy = runtime.snapshot();
    copy.point.x = 9;
    copy.rows[0].x = 9;
    copy.outline.nodes.r.value!.x = 9;
    expect(runtime.snapshot().point.x).toBe(1);
    expect(runtime.snapshot().rows[0].x).toBe(2);
    expect(runtime.snapshot().outline.nodes.r.value!.x).toBe(3);
    const opaque = createDocument({
      schema: object({ point: field<Point>() }),
      initial: { point: new Point(1) },
    });
    expect(() => opaque.snapshot()).toThrow('copier');
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
      point: field<Point>(undefined, { snapshot: p => new Point(p.x) }),
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
