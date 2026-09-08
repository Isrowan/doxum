import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  field,
  map,
  object,
  optional,
  schema,
  select,
  snapshot,
  variant,
} from 'doxum';
import { AddressIndex } from '../src/address';
import { startProfile } from '../src/profile';

const model = schema({
  rows: map(
    object({
      position: object({ x: field<number>(), y: field<number>() }),
      note: optional(field<string>()),
    })
  ),
  content: variant('kind', {
    rows: object({ rows: map(object({ n: field<number>() })) }),
    empty: object({}),
  }),
});
const initial = () => ({
  rows: { a: { position: { x: 0, y: 0 } }, b: { position: { x: 0, y: 0 } } },
  content: { kind: 'rows' as const, rows: { a: { n: 0 } } },
});
const valueOf = (runtime: ReturnType<typeof createDocument<typeof model>>) =>
  select(runtime, snapshot);

describe('mutation execution path', () => {
  it('shares sibling locations and skips operation allocation for unchanged fields', () => {
    const runtime = createDocument({ schema: model, initial: initial() });
    let counters = startProfile();
    const result = runtime.update(tx => {
      const position = tx.write.rows.item('a').position;
      position.x.update(n => n + 1);
      position.y.update(n => n + 2);
    });
    const changed = counters.stop();
    expect(result.status).toBe('committed');
    expect(changed.address.schemaSteps).toBe(5);
    expect(changed.address.documentSteps).toBe(5);
    expect(changed.mutation.normalized).toBe(2);
    expect(changed.journal.subjects).toBe(2);
    counters = startProfile();
    expect(
      runtime.update(tx => {
        const position = tx.write.rows.item('a').position;
        position.x.update(n => n);
        position.y.set(2);
      }).status
    ).toBe('unchanged');
    const unchanged = counters.stop();
    expect(unchanged.mutation.normalized).toBe(0);
    expect(unchanged.mutation.inverseCreated).toBe(0);
    expect(unchanged.journal.subjects).toBe(0);
  });

  it('revalidates unchanged values and rejects without partial writes', () => {
    let allowed = true;
    const validator = vi.fn((value: unknown) => {
      if (!allowed || typeof value !== 'number') throw new Error('Invalid number');
      return value;
    });
    const definition = schema({ n: field(validator), other: field<number>() });
    const runtime = createDocument({ schema: definition, initial: { n: 0, other: 0 } });
    validator.mockClear();
    allowed = false;
    expect(
      runtime.update(tx => {
        tx.write.other.set(1);
        tx.write.n.update(n => n);
      }).status
    ).toBe('rejected');
    expect(validator).toHaveBeenCalledTimes(1);
    expect(select(runtime, snapshot)).toEqual({ n: 0, other: 0 });
    expect(runtime.revision()).toBe(0);
  });

  it('retains detached methods, latest values, net changes and writer lifetime', () => {
    const runtime = createDocument({ schema: model, initial: initial() });
    let escaped!: (n: number) => void;
    const listener = vi.fn();
    runtime.subscribe(listener);
    expect(
      runtime.update(tx => {
        const position = tx.write.rows.item('a').position;
        const { set, update } = position.x;
        escaped = set;
        set(4);
        update(n => n + 2);
        set(0);
        tx.write.rows.item('a').note.set('temporary');
        tx.write.rows.item('a').note.clear();
      }).status
    ).toBe('unchanged');
    expect(listener).not.toHaveBeenCalled();
    expect(valueOf(runtime)).toEqual(initial());
    expect(() => escaped(9)).toThrow(/active/);
  });

  it('invalidates locations after remove/recreate and preserves undo and redo', () => {
    const runtime = createDocument({ schema: model, initial: initial() });
    const result = runtime.update(tx => {
      const old = tx.write.rows.item('a').position;
      old.x.set(1);
      tx.write.rows.remove('a');
      tx.write.rows.create({ id: 'a', value: { position: { x: 10, y: 20 } } });
      old.y.update(n => n + 2);
      old.x.update(n => n + 1);
    });
    expect(result.status).toBe('committed');
    expect(valueOf(runtime).rows.a?.position).toEqual({ x: 11, y: 22 });
    runtime.history.undo();
    expect(valueOf(runtime)).toEqual(initial());
    runtime.history.redo();
    expect(valueOf(runtime).rows.a?.position).toEqual({ x: 11, y: 22 });
  });

  it('restores mixed field/structure batches after a late rejection and prepare', () => {
    const runtime = createDocument({ schema: model, initial: initial() });
    const run = (tx: Parameters<Parameters<typeof runtime.update>[0]>[0]) => {
      const position = tx.write.rows.item('a').position;
      position.x.set(1);
      tx.write.rows.remove('a');
      tx.write.rows.create({ id: 'a', value: { position: { x: 10, y: 20 } } });
      position.y.update(n => n + 2);
    };
    expect(
      runtime.update(tx => {
        run(tx);
        tx.write.rows.item('missing').position.x.set(1);
      }).status
    ).toBe('rejected');
    expect(valueOf(runtime)).toEqual(initial());
    const prepared = runtime.prepare(run);
    expect(prepared.status).toBe('prepared');
    expect(valueOf(runtime)).toEqual(initial());
    if (prepared.status !== 'prepared') throw new Error('Expected prepared update');
    expect(runtime.apply(prepared.operations).status).toBe('committed');
    expect(valueOf(runtime).rows.a?.position).toEqual({ x: 10, y: 22 });
    runtime.apply(prepared.inverse);
    expect(valueOf(runtime)).toEqual(initial());
  });

  it('promotes field records before variant replacement and recognizes net restoration', () => {
    const runtime = createDocument({ schema: model, initial: initial() });
    expect(
      runtime.apply([
        { type: 'field.set', at: ['content', 'rows', 'a', 'n'], value: 1 },
        { type: 'variant.replace', at: ['content'], value: { kind: 'empty' } },
        { type: 'variant.replace', at: ['content'], value: initial().content },
      ]).status
    ).toBe('unchanged');
    expect(valueOf(runtime)).toEqual(initial());
    const result = runtime.apply([
      { type: 'field.set', at: ['content', 'rows', 'a', 'n'], value: 1 },
      { type: 'variant.replace', at: ['content'], value: { kind: 'empty' } },
    ]);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected commit');
    expect(result.commit.impact.collection(model.collection(p => p.content.rows)).kind).toBe(
      'reset'
    );
    runtime.history.undo();
    expect(valueOf(runtime)).toEqual(initial());
  });

  it('reads collection impact without indexing descendant field paths', () => {
    const runtime = createDocument({ schema: model, initial: initial() });
    const result = runtime.update(tx => {
      tx.write.rows.item('a').position.x.set(1);
      tx.write.rows.item('b').position.y.set(2);
    });
    if (result.status !== 'committed') throw new Error('Expected commit');
    const add = vi.spyOn(AddressIndex.prototype, 'add');
    try {
      const impact = result.commit.impact.collection(model.collection(p => p.rows));
      expect(impact.kind).toBe('incremental');
      if (impact.kind === 'incremental') expect([...impact.updated]).toEqual(['a', 'b']);
      expect(add.mock.calls.every(([path]) => path.length === 1)).toBe(true);
      expect(result.commit.impact.affects(model.value(p => p.rows.item('a').position.x))).toBe(
        true
      );
      expect(result.commit.impact.affects(model.value(p => p.rows.item('a').position.y))).toBe(
        false
      );
    } finally {
      add.mockRestore();
    }
  });
});
