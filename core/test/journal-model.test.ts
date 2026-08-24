import { describe, expect, it } from 'vitest';
import {
  createDocument,
  field,
  list,
  map,
  object,
  schema,
  table,
  tree,
  type DocumentOperation,
} from '../src';
import { startProfile } from '../src/profile';

type ItemDocument = {
  items: {
    ids: string[];
    byId: Record<string, { value: number }>;
  };
};

const item = object({ value: field<number>() });
const modelSchema = schema({ items: table(item) });
const modelInitial = (): ItemDocument => ({
  items: {
    ids: ['a', 'b'],
    byId: { a: { value: 1 }, b: { value: 2 } },
  },
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const snapshot = (runtime: ReturnType<typeof createDocument<typeof modelSchema>>): ItemDocument =>
  clone(runtime.address.read([]) as ItemDocument);

const same = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((entry, index) => same(entry, right[index]));
  if (
    typeof left === 'object' &&
    left !== null &&
    !Array.isArray(left) &&
    typeof right === 'object' &&
    right !== null &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every(
        key =>
          Object.prototype.hasOwnProperty.call(rightRecord, key) &&
          same(leftRecord[key], rightRecord[key])
      )
    );
  }
  return false;
};

const applyOracle = (
  initial: ItemDocument,
  operations: readonly DocumentOperation[]
):
  | { readonly status: 'accepted'; readonly document: ItemDocument }
  | { readonly status: 'rejected' } => {
  const document = clone(initial);
  for (const operation of operations) {
    if (operation.type === 'field.set') {
      const id = operation.at[1];
      if (!id || !Object.prototype.hasOwnProperty.call(document.items.byId, id))
        return { status: 'rejected' };
      document.items.byId[id].value = operation.value as number;
      continue;
    }
    if (operation.type === 'entity.remove') {
      if (
        new Set(operation.ids).size !== operation.ids.length ||
        operation.ids.some(id => !Object.prototype.hasOwnProperty.call(document.items.byId, id))
      )
        return { status: 'rejected' };
      const removed = new Set(operation.ids);
      document.items.ids = document.items.ids.filter(id => !removed.has(id));
      for (const id of operation.ids) delete document.items.byId[id];
      continue;
    }
    if (operation.type === 'entity.create') {
      const ids = operation.entries.map(entry => entry.id);
      if (
        new Set(ids).size !== ids.length ||
        ids.some(id => Object.prototype.hasOwnProperty.call(document.items.byId, id))
      )
        return { status: 'rejected' };
      for (const entry of operation.entries)
        document.items.byId[entry.id] = clone(entry.value as { value: number });
      const insertion =
        !operation.anchor || ('at' in operation.anchor && operation.anchor.at === 'end')
          ? document.items.ids.length
          : 'at' in operation.anchor
            ? 0
            : 'before' in operation.anchor
              ? document.items.ids.indexOf(operation.anchor.before)
              : document.items.ids.indexOf(operation.anchor.after) + 1;
      if (insertion < 0) return { status: 'rejected' };
      document.items.ids.splice(insertion, 0, ...ids);
      continue;
    }
    if (operation.type === 'entity.move') {
      const current = document.items.ids.indexOf(operation.id);
      if (current < 0) return { status: 'rejected' };
      const remaining = document.items.ids.filter(id => id !== operation.id);
      const insertion =
        !operation.anchor || ('at' in operation.anchor && operation.anchor.at === 'end')
          ? remaining.length
          : 'at' in operation.anchor
            ? 0
            : 'before' in operation.anchor
              ? remaining.indexOf(operation.anchor.before)
              : remaining.indexOf(operation.anchor.after) + 1;
      if (insertion < 0) return { status: 'rejected' };
      remaining.splice(insertion, 0, operation.id);
      document.items.ids = remaining;
      continue;
    }
    throw new Error(`Unexpected model operation '${operation.type}'.`);
  }
  return { status: 'accepted', document };
};

const commonOrderChanged = (before: readonly string[], after: readonly string[]): boolean => {
  const positions = new Map(after.map((id, index) => [id, index]));
  let previous = -1;
  for (const id of before) {
    const position = positions.get(id);
    if (position === undefined) continue;
    if (position < previous) return true;
    previous = position;
  }
  return false;
};

const collectionDiff = (before: ItemDocument, after: ItemDocument) => {
  const initialIds = new Set(before.items.ids);
  const finalIds = new Set(after.items.ids);
  return {
    added: after.items.ids.filter(id => !initialIds.has(id)),
    removed: before.items.ids.filter(id => !finalIds.has(id)),
    updated: before.items.ids.filter(
      id => finalIds.has(id) && !same(before.items.byId[id], after.items.byId[id])
    ),
    orderChanged: commonOrderChanged(before.items.ids, after.items.ids),
  };
};

const commands: readonly (() => DocumentOperation)[] = [
  () => ({ type: 'field.set', at: ['items', 'a', 'value'], value: 1 }),
  () => ({ type: 'field.set', at: ['items', 'a', 'value'], value: 7 }),
  () => ({ type: 'field.set', at: ['items', 'b', 'value'], value: 8 }),
  () => ({ type: 'entity.remove', at: ['items'], ids: ['a'] }),
  () => ({ type: 'entity.remove', at: ['items'], ids: ['b'] }),
  () => ({
    type: 'entity.create',
    at: ['items'],
    entries: [{ id: 'a', value: { value: 1 } }],
    anchor: { at: 'start' },
  }),
  () => ({
    type: 'entity.create',
    at: ['items'],
    entries: [{ id: 'b', value: { value: 2 } }],
    anchor: { at: 'end' },
  }),
  () => ({ type: 'entity.move', at: ['items'], id: 'a', anchor: { at: 'end' } }),
  () => ({ type: 'entity.move', at: ['items'], id: 'b', anchor: { at: 'start' } }),
];

describe('inverse-driven change journal model', () => {
  it('matches a fixed-seed table oracle for accepted, rejected, undo, redo, and impact', () => {
    let seed = 0x20_26_08_22;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const source = modelSchema.collection(path => path.items);

    for (let sequence = 0; sequence < 400; sequence += 1) {
      const length = 3 + (next() % 3);
      const operations = Array.from({ length }, () => commands[next() % commands.length]());
      const initial = modelInitial();
      const oracle = applyOracle(initial, operations);
      const runtime = createDocument({ schema: modelSchema, initial });
      const result = runtime.apply(operations);
      const context = JSON.stringify(operations);

      if (oracle.status === 'rejected') {
        expect(result.status, context).toBe('rejected');
        expect(snapshot(runtime), context).toEqual(initial);
        expect(runtime.revision(), context).toBe(0);
        expect(runtime.history.current(), context).toEqual({ undoDepth: 0, redoDepth: 0 });
        continue;
      }

      const unchanged = same(initial, oracle.document);
      expect(result.status, context).toBe(unchanged ? 'unchanged' : 'committed');
      expect(snapshot(runtime), context).toEqual(oracle.document);
      if (result.status !== 'committed') continue;

      const expected = collectionDiff(initial, oracle.document);
      const change = result.commit.impact.collection(source);
      expect(change.kind, context).toBe('incremental');
      if (change.kind === 'incremental') {
        expect(new Set(change.added), context).toEqual(new Set(expected.added));
        expect(new Set(change.removed), context).toEqual(new Set(expected.removed));
        expect(new Set(change.updated), context).toEqual(new Set(expected.updated));
        expect(change.orderChanged, context).toBe(expected.orderChanged);
      }
      expect(runtime.history.undo().status, context).toBe('committed');
      expect(snapshot(runtime), context).toEqual(initial);
      expect(runtime.history.redo().status, context).toBe('committed');
      expect(snapshot(runtime), context).toEqual(oracle.document);
    }
  });

  it('keeps tree inverse groups parent-first and restores tree sequence endpoints', () => {
    const treeSchema = schema({ outline: tree<string>() });
    const initial = {
      outline: {
        rootId: 'root',
        nodes: {
          root: { children: ['a', 'b'], value: 'root' },
          a: { parentId: 'root', children: ['a1'], value: 'a' },
          a1: { parentId: 'a', children: [], value: 'a1' },
          b: { parentId: 'root', children: [], value: 'b' },
        },
      },
    };
    const runtime = createDocument({ schema: treeSchema, initial });
    const removed = runtime.apply([{ type: 'tree.remove', at: ['outline'], treeNodeId: 'a' }]);
    expect(removed.status).toBe('committed');
    if (removed.status !== 'committed') return;
    expect(removed.commit.inverse.map(operation => operation.type)).toEqual([
      'tree.insert',
      'tree.insert',
    ]);
    expect(
      removed.commit.inverse.map(operation =>
        'treeNodeId' in operation ? operation.treeNodeId : undefined
      )
    ).toEqual(['a', 'a1']);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.address.read([])).toEqual(initial);
    expect(runtime.history.redo().status).toBe('committed');

    const sequenceRuntime = createDocument({ schema: treeSchema, initial });
    const restored = sequenceRuntime.apply([
      { type: 'tree.remove', at: ['outline'], treeNodeId: 'a' },
      {
        type: 'tree.insert',
        at: ['outline'],
        treeNodeId: 'a',
        parentId: 'root',
        index: 0,
        value: 'a',
      },
      {
        type: 'tree.insert',
        at: ['outline'],
        treeNodeId: 'a1',
        parentId: 'a',
        index: 0,
        value: 'a1',
      },
      { type: 'tree.move', at: ['outline'], treeNodeId: 'a', parentId: 'root', index: 1 },
      { type: 'tree.move', at: ['outline'], treeNodeId: 'a', parentId: 'root', index: 0 },
    ]);
    expect(restored.status).toBe('unchanged');
    expect(sequenceRuntime.address.read([])).toEqual(initial);
  });

  it('coalesces list replacement and lifecycle sequences without metadata', () => {
    const rowSchema = schema({
      rows: list<{ id: string; value: number }>({ keyOf: row => row.id }),
    });
    const initial = {
      rows: [
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
      ],
    };
    const runtime = createDocument({ schema: rowSchema, initial });
    const result = runtime.apply([
      { type: 'list.remove', at: ['rows'], key: 'a' },
      {
        type: 'list.insert',
        at: ['rows'],
        key: 'a',
        value: { id: 'a', value: 1 },
        anchor: { at: 'start' },
      },
      {
        type: 'list.replace',
        at: ['rows'],
        value: [
          { id: 'b', value: 2 },
          { id: 'a', value: 1 },
        ],
        keys: ['b', 'a'],
      },
      {
        type: 'list.replace',
        at: ['rows'],
        value: initial.rows,
        keys: ['a', 'b'],
      },
    ]);
    expect(result.status).toBe('unchanged');
    expect(runtime.address.read([])).toEqual(initial);
  });

  it('uses exact address equality when journal hash buckets collide', () => {
    const first = 'field-4534' as const;
    const second = 'field-76340' as const;
    const collisionSchema = schema({ [first]: field<number>(), [second]: field<number>() });
    const runtime = createDocument({
      schema: collisionSchema,
      initial: { [first]: 1, [second]: 2 },
    });
    const result = runtime.apply([
      { type: 'field.set', at: [first], value: 10 },
      { type: 'field.set', at: [second], value: 20 },
    ]);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(runtime.address.read([first])).toBe(10);
    expect(runtime.address.read([second])).toBe(20);
    expect(result.commit.impact.affects({ kind: 'value', at: [first] })).toBe(true);
    expect(result.commit.impact.affects({ kind: 'value', at: [second] })).toBe(true);
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.address.read([first])).toBe(1);
    expect(runtime.address.read([second])).toBe(2);
  });

  it('does not record rejected or unchanged operations', () => {
    const runtime = createDocument({ schema: modelSchema, initial: modelInitial() });
    const profile = startProfile();
    expect(
      runtime.apply([{ type: 'field.set', at: ['items', 'a', 'value'], value: 1 }]).status
    ).toBe('unchanged');
    expect(
      runtime.apply([
        {
          type: 'entity.create',
          at: ['items'],
          entries: [{ id: 'a', value: { value: 9 } }],
        },
      ]).status
    ).toBe('rejected');
    const counters = profile.stop();
    expect(counters.batch.journalRecords).toBe(0);
    expect(counters.journal.subjects).toBe(0);
    expect(counters.journal.absorbed).toBe(0);
  });

  it('rolls back an updated and removed entry into mutable canonical state', () => {
    const initial = modelInitial();
    const runtime = createDocument({ schema: modelSchema, initial });
    const result = runtime.apply([
      { type: 'field.set', at: ['items', 'a', 'value'], value: 9 },
      { type: 'entity.remove', at: ['items'], ids: ['a'] },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'b', value: { value: 20 } }],
      },
    ]);
    expect(result.status).toBe('rejected');
    expect(snapshot(runtime)).toEqual(initial);
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(
      runtime.apply([{ type: 'field.set', at: ['items', 'a', 'value'], value: 3 }]).status
    ).toBe('committed');
  });

  it('upgrades an incremental tree baseline to a whole replacement baseline', () => {
    const treeSchema = schema({ outline: tree<string>() });
    const initial = {
      outline: {
        rootId: 'root',
        nodes: {
          root: { children: ['a'], value: 'root' },
          a: { parentId: 'root', children: [], value: 'a' },
        },
      },
    };
    const runtime = createDocument({ schema: treeSchema, initial });
    const result = runtime.apply([
      { type: 'tree.set', at: ['outline'], treeNodeId: 'a', value: 'temporary' },
      { type: 'tree.replace', at: ['outline'], value: initial.outline },
    ]);
    expect(result.status).toBe('unchanged');
    expect(runtime.address.read([])).toEqual(initial);
  });

  it('routes later descendant writes into an existing parent subject', () => {
    const runtime = createDocument({ schema: modelSchema, initial: modelInitial() });
    const profile = startProfile();
    const result = runtime.apply([
      { type: 'entity.remove', at: ['items'], ids: ['a'] },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'a', value: { value: 9 } }],
        anchor: { at: 'start' },
      },
      { type: 'field.set', at: ['items', 'a', 'value'], value: 1 },
    ]);
    const counters = profile.stop();
    expect(result.status).toBe('unchanged');
    expect(counters.batch.journalRecords).toBe(3);
    expect(counters.journal.subjects).toBe(1);
    expect(snapshot(runtime)).toEqual(modelInitial());
  });

  it('shares one collection interpretation for maps and rejects malformed tables', () => {
    const mapSchema = schema({ entries: map(item) });
    const mapRuntime = createDocument({
      schema: mapSchema,
      initial: { entries: { a: { value: 1 } } },
    });
    expect(
      mapRuntime.apply([
        { type: 'entity.remove', at: ['entries'], ids: ['a'] },
        {
          type: 'entity.create',
          at: ['entries'],
          entries: [{ id: 'a', value: { value: 1 } }],
        },
      ]).status
    ).toBe('unchanged');
    expect(
      mapRuntime.apply([{ type: 'entity.move', at: ['entries'], id: 'a', anchor: { at: 'start' } }])
        .status
    ).toBe('rejected');

    const malformed = createDocument({
      schema: modelSchema,
      initial: { items: { ids: 'not-an-array', byId: {} } } as never,
    });
    const rejected = malformed.apply([
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'a', value: { value: 1 } }],
      },
    ]);
    expect(rejected.status).toBe('rejected');
    expect(malformed.revision()).toBe(0);
  });
});
