import { describe, expect, it, vi } from 'vitest';
import {
  assign,
  asReadable,
  createDocument,
  field,
  list,
  map,
  object,
  optional,
  select,
  snapshot,
  table,
  TransactionRejected,
  tree,
  variant,
  type Draft,
  type SchemaPath,
} from '../src';

const row = object({ n: field<number>(), title: field<string>() });
const model = object({
  n: field<number>(),
  rows: map(row),
  ordered: table(row),
  note: optional(field<string>()),
});
const initial = () => ({
  n: 0,
  rows: { a: { n: 1, title: 'A' } },
  ordered: { ids: ['a', 'b'], byId: { a: { n: 1, title: 'A' }, b: { n: 2, title: 'B' } } },
});
const setup = () => createDocument({ schema: model, initial: initial() });

describe('draft transactions', () => {
  it('reads writes immediately and publishes only one final fact per field', () => {
    const runtime = setup(),
      listener = vi.fn();
    runtime.subscribe(listener);
    const result = runtime.update(draft => {
      draft.n = 1;
      draft.n += 2;
      draft.rows.a!.n = draft.n;
      return { warnings: ['review'], n: draft.n };
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.value).toEqual({ warnings: ['review'], n: 3 });
    expect(result.commit.changes.changes).toHaveLength(2);
    expect(result.commit.changes.changes[0]).toEqual({
      kind: 'value',
      at: ['n'],
      before: { present: true, value: 0 },
      after: { present: true, value: 3 },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial());
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.snapshot().n).toBe(3);
  });
  it('elides net-zero transactions without revision, history, or notifications', () => {
    const runtime = setup(),
      listener = vi.fn();
    runtime.subscribe(listener);
    expect(
      runtime.update(d => {
        d.n++;
        d.n--;
        d.rows.b = { n: 5, title: 'B' };
        delete d.rows.b;
      }).status
    ).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current().undoDepth).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
  it.each([false, undefined, { error: 'business result' }])(
    'normal return values commit, including %j',
    value => {
      const runtime = setup();
      expect(
        runtime.update(d => {
          d.n++;
          return value;
        })
      ).toMatchObject({ status: 'committed', value });
    }
  );
  it.each([new Error('ordinary'), 42, null, 'failed'])(
    'rolls back and rethrows ordinary failures unchanged: %j',
    error => {
      const runtime = setup();
      let thrown: unknown = Symbol();
      try {
        runtime.update(d => {
          d.n = 9;
          delete d.rows.a;
          d.ordered.remove('b');
          throw error;
        });
      } catch (value) {
        thrown = value;
      }
      expect(thrown).toBe(error);
      expect(runtime.snapshot()).toEqual(initial());
      expect(runtime.revision()).toBe(0);
    }
  );
  it('copies structured rejection issues and restores all partial work', () => {
    const runtime = setup(),
      address = ['n'];
    const error = new TransactionRejected({ code: 'no', message: 'No', address });
    address[0] = 'other';
    const result = runtime.update(d => {
      d.n++;
      d.ordered.remove('a');
      throw error;
    });
    expect(result).toMatchObject({
      status: 'rejected',
      revision: 0,
      issues: [{ source: 'application', address: ['n'], code: 'no' }],
    });
    expect(Object.isFrozen(error.issues[0].address)).toBe(true);
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('expires drafts and reads, keeps identities stable within a scope, and rejects structural escape use', () => {
    const runtime = setup();
    let escaped!: Draft<typeof model>;
    runtime.update(d => {
      escaped = d;
      expect(d.rows.a).toBe(d.rows.a);
      d.n++;
    });
    expect(() => escaped.n).toThrow('expired');
    expect(() => {
      escaped.n = 4;
    }).toThrow('expired');
    const read = select(runtime, state => state.rows);
    expect(() => Object.keys(read)).toThrow('expired');
    const copy = select(runtime, state => snapshot(state.rows.a));
    expect(copy).toEqual({ n: 1, title: 'A' });
    runtime.update(d => d.rows.a!.n++);
    expect(copy?.n).toBe(1);
  });
  it('re-resolves retained child drafts after deletion and recreation', () => {
    const runtime = setup();
    runtime.update(d => {
      const a = d.rows.a!;
      delete d.rows.a;
      expect(a.n).toBeUndefined();
      d.rows.a = { n: 8, title: 'new' };
      a.n = 9;
      expect(d.rows.a.n).toBe(9);
    });
    expect(runtime.snapshot().rows.a.n).toBe(9);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('rejects writes through a detached entity and rolls back prior deletion', () => {
    const runtime = setup();
    expect(
      runtime.update(d => {
        const a = d.rows.a!;
        delete d.rows.a;
        a.n = 9;
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('does not reserve business fields on object access or infer containers from byId', () => {
    const schema = object({
      get: field<string>(),
      set: field<number>(),
      update: field<number>(),
      item: field<string>(),
      byId: object({ get: field<string>() }),
    });
    const runtime = createDocument({
      schema,
      initial: { get: 'business', set: 1, update: 2, item: 'x', byId: { get: 'nested' } },
    });
    runtime.update(d => {
      d.get = 'updated';
      d.byId.get = d.get;
    });
    expect(select(runtime, d => snapshot(d))).toMatchObject({
      get: 'updated',
      byId: { get: 'updated' },
    });
    expect(runtime.address.read(['get'])).toBe('updated');
  });
  it('distinguishes missing map entries from present undefined and handles prototype-like keys', () => {
    const schema = object({ values: map(field<number | undefined>()) });
    const runtime = createDocument({ schema, initial: { values: {} } });
    runtime.update(d => {
      d.values.a = undefined;
      d.values.__proto__ = 1;
      assign(d.values, 'constructor', 2);
    });
    expect(select(runtime, d => 'a' in d.values)).toBe(true);
    expect(select(runtime, d => Object.keys(d.values))).toEqual(['a', '__proto__', 'constructor']);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual({ values: {} });
    runtime.history.redo();
    runtime.update(d => {
      delete d.values.a;
    });
    expect(select(runtime, d => 'a' in d.values)).toBe(false);
  });
  it('supports optional deletion and reverses absent versus undefined', () => {
    const runtime = setup();
    runtime.update(d => {
      d.note = undefined;
    });
    expect(Object.hasOwn(runtime.snapshot(), 'note')).toBe(true);
    runtime.history.undo();
    expect(Object.hasOwn(runtime.snapshot(), 'note')).toBe(false);
    runtime.history.redo();
    runtime.update(d => {
      delete d.note;
    });
    expect(Object.hasOwn(runtime.snapshot(), 'note')).toBe(false);
  });
  it('forbids undeclared writes, ordinary object replacement and meta operations', () => {
    const runtime = setup();
    expect(
      runtime.update(d => {
        Reflect.set(d, 'unknown', 1);
      }).status
    ).toBe('rejected');
    expect(
      runtime.update(d => {
        Reflect.set(d, 'rows', {});
      }).status
    ).toBe('rejected');
    for (const run of [
      (d: object) => Object.defineProperty(d, 'n', { value: 2 }),
      (d: object) => Object.setPrototypeOf(d, {}),
      (d: object) => Object.freeze(d),
    ])
      expect(() =>
        runtime.update(d => {
          d.n++;
          run(d);
        })
      ).toThrow();
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('forbids writes in reads, nested transactions and asynchronous callbacks', () => {
    const runtime = setup();
    expect(() => select(runtime, d => Reflect.set(d, 'n', 1))).toThrow('read-only');
    expect(() =>
      runtime.update(d => {
        d.n++;
        runtime.update(inner => inner.n++);
      })
    ).toThrow('re-entered');
    expect(() =>
      // @ts-expect-error Transactions are synchronous.
      runtime.update(async d => {
        d.n++;
      })
    ).toThrow('synchronous');
    expect(runtime.snapshot()).toEqual(initial());
  });
});

describe('structural transitions', () => {
  it('absorbs child changes into entry replacement and restoration', () => {
    const runtime = setup();
    const result = runtime.update(d => {
      d.rows.a!.n = 5;
      delete d.rows.a;
      d.rows.a = { n: 6, title: 'new' };
      d.rows.a.n = 7;
    });
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.changes.changes).toHaveLength(2);
    expect(result.commit.changes.changes[0]).toMatchObject({
      at: ['rows', 'a', 'n'],
      before: { value: 1 },
      after: { value: 7 },
    });
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('coalesces table entry restoration and order restoration', () => {
    const runtime = setup();
    expect(
      runtime.update(d => {
        d.ordered.get('a')!.n = 9;
        d.ordered.remove('a');
        d.ordered.create({ id: 'a', value: { n: 1, title: 'A' } }, { at: 'start' });
        d.ordered.move('a', { at: 'end' });
        d.ordered.move('a', { at: 'start' });
      }).status
    ).toBe('unchanged');
    const result = runtime.update(d => d.ordered.remove(['b', 'a']));
    expect(result.status).toBe('committed');
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('rolls back a duplicate table create after preceding writes and validates anchors', () => {
    const runtime = setup();
    expect(
      runtime.update(d => {
        d.n++;
        d.ordered.create([
          { id: 'c', value: { n: 3, title: 'C' } },
          { id: 'a', value: { n: 8, title: 'duplicate' } },
        ]);
      }).status
    ).toBe('rejected');
    expect(runtime.update(d => d.ordered.move('a', { before: 'missing' })).status).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial());
  });
  it('protects variant discriminants and re-resolves old branch proxies', () => {
    const choice = variant('kind', {
      a: object({ n: field<number>() }),
      b: object({ text: field<string>() }),
    });
    const schema = object({ choice: optional(choice) });
    const runtime = createDocument({ schema, initial: {} });
    runtime.update(d => {
      d.choice = { kind: 'a', n: 1 };
    });
    expect(() =>
      runtime.update(d => {
        Reflect.set(d.choice!, 'kind', 'b');
      })
    ).toThrow('discriminant');
    expect(
      runtime.update(d => {
        const old = d.choice!;
        d.choice = { kind: 'b', text: 'B' };
        Reflect.set(old, 'n', 2);
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot().choice).toEqual({ kind: 'a', n: 1 });
    runtime.update(d => {
      if (d.choice?.kind === 'a') d.choice.n = 2;
      d.choice = { kind: 'b', text: 'B' };
    });
    runtime.history.undo();
    expect(runtime.snapshot().choice).toEqual({ kind: 'a', n: 1 });
  });
  it('absorbs nested table order and entry facts before replacing a variant', () => {
    const schema = object({
      content: variant('kind', { rows: object({ rows: table(row) }), empty: object({}) }),
    });
    const value = { content: { kind: 'rows' as const, rows: initial().ordered } };
    const runtime = createDocument({ schema, initial: value });
    expect(
      runtime.update(d => {
        if (d.content.kind === 'rows') {
          d.content.rows.remove('a');
          d.content.rows.get('b')!.n = 9;
        }
        assign(d, 'content', value.content);
      }).status
    ).toBe('unchanged');
    runtime.update(d => {
      if (d.content.kind === 'rows') d.content.rows.move('a');
      d.content = { kind: 'empty' };
    });
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(value);
  });
  it('keeps root replacement reversible and observable through the same ChangeSet', () => {
    const runtime = setup(),
      other = { ...initial(), n: 9 };
    const result = runtime.replace(other);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('commit');
    expect(result.commit.impact.kind).toBe('reset');
    expect(result.commit.changes.changes[0].at).toEqual([]);
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial());
    runtime.history.redo();
    expect(runtime.snapshot()).toEqual(other);
  });
  it('keeps list identity, replacement and ordering reversible', () => {
    const schema = object({
      rows: list(field<{ id: string; n: number }>(), { keyOf: item => item.id }),
    });
    const initial = {
        rows: [
          { id: 'a', n: 1 },
          { id: 'b', n: 2 },
        ],
      },
      runtime = createDocument({ schema, initial });
    expect(
      runtime.update(d => {
        const a = d.rows.get('a')!;
        d.rows.remove('a');
        d.rows.insert(a, { at: 'start' });
      }).status
    ).toBe('unchanged');
    runtime.update(d => {
      d.rows.set('a', { id: 'a', n: 3 });
      d.rows.move('b', { at: 'start' });
      d.rows.insert({ id: 'c', n: 4 });
    });
    expect(runtime.snapshot().rows.map(i => i.id)).toEqual(['b', 'a', 'c']);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.history.redo().status).toBe('committed');
    expect(runtime.update(d => d.rows.set('a', { id: 'x', n: 1 })).status).toBe('rejected');
    const before = runtime.snapshot();
    expect(
      runtime.update(d => {
        d.rows.remove('a');
        d.rows.insert({ id: 'b', n: 1 });
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(before);
    runtime.update(d => {
      d.rows.set('a', { id: 'a', n: 8 });
      d.rows.replace(initial.rows);
    });
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(before);
  });
  it('records only touched tree nodes and restores topology, root and payloads', () => {
    const schema = object({ outline: tree(field<string>()) });
    const runtime = createDocument({ schema, initial: { outline: { nodes: {} } } });
    runtime.update(d => {
      d.outline.insert('root', 'R');
      d.outline.insert('a', 'A', { parentId: 'root' });
      d.outline.insert('b', 'B', { parentId: 'root' });
      d.outline.insert('c', 'C', { parentId: 'a' });
    });
    const initial = runtime.snapshot();
    expect(
      runtime.update(d => {
        d.outline.move('a', { parentId: 'root', index: 1 });
        d.outline.move('a', { parentId: 'root', index: 0 });
      }).status
    ).toBe('unchanged');
    expect(
      runtime.update(d => {
        d.outline.set('a', 'changed');
        d.outline.move('a', { parentId: 'c' });
      }).status
    ).toBe('rejected');
    expect(runtime.snapshot()).toEqual(initial);
    runtime.update(d => d.outline.remove('a'));
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial);
    runtime.update(d => {
      d.outline.set('a', 'temporary');
      d.outline.replace({ nodes: {} });
    });
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial);
    runtime.update(d => d.outline.remove('root'));
    expect(runtime.snapshot().outline).toEqual({ nodes: {} });
    runtime.history.undo();
    expect(runtime.snapshot()).toEqual(initial);
  });
});

describe('subscriptions and ownership', () => {
  it('does not notify unchanged fields after an entry is deleted and recreated', () => {
    const runtime = setup(),
      title = vi.fn(),
      n = vi.fn();
    runtime.subscribe(p => p.rows.item('a').title, title);
    runtime.subscribe(p => p.rows.item('a').n, n);
    runtime.update(d => {
      d.rows.a!.n = 2;
      delete d.rows.a;
      d.rows.a = { n: 3, title: 'A' };
    });
    expect(title).not.toHaveBeenCalled();
    expect(n).toHaveBeenCalledTimes(1);
  });
  it('parses single and multiple paths once and notifies each registration once', () => {
    const runtime = setup(),
      pick = vi.fn((path: SchemaPath<typeof model.shape>) => path.n);
    const listener = vi.fn();
    runtime.subscribe(pick, listener);
    const both = vi.fn();
    runtime.subscribe([p => p.rows, p => p.rows.item('a').n], both);
    runtime.update(d => {
      d.n++;
      d.rows.a!.n++;
    });
    runtime.update(d => d.n++);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(both).toHaveBeenCalledTimes(1);
  });
  it('shares root schema identity while isolating data and subscriptions', () => {
    const a = setup(),
      b = setup(),
      listener = vi.fn();
    b.subscribe(p => p.n, listener);
    expect(a.schema).toBe(model);
    expect(b.schema).toBe(model);
    expect(Object.isFrozen(model.shape)).toBe(true);
    a.update(d => d.n++);
    expect(b.snapshot().n).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    const read = asReadable(a);
    expect('update' in read).toBe(false);
    expect(select(read, s => s.n)).toBe(1);
  });
  it('returns observer errors after commit and forbids writes while notifying', () => {
    const runtime = setup();
    runtime.subscribe(() => {
      throw new Error('listener');
    });
    runtime.subscribe(() => runtime.update(d => d.n++));
    const result = runtime.update(d => d.n++);
    expect(result.status).toBe('committed');
    if (result.status === 'committed') expect(result.observerErrors).toHaveLength(2);
    expect(runtime.snapshot().n).toBe(1);
  });
  it('makes runtime lifecycle checks consistent', () => {
    const runtime = setup();
    runtime.dispose();
    runtime.dispose();
    expect(() => runtime.snapshot()).toThrow('disposed');
    expect(() => select(runtime, d => d.n)).toThrow('disposed');
    expect(() => runtime.subscribe(() => {})).toThrow('disposed');
    expect(() => runtime.history.undo()).toThrow('disposed');
  });
});
