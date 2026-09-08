import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  object,
  optional,
  schema,
  map,
  table,
  dict,
  list,
  tree,
  variant,
  select,
  snapshot,
  parse,
  ParseError,
  type Infer,
  type Validator,
  type DocumentReader,
  type DocumentWriter,
  type CollectionImpact,
} from 'doxum';
import { startProfile } from '../src/profile';

const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError('Expected a finite number.');
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Expected text.');
  return value;
};
type PersonId = string & { readonly person: unique symbol };
type TripId = string & { readonly trip: unique symbol };
const personId = (value: unknown): PersonId => {
  if (typeof value !== 'string' || !value.startsWith('person:'))
    throw new TypeError('Expected person ID.');
  return value as PersonId;
};
const person = object({ name: field(text), age: field(number) });
const peopleSchema = schema({
  people: map(person, { key: personId }),
  ordered: table(person, { key: personId }),
});

describe('schema parsing and validation', () => {
  it('rejects validator writes without changing the transaction or replacement state', () => {
    let nested = () => {};
    const model = schema({
      n: field((value: unknown) => {
        nested();
        return number(value);
      }),
    });
    const runtime = createDocument({ schema: model, initial: { n: 0 } });
    const result = runtime.update(tx => {
      tx.write.n.set(1);
      nested = () => tx.write.n.set(10);
      tx.write.n.set(2);
    });
    expect(result.status).toBe('rejected');
    expect(runtime.snapshot().n).toBe(0);
    nested = () => {
      runtime.update(tx => tx.write.n.set(10));
    };
    expect(runtime.replace({ n: 2 }).status).toBe('rejected');
    expect(runtime.snapshot().n).toBe(0);
    runtime.dispose();
  });
  it('parses all structural nodes with inferred values and independent payloads', () => {
    const row = (value: unknown): { id: string; n: number } => {
      if (!value || typeof value !== 'object' || !('id' in value) || !('n' in value))
        throw new Error('row');
      text(value.id);
      number(value.n);
      return value as { id: string; n: number };
    };
    const model = schema({
      title: field(text),
      note: optional(field(text)),
      status: variant('kind', { open: object({ count: field(number) }), closed: object({}) }),
      people: map(person, { key: personId }),
      ordered: table(person, { key: personId }),
      attrs: dict({ value: number }),
      rows: list({ value: row, keyOf: value => value.id }),
      outline: tree(text),
    });
    const input = {
      title: 'A',
      status: { kind: 'open', count: 2 },
      people: { 'person:1': { name: 'A', age: 1 } },
      ordered: { ids: [], byId: {} },
      attrs: { n: 2 },
      rows: [{ id: 'a', n: 1 }],
      outline: { nodes: {} },
    };
    const result = parse(model, input);
    expectTypeOf(result).toEqualTypeOf<Infer<typeof model>>();
    expect(result).toEqual(input);
    input.rows[0].n = 10;
    expect(result.rows[0].n).toBe(1);
    expect(() => parse(model, { ...input, status: { kind: 'unknown' } })).toThrow(ParseError);
    expect(() => parse(model, { ...input, title: 1 })).toThrow('Expected text');
    expect(() => parse(model, { ...input, rows: [input.rows[0], input.rows[0]] })).toThrow(
      'unique'
    );
    expect(() => parse(field<string>(), 'x')).toThrow('validator is required');
    expect(parse(optional(field<string>()), undefined)).toBeUndefined();
  });

  it('accepts Standard Schema, preserves issue paths and rejects async or transforming validators', () => {
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
    const model = schema({ n: field(validator) });
    expectTypeOf<Infer<typeof model>>().toEqualTypeOf<{ readonly n: number }>();
    expect(parse(model, { n: 2 })).toEqual({ n: 2 });
    try {
      parse(model, { n: 'bad' });
      throw new Error('must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).issues[0].address).toEqual(['n', 'nested']);
    }
    expect(() =>
      parse(
        field(value => Number(value)),
        '2'
      )
    ).toThrow('preserve values');
    expect(() =>
      parse(
        field(async value => value),
        2
      )
    ).toThrow('synchronous');
    const mutating = field((value: unknown) => {
      (value as { n: number }).n++;
      return value;
    });
    const input = { n: 1 };
    expect(() => parse(mutating, input)).toThrow('preserve values');
    expect(input.n).toBe(1);
  });

  it('rejects malformed initial and replacement structures before changing runtime state', () => {
    const model = schema({ n: field(number), people: table(person) });
    expect(() => createDocument({ schema: model, initial: {} as never })).toThrow('Required');
    expect(() =>
      createDocument({ schema: model, initial: { n: 1, people: { ids: ['a'], byId: {} } } })
    ).toThrow('agree');
    const runtime = createDocument({
      schema: model,
      initial: { n: 1, people: { ids: [], byId: {} } },
    });
    expect(runtime.replace({ n: 'bad', people: { ids: [], byId: {} } } as never).status).toBe(
      'rejected'
    );
    expect(runtime.snapshot().n).toBe(1);
    expect(runtime.revision()).toBe(0);
    runtime.dispose();
  });

  it('validates operation payloads and rolls back preceding work, including preparation', () => {
    const model = schema({
      n: field(number),
      result: variant('kind', { ok: object({ value: field(number) }) }),
      people: map(person, { key: personId }),
    });
    const initial = { n: 0, result: { kind: 'ok' as const, value: 1 }, people: {} };
    const runtime = createDocument({ schema: model, initial });
    const observer = vi.fn();
    runtime.subscribe(observer);
    for (const invalid of [
      { type: 'field.set', at: ['n'], value: 'wrong' },
      { type: 'variant.replace', at: ['result'], value: { kind: 'unknown' } },
      {
        type: 'entity.create',
        at: ['people'],
        entries: [{ id: 'trip:1', value: { name: 'a', age: 1 } }],
      },
      {
        type: 'entity.create',
        at: ['people'],
        entries: [{ id: 'person:1', value: { name: 'a' } }],
      },
    ]) {
      expect(runtime.apply([{ type: 'field.set', at: ['n'], value: 2 }, invalid]).status).toBe(
        'rejected'
      );
      expect(runtime.snapshot()).toEqual(initial);
    }
    expect(
      runtime.prepare(tx => {
        tx.write.n.set(2);
        tx.write.n.set('bad' as never);
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    expect(observer).not.toHaveBeenCalled();
    expect(runtime.history.current().undoDepth).toBe(0);
    runtime.dispose();
  });

  it('validates only changed fields and entries on incremental writes', () => {
    const validate = vi.fn(number);
    const model = schema({ rows: map(object({ n: field(validate) })) });
    const runtime = createDocument({
      schema: model,
      initial: {
        rows: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), { n: i }])),
      },
    });
    validate.mockClear();
    runtime.update(tx => tx.write.rows.item('5').n.set(42));
    expect(validate).toHaveBeenCalledTimes(1);
    runtime.history.undo();
    runtime.history.redo();
    expect(runtime.snapshot().rows['5'].n).toBe(42);
    runtime.dispose();
  });
});

describe('domain collection keys', () => {
  it('preserves branded keys through access, selectors, impact and projection chains', () => {
    const id = personId('person:1');
    const runtime = createDocument({
      schema: peopleSchema,
      initial: { people: {}, ordered: { ids: [], byId: {} } },
    });
    const result = runtime.update(tx =>
      tx.write.people.create({ id, value: { name: 'A', age: 1 } })
    );
    const selector = peopleSchema.collection(path => path.people);
    if (result.status !== 'committed') throw new Error('commit');
    expectTypeOf(result.commit.impact.collection(selector)).toEqualTypeOf<
      CollectionImpact<PersonId>
    >();
    select(runtime, read => {
      expectTypeOf(read.people.ids()).toEqualTypeOf<readonly PersonId[]>();
      expect(read.people.get(id)?.name.get()).toBe('A');
    });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const source = projection.document(runtime).collection(path => path.people);
    const all = projection.value({ source }, ({ source }) => snapshot(source.read));
    expectTypeOf(all.current()).toEqualTypeOf<Infer<typeof peopleSchema>['people']>();
    const values = projection.map(source, (key, read) => {
      expectTypeOf(key).toEqualTypeOf<PersonId>();
      return snapshot(read);
    });
    const ages = projection.map(values, (key, value) => {
      expectTypeOf(key).toEqualTypeOf<PersonId>();
      return value.age;
    });
    expect(ages.item(id).current()).toBe(1);
    expectTypeOf(ages.ids.current()).toEqualTypeOf<readonly PersonId[]>();
    const check = (
      read: DocumentReader<typeof peopleSchema>,
      write: DocumentWriter<typeof peopleSchema>,
      trip: TripId
    ) => {
      // @ts-expect-error A trip ID is not a person ID.
      read.people.get(trip);
      // @ts-expect-error Writer keys retain their domain.
      write.people.item(trip);
      // @ts-expect-error Creation keys retain their domain.
      write.people.create({ id: trip, value: { name: 'a', age: 1 } });
      // @ts-expect-error Anchors use the same domain key.
      write.ordered.move(id, { before: trip });
      // @ts-expect-error Selector item traversal retains keys.
      peopleSchema.value(path => path.people.item(trip).age);
      // @ts-expect-error Mapped collections retain source keys.
      ages.item(trip);
    };
    void check;
    projection.dispose();
    runtime.dispose();
  });

  it('checks keys in incoming addresses, removals and anchors', () => {
    const runtime = createDocument({
      schema: peopleSchema,
      initial: { people: {}, ordered: { ids: [], byId: {} } },
    });
    expect(
      runtime.apply([{ type: 'entity.remove', at: ['people'], ids: ['trip:1'] }])
    ).toMatchObject({ status: 'rejected', issues: [{ code: 'invalid-key' }] });
    expect(
      runtime.apply([
        {
          type: 'entity.create',
          at: ['ordered'],
          entries: [{ id: 'person:1', value: { name: 'a', age: 1 } }],
          anchor: { before: 'trip:1' },
        },
      ])
    ).toMatchObject({ status: 'rejected', issues: [{ code: 'invalid-key' }] });
    expect(() =>
      parse(peopleSchema, {
        people: { 'trip:1': { name: 'a', age: 1 } },
        ordered: { ids: [], byId: {} },
      })
    ).toThrow('person ID');
    runtime.dispose();
  });

  it('supports detached builtins in validators and keeps raw field accessors bound', () => {
    const date = (value: unknown): Date => {
      if (!(value instanceof Date)) throw new Error('date');
      return value;
    };
    const source = new Date(123);
    const parsed = parse(field(date), source);
    expect(parsed.getTime()).toBe(123);
    expect(parsed).not.toBe(source);
    const runtime = createDocument({ schema: schema({ n: field(number) }), initial: { n: 0 } });
    runtime.update(tx => {
      const set = tx.write.n.set,
        get = tx.read.n.get;
      set(get() + 1);
    });
    expect(runtime.snapshot().n).toBe(1);
    runtime.dispose();
  });
});

describe('subtree snapshots and field updates', () => {
  it('preserves payload symbol properties, sparse arrays and rollback-time snapshots', () => {
    const key = Symbol('key');
    const model = schema({
      value: field<{ [key]: { n: number }; holes: number[] }>(),
      n: field<number>(),
    });
    const runtime = createDocument({
      schema: model,
      initial: { value: { [key]: { n: 1 }, holes: new Array(3) }, n: 0 },
    });
    // Atomic field ownership is an existing contract; assign this payload through the field writer.
    runtime.update(tx => tx.write.value.set({ [key]: { n: 1 }, holes: new Array(3) }));
    const copy = select(runtime, read => snapshot(read.value));
    expect(copy.holes.length).toBe(3);
    expect(0 in copy.holes).toBe(false);
    copy[key].n = 5;
    expect(select(runtime, read => read.value.get()[key].n)).toBe(1);
    let captured: { readonly n: number } | undefined;
    runtime.update(tx => {
      tx.write.n.set(2);
      captured = { n: snapshot(tx.read.n) };
      tx.reject({ code: 'no', message: 'rollback' });
    });
    expect(captured?.n).toBe(2);
    expect(runtime.snapshot().n).toBe(0);
    runtime.dispose();
  });
  it('captures exact inferred values without reserved business names and expires with the reader', () => {
    const settings = object({
      get: field<string>(),
      snapshot: field<{ n: number }>(),
      nested: object({ n: field<number>() }),
    });
    const model = schema({ settings, other: field<number>() });
    const runtime = createDocument({
      schema: model,
      initial: { settings: { get: 'business', snapshot: { n: 1 }, nested: { n: 2 } }, other: 0 },
    });
    let expired!: () => unknown;
    const value = select(runtime, read => {
      expired = () => snapshot(read.settings);
      return snapshot(read.settings);
    });
    expectTypeOf(value).toEqualTypeOf<Infer<typeof settings>>();
    expect(() => expired()).toThrow('no longer active');
    runtime.update(tx => {
      tx.write.settings.snapshot.set({ n: 5 });
      tx.write.settings.nested.n.set(6);
    });
    expect(value.snapshot.n).toBe(1);
    expect(value.nested.n).toBe(2);
    const captured = runtime.update(tx => {
      tx.write.settings.nested.n.set(8);
      const result = snapshot(tx.read.settings);
      tx.write.settings.nested.n.set(9);
      return result;
    });
    if (captured.status !== 'committed') throw new Error('commit');
    expect(captured.value.nested.n).toBe(8);
    expect(() => snapshot({} as never)).toThrow('Doxum reader');
    runtime.dispose();
  });

  it('copies mutable builtins and supports explicit opaque field copiers', () => {
    class Point {
      constructor(public x: number) {}
    }
    const model = schema({
      date: field<Date>(),
      values: field<Map<string, { n: number }>>(),
      point: field<Point>(undefined, { snapshot: value => new Point(value.x) }),
    });
    const runtime = createDocument({
      schema: model,
      initial: { date: new Date(0), values: new Map([['a', { n: 1 }]]), point: new Point(2) },
    });
    const copy = select(runtime, read => snapshot(read));
    copy.date.setTime(100);
    copy.values.get('a')!.n = 9;
    copy.point.x = 10;
    expect(select(runtime, read => read.date.get().getTime())).toBe(0);
    expect(select(runtime, read => read.values.get().get('a')!.n)).toBe(1);
    expect(select(runtime, read => read.point.get().x)).toBe(2);
    runtime.dispose();
  });

  it('updates fields atomically and records ordinary set operations', () => {
    const model = schema({
      n: field(number),
      maybe: optional(field(number)),
      payload: field<{ n: number }>(),
    });
    const runtime = createDocument({ schema: model, initial: { n: 0, payload: { n: 1 } } });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const result = runtime.update(tx => {
      tx.write.n.update(n => n + 1);
      tx.write.n.update(n => n + 2);
      tx.write.maybe.update(n => (n ?? 0) + 1);
    });
    expect(runtime.snapshot()).toEqual({ n: 3, maybe: 1, payload: { n: 1 } });
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.operations.map(operation => operation.type)).toEqual([
      'field.set',
      'field.set',
      'field.set',
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual({ n: 0, payload: { n: 1 } });
    runtime.history.redo();
    expect(runtime.snapshot().n).toBe(3);
    const before = runtime.snapshot();
    expect(() =>
      runtime.update(tx => {
        tx.write.n.update(n => n + 1);
        tx.write.payload.update(value => {
          value.n = 100;
          throw new Error('cancel');
        });
      })
    ).toThrow('cancel');
    expect(runtime.snapshot()).toEqual(before);
    expect(
      runtime.update(tx => {
        tx.write.n.update(n => n + 1);
        tx.write.n.update(() => NaN);
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(before);
    expect(runtime.update(tx => tx.write.n.update(n => n)).status).toBe('unchanged');
    expect(() =>
      runtime.update(tx =>
        tx.write.n.update(n => {
          tx.write.n.set(99);
          return n;
        })
      )
    ).toThrow('nested writes');
    expect(() =>
      runtime.update(tx => {
        // @ts-expect-error Async updater callbacks are forbidden.
        tx.write.n.update(async n => n + 1);
      })
    ).toThrow('synchronous');
    expect(runtime.snapshot()).toEqual(before);
    runtime.dispose();
  });

  it('only snapshots the requested row and preserves unrelated projection values', () => {
    const model = schema({ rows: map(object({ n: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: {
        rows: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), { n: i }])),
      },
    });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const mapper = vi.fn(
      (_id: string, row: ReturnType<DocumentReader<typeof model>['rows']['get']>) => snapshot(row!)
    );
    const values = projection.map(
      projection.document(runtime).collection(path => path.rows),
      mapper
    );
    const stable = values.item('2').current();
    mapper.mockClear();
    const profile = startProfile();
    runtime.update(tx => tx.write.rows.item('1').n.update(n => n + 1));
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(values.item('2').current()).toBe(stable);
    expect(profile.stop().reader.structuralSnapshots).toBe(1);
    projection.dispose();
    runtime.dispose();
  });
});

describe('indexed subscriptions', () => {
  it('invalidates an entity snapshot when a nested collection changes order', () => {
    const model = schema({ outer: map(object({ rows: table(object({ n: field<number>() })) })) });
    const runtime = createDocument({
      schema: model,
      initial: { outer: { a: { rows: { ids: ['x', 'y'], byId: { x: { n: 1 }, y: { n: 2 } } } } } },
    });
    const entity = { kind: 'collection' as const, at: ['outer'], id: 'a' };
    const callback = vi.fn();
    runtime.subscribe(entity, callback);
    runtime.update(tx => tx.write.outer.item('a').rows.move('y', { at: 'start' }));
    expect(callback).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
  it('does not check unrelated entity subscriptions and deduplicates matching targets', () => {
    const model = schema({ rows: map(object({ n: field<number>(), m: field<number>() })) });
    const runtime = createDocument({
      schema: model,
      initial: {
        rows: Object.fromEntries(
          Array.from({ length: 10000 }, (_, i) => [String(i), { n: 0, m: 0 }])
        ),
      },
      history: false,
    });
    const callback = vi.fn();
    for (let i = 0; i < 1000; i++)
      runtime.subscribe(
        model.value(path => path.rows.item(String(i)).n),
        callback
      );
    const profile = startProfile();
    runtime.update(tx => {
      for (let i = 2000; i < 2100; i++) tx.write.rows.item(String(i)).n.set(1);
    });
    const counters = profile.stop();
    expect(callback).not.toHaveBeenCalled();
    expect(counters.impact.affectsChecks).toBe(0);
    expect(counters.address.prefixComparisons).toBe(0);
    const duplicate = vi.fn();
    runtime.subscribe(
      [model.value(path => path.rows), model.value(path => path.rows.item('0').n)],
      duplicate
    );
    runtime.update(tx => {
      tx.write.rows.item('0').n.set(1);
      tx.write.rows.item('0').m.set(1);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(duplicate).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('matches keyed membership, ancestor replacement, reset and cancellation precisely', () => {
    const model = schema({
      content: variant('kind', {
        rows: object({ rows: table(object({ n: field<number>() })) }),
        empty: object({}),
      }),
    });
    const initial = {
      content: {
        kind: 'rows' as const,
        rows: { ids: ['a', 'b'], byId: { a: { n: 1 }, b: { n: 2 } } },
      },
    };
    const runtime = createDocument({ schema: model, initial });
    const b = { kind: 'collection' as const, at: ['content', 'rows'], id: 'b' };
    const result = runtime.apply([
      { type: 'field.set', at: ['content', 'rows', 'a', 'n'], value: 3 },
    ]);
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.impact.affects(b)).toBe(false);
    const listener = vi.fn();
    runtime.subscribe(b, listener);
    runtime.apply([
      { type: 'entity.move', at: ['content', 'rows'], id: 'b', anchor: { at: 'start' } },
    ]);
    expect(listener).not.toHaveBeenCalled();
    runtime.apply([{ type: 'entity.remove', at: ['content', 'rows'], ids: ['a'] }]);
    expect(listener).not.toHaveBeenCalled();
    runtime.update(tx => tx.write.content.replace({ kind: 'empty' }));
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.replace(initial);
    expect(listener).toHaveBeenCalledTimes(2);
    let stop = () => {};
    runtime.subscribe(
      model.value(path => path.content),
      () => stop()
    );
    const canceled = vi.fn();
    stop = runtime.subscribe(b, canceled);
    runtime.replace({ content: { kind: 'empty' } });
    expect(canceled).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
