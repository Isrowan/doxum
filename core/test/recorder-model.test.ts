import { describe, expect, it } from 'vitest';
import {
  createDocument,
  field,
  list,
  object,
  table,
  tree,
  TransactionRejected,
  type Draft,
} from '../src';

const model = object({ rows: table(object({ n: field<number>() })) });
type State = { rows: { ids: string[]; byId: Record<string, { n: number }> } };
type Command = { kind: 'edit' | 'create' | 'remove' | 'move'; id: string; n: number };
const initial = (): State => ({ rows: { ids: ['a', 'b'], byId: { a: { n: 1 }, b: { n: 2 } } } });
const oracle = (state: State, command: Command) => {
  const rows = state.rows,
    { id, kind, n } = command;
  if (kind === 'create') {
    if (Object.hasOwn(rows.byId, id)) throw new Error('duplicate');
    rows.byId[id] = { n };
    rows.ids.unshift(id);
  } else {
    if (!Object.hasOwn(rows.byId, id)) throw new Error('missing');
    if (kind === 'edit') rows.byId[id].n = n;
    if (kind === 'remove') {
      delete rows.byId[id];
      rows.ids.splice(rows.ids.indexOf(id), 1);
    }
    if (kind === 'move') {
      rows.ids.splice(rows.ids.indexOf(id), 1);
      rows.ids.push(id);
    }
  }
};
const execute = (d: Draft<typeof model>, command: Command) => {
  const { id, kind, n } = command;
  if (kind === 'create') d.rows.create({ id, value: { n } }, { at: 'start' });
  else if (kind === 'remove') d.rows.remove(id);
  else if (kind === 'move') d.rows.move(id);
  else {
    const row = d.rows.get(id);
    if (!row) throw new TransactionRejected({ code: 'missing', message: 'Missing' });
    row.n = n;
  }
};
describe('first-touch recorder model', () => {
  it('matches grouped list/tree/reset transitions and late rollback against independent snapshots', () => {
    const schema = object({
      rows: list(field<{ id: string; n: number }>(), { keyOf: value => value.id }),
      outline: tree(field<number>()),
    });
    type State = {
      rows: { id: string; n: number }[];
      outline: {
        rootId: string;
        nodes: Record<string, { parentId?: string; children: string[]; value: number }>;
      };
    };
    const start = (): State => ({
      rows: [
        { id: 'a', n: 0 },
        { id: 'b', n: 1 },
        { id: 'c', n: 2 },
      ],
      outline: {
        rootId: 'root',
        nodes: {
          root: { children: ['p', 'q'], value: 0 },
          p: { parentId: 'root', children: ['leaf'], value: 1 },
          q: { parentId: 'root', children: [], value: 2 },
          leaf: { parentId: 'p', children: [], value: 3 },
        },
      },
    });
    let seed = 0x71eebadc;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 16;
    for (let sequence = 0; sequence < 200; sequence++) {
      const before = start();
      let expected = start();
      const runtime = createDocument({ schema, initial: before });
      const replica = createDocument({ schema, initial: before });
      const group = runtime.history.group();
      for (let step = 0; step < 6; step++) {
        const n = next(),
          id = ['a', 'b', 'c'][n % 3];
        const baseline = structuredClone(expected);
        const reject = n % 5 === 0;
        let result;
        if (step === 3) {
          expected = start();
          expected.rows[0].n = n;
          result = runtime.replace(expected);
        } else {
          const index = expected.rows.findIndex(row => row.id === id);
          expected.rows.splice(index, 1);
          expected.rows.unshift({ id, n });
          const nodes = expected.outline.nodes,
            parent = n % 2 ? 'p' : 'q';
          const previous = nodes.leaf.parentId!;
          nodes[previous].children = nodes[previous].children.filter(id => id !== 'leaf');
          nodes[parent].children.push('leaf');
          nodes.leaf = { parentId: parent, children: [], value: n };
          result = runtime.update(draft => {
            draft.rows.remove(id);
            draft.rows.insert({ id, n }, { at: 'start' });
            draft.outline.remove('leaf');
            draft.outline.insert('leaf', n, { parentId: parent });
            if (reject) throw new TransactionRejected({ code: 'model', message: 'Late rejection' });
          });
          if (reject) {
            expected = baseline;
            expect(result.status).toBe('rejected');
          }
        }
        expect(runtime.snapshot(), `${sequence}:${step}`).toEqual(expected);
        if (result.status === 'committed') {
          expect(
            replica.apply(result.commit.changes, { expectedRevision: replica.revision() }).status
          ).toBe('committed');
        }
        expect(replica.snapshot()).toEqual(expected);
      }
      group.end();
      expect(runtime.history.undo().status).toBe('committed');
      expect(runtime.snapshot()).toEqual(before);
      expect(runtime.history.redo().status).toBe('committed');
      expect(runtime.snapshot()).toEqual(expected);
      runtime.dispose();
      replica.dispose();
    }
  });
  it('matches an independent fixed-seed oracle for acceptance, rollback, impact, replay and history', () => {
    let seed = 0x20260908;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let sequence = 0; sequence < 1000; sequence++) {
      const commands: Command[] = Array.from({ length: 3 + (next() % 5) }, () => ({
        kind: (['edit', 'create', 'remove', 'move'] as const)[next() % 4],
        id: ['a', 'b', 'c'][next() % 3],
        n: next() % 4,
      }));
      const before = initial(),
        expected = initial(),
        runtime = createDocument({ schema: model, initial: before });
      let rejected = false;
      try {
        commands.forEach(c => oracle(expected, c));
      } catch {
        rejected = true;
      }
      const result = runtime.update(d => commands.forEach(c => execute(d, c))),
        label = JSON.stringify(commands);
      if (rejected) {
        expect(result.status, label).toBe('rejected');
        expect(runtime.snapshot(), label).toEqual(before);
        expect(runtime.revision()).toBe(0);
        continue;
      }
      expect(runtime.snapshot(), label).toEqual(expected);
      const same =
        JSON.stringify(before.rows.ids) === JSON.stringify(expected.rows.ids) &&
        before.rows.ids.length === Object.keys(expected.rows.byId).length &&
        before.rows.ids.every(id => expected.rows.byId[id]?.n === before.rows.byId[id].n);
      expect(result.status, label).toBe(same ? 'unchanged' : 'committed');
      if (result.status !== 'committed') continue;
      const impact = result.commit.impact.collection(p => p.rows);
      if (impact.kind !== 'incremental') throw new Error('reset');
      expect([...impact.added].sort(), label).toEqual(
        expected.rows.ids.filter(id => !before.rows.ids.includes(id)).sort()
      );
      expect([...impact.removed].sort(), label).toEqual(
        before.rows.ids.filter(id => !expected.rows.ids.includes(id)).sort()
      );
      expect([...impact.updated].sort(), label).toEqual(
        before.rows.ids
          .filter(
            id => expected.rows.byId[id] && expected.rows.byId[id].n !== before.rows.byId[id].n
          )
          .sort()
      );
      const mirror = createDocument({ schema: model, initial: before });
      expect(mirror.apply(result.commit.changes, { expectedRevision: 0 }).status, label).toBe(
        'committed'
      );
      expect(mirror.snapshot(), label).toEqual(expected);
      expect(runtime.history.undo().status, label).toBe('committed');
      expect(runtime.snapshot(), label).toEqual(before);
      expect(runtime.history.redo().status, label).toBe('committed');
      expect(runtime.snapshot(), label).toEqual(expected);
    }
  });
});
