import { describe, expect, it, vi } from 'vitest';
import {
  createCollectionView,
  createDocument,
  createMaterializedView,
  dict,
  field,
  list,
  object,
  optional,
  schema,
  select,
  table,
  tree,
  variant,
  type ReadonlyDocument,
} from '../src';
import { createImpact } from '../src/impact';
import * as anchor from '../src/mutation/anchor';
import { startProfile } from '../src/profile';

const item = object({
  value: field<number>(),
  note: optional(field<string>()),
});
const optimizationSchema = schema({
  title: field<string>(),
  values: dict<string, number>(),
  items: table(item),
  rows: list<{ id: string; value: number }>({
    keyOf: value => value.id,
  }),
  outline: tree<{ label: string }>(),
});

const initial = () => ({
  title: 'initial',
  values: { a: 1, b: 2 },
  items: {
    ids: ['a', 'b', 'c'],
    byId: {
      a: { value: 1 },
      b: { value: 2 },
      c: { value: 3 },
    },
  },
  rows: [{ id: 'old', value: 0 }],
  outline: {
    rootId: 'root',
    nodes: {
      root: { children: [], value: { label: 'root' } },
    },
  },
});

describe('performance-oriented mutation invariants', () => {
  it('uses one entity operation for single and batch collection writes', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const result = runtime.update(tx => {
      tx.write.items.create([
        { id: 'd', value: { value: 4 } },
        { id: 'e', value: { value: 5 } },
      ]);
      tx.write.items.remove(['a', 'c']);
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.commit.operations).toHaveLength(2);
    expect(result.commit.operations[0]).toMatchObject({
      type: 'entity.create',
      entries: [{ id: 'd' }, { id: 'e' }],
    });
    expect(result.commit.operations[1]).toMatchObject({
      type: 'entity.remove',
      ids: ['a', 'c'],
    });
    expect(select(runtime, read => read.items.ids())).toEqual(['b', 'd', 'e']);
    const change = result.commit.impact.collection(
      optimizationSchema.collection(path => path.items)
    );
    expect(change).toMatchObject({ kind: 'incremental', orderChanged: false });
    if (change.kind === 'incremental') {
      expect([...change.added]).toEqual(['d', 'e']);
      expect([...change.removed]).toEqual(['a', 'c']);
    }
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
  });

  it('restores a batch remove in original order regardless of input order', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    expect(runtime.update(tx => tx.write.items.remove(['b', 'a'])).status).toBe('committed');
    expect(select(runtime, read => read.items.ids())).toEqual(['c']);
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
  });

  it('restores multiple sparse positions with one ordered merge', () => {
    const ids = ['c', 'f'];
    expect(anchor.validPositions(ids.length, [0, 1, 3, 4])).toBe(true);
    anchor.restore(ids, ['a', 'b', 'd', 'e'], [0, 1, 3, 4]);
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(anchor.validPositions(2, [0, 0])).toBe(false);
    expect(anchor.validPositions(2, [3])).toBe(false);
    expect(() => anchor.restore(['a'], ['b'], [2])).toThrow('positions are invalid');
  });

  it('rejects malformed entity restore positions before mutating the table', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const result = runtime.apply([
      {
        type: 'entity.create',
        at: ['items'],
        entries: [
          { id: 'd', value: { value: 4 } },
          { id: 'e', value: { value: 5 } },
        ],
        positions: [1, 1],
      },
    ]);

    expect(result.status).toBe('rejected');
    expect(runtime.revision()).toBe(0);
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
    expect(select(runtime, read => read.items.get('d'))).toBeUndefined();
    expect(select(runtime, read => read.items.get('e'))).toBeUndefined();
  });

  it('reuses stable history payloads when undoing a batch remove', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const profile = startProfile();
    expect(runtime.update(tx => tx.write.items.remove(['a', 'b'])).status).toBe('committed');
    expect(runtime.history.undo().status).toBe('committed');
    const counters = profile.stop();
    expect(counters.clone.nodes.inverse).toBeGreaterThan(0);
    expect(counters.clone.nodes.canonical).toBeGreaterThan(0);
    expect(counters.clone.nodes.commit).toBe(0);
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
  });

  it('coalesces overlapping batch subjects without losing ids', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const result = runtime.update(tx => {
      tx.write.items.create([
        { id: 'd', value: { value: 4 } },
        { id: 'e', value: { value: 5 } },
      ]);
      tx.write.items.remove('d');
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    const change = result.commit.impact.collection(
      optimizationSchema.collection(path => path.items)
    );
    expect(change.kind).toBe('incremental');
    if (change.kind === 'incremental') {
      expect([...change.added]).toEqual(['e']);
      expect([...change.removed]).toEqual([]);
    }
  });

  it('coalesces entity batches across transitive id overlap', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const listener = vi.fn();
    runtime.subscribe(listener);

    const result = runtime.apply([
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'd', value: { value: 4 } }],
      },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'e', value: { value: 5 } }],
      },
      { type: 'entity.remove', at: ['items'], ids: ['d', 'e'] },
    ]);

    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(listener).not.toHaveBeenCalled();
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
  });

  it('coalesces granular dictionary writes with replacement', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });

    const result = runtime.apply([
      { type: 'dict.set', at: ['values'], key: 'a', value: 9 },
      { type: 'dict.delete', at: ['values'], key: 'b' },
      { type: 'dict.replace', at: ['values'], value: { a: 1, b: 2 } },
    ]);

    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(select(runtime, read => read.values.get())).toEqual({ a: 1, b: 2 });
  });

  it('coalesces entry updates with remove and recreate', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });

    const result = runtime.apply([
      { type: 'field.set', at: ['items', 'b', 'value'], value: 20 },
      { type: 'entity.remove', at: ['items'], ids: ['b'] },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'b', value: { value: 2 } }],
        anchor: { before: 'c' },
      },
    ]);

    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
    expect(select(runtime, read => read.items.get('b')?.value.get())).toBe(2);
  });

  it('coalesces list item lifecycle and order restoration', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });

    const result = runtime.apply([
      {
        type: 'list.insert',
        at: ['rows'],
        key: 'temporary',
        value: { id: 'temporary', value: 1 },
      },
      { type: 'list.move', at: ['rows'], key: 'temporary', anchor: { at: 'start' } },
      { type: 'list.remove', at: ['rows'], key: 'temporary' },
    ]);

    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(select(runtime, read => read.rows.values())).toEqual([{ id: 'old', value: 0 }]);
  });

  it('keeps removed tree topology in the net-change observation', () => {
    const outlineSchema = schema({ outline: tree<string>() });
    const runtime = createDocument({
      schema: outlineSchema,
      initial: {
        outline: {
          rootId: 'root',
          nodes: {
            root: { children: ['a', 'b'], value: 'root' },
            a: { parentId: 'root', children: ['a1'], value: 'a' },
            a1: { parentId: 'a', children: [], value: 'a1' },
            b: { parentId: 'root', children: [], value: 'b' },
          },
        },
      },
    });

    const result = runtime.apply([
      { type: 'tree.remove', at: ['outline'], treeNodeId: 'a' },
      {
        type: 'tree.insert',
        at: ['outline'],
        treeNodeId: 'a',
        parentId: 'root',
        index: 1,
        value: 'a',
      },
    ]);

    expect(result.status).toBe('committed');
    expect(runtime.revision()).toBe(1);
    expect(select(runtime, read => read.outline.has('a1'))).toBe(false);
    expect(select(runtime, read => read.outline.children('root'))).toEqual(['b', 'a']);
  });

  it('coalesces descendant writes with variant replacement', () => {
    const choiceSchema = schema({
      choice: variant('kind', {
        note: object({ kind: field<'note'>(), value: field<number>() }),
        task: object({ kind: field<'task'>(), value: field<number>() }),
      }),
    });
    const runtime = createDocument({
      schema: choiceSchema,
      initial: { choice: { kind: 'note', value: 1 } },
    });

    const profile = startProfile();
    const result = runtime.apply([
      { type: 'field.set', at: ['choice', 'value'], value: 9 },
      { type: 'variant.replace', at: ['choice'], value: { kind: 'note', value: 1 } },
    ]);
    const counters = profile.stop();

    expect(result.status).toBe('unchanged');
    expect(counters.journal.absorbed).toBe(1);
    expect(runtime.revision()).toBe(0);
    expect(runtime.address.read(['choice'])).toEqual({ kind: 'note', value: 1 });
  });

  it('restores stable table membership when a parent variant absorbs its journal subject', () => {
    const wrappedSchema = schema({
      content: variant('kind', {
        page: object({ kind: field<'page'>(), items: table(item) }),
      }),
    });
    const content = {
      kind: 'page' as const,
      items: {
        ids: ['a', 'b', 'c'],
        byId: {
          a: { value: 1 },
          b: { value: 2 },
          c: { value: 3 },
        },
      },
    };
    const runtime = createDocument({
      schema: wrappedSchema,
      initial: { content },
    });

    const result = runtime.apply([
      { type: 'entity.remove', at: ['content', 'items'], ids: ['b'] },
      { type: 'variant.replace', at: ['content'], value: content },
    ]);

    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(runtime.address.read(['content'])).toEqual(content);
  });

  it('propagates nested collection changes through every containing entry', () => {
    const nestedSchema = schema({
      groups: table(
        object({
          items: table(item),
        })
      ),
    });
    const runtime = createDocument({
      schema: nestedSchema,
      initial: {
        groups: {
          ids: ['group'],
          byId: {
            group: {
              items: {
                ids: ['a'],
                byId: { a: { value: 1 } },
              },
            },
          },
        },
      },
    });
    const groups = nestedSchema.collection(path => path.groups);
    const innerItems = nestedSchema.collection(path => path.groups.item('group').items);

    const result = runtime.apply([
      {
        type: 'entity.create',
        at: ['groups', 'group', 'items'],
        entries: [{ id: 'b', value: { value: 2 } }],
      },
    ]);

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    const outerChange = result.commit.impact.collection(groups);
    const innerChange = result.commit.impact.collection(innerItems);
    expect(outerChange.kind).toBe('incremental');
    expect(innerChange.kind).toBe('incremental');
    if (outerChange.kind === 'incremental') expect([...outerChange.updated]).toEqual(['group']);
    if (innerChange.kind === 'incremental') expect([...innerChange.added]).toEqual(['b']);
  });

  it('marks a variant collection entry replacement as an item update', () => {
    const cardSchema = schema({
      cards: table(
        variant('kind', {
          note: object({ kind: field<'note'>(), value: field<number>() }),
          task: object({ kind: field<'task'>(), value: field<number>() }),
        })
      ),
    });
    const runtime = createDocument({
      schema: cardSchema,
      initial: {
        cards: {
          ids: ['card'],
          byId: { card: { kind: 'note', value: 1 } },
        },
      },
    });
    const cards = cardSchema.collection(path => path.cards);

    const result = runtime.apply([
      {
        type: 'variant.replace',
        at: ['cards', 'card'],
        value: { kind: 'task', value: 2 },
      },
    ]);

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    const change = result.commit.impact.collection(cards);
    expect(change.kind).toBe('incremental');
    if (change.kind === 'incremental') expect([...change.updated]).toEqual(['card']);
  });

  it('coalesces a variant entry replacement with remove and recreate', () => {
    const cardSchema = schema({
      cards: table(
        variant('kind', {
          note: object({ kind: field<'note'>(), value: field<number>() }),
          task: object({ kind: field<'task'>(), value: field<number>() }),
        })
      ),
    });
    const runtime = createDocument({
      schema: cardSchema,
      initial: {
        cards: {
          ids: ['card'],
          byId: { card: { kind: 'note', value: 1 } },
        },
      },
    });

    const result = runtime.apply([
      {
        type: 'variant.replace',
        at: ['cards', 'card'],
        value: { kind: 'task', value: 9 },
      },
      { type: 'entity.remove', at: ['cards'], ids: ['card'] },
      {
        type: 'entity.create',
        at: ['cards'],
        entries: [{ id: 'card', value: { kind: 'note', value: 1 } }],
        anchor: { at: 'start' },
      },
    ]);

    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
  });

  it('keeps individual entity operations linear in journal comparisons', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
      history: false,
    });
    const profile = startProfile();
    const result = runtime.apply(
      Array.from({ length: 100 }, (_, index) => ({
        type: 'entity.create' as const,
        at: ['items'],
        entries: [{ id: `created-${index}`, value: { value: index } }],
      }))
    );
    const counters = profile.stop();

    expect(result.status).toBe('committed');
    expect(counters.journal.subjects).toBe(1);
    expect(counters.journal.comparisons).toBeLessThan(200);
  });

  it('does not snapshot full table order for pure removal from a large collection', () => {
    const ids = Array.from({ length: 50_000 }, (_, index) => `item-${index}`);
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: {
        ...initial(),
        items: {
          ids,
          byId: Object.fromEntries(ids.map((id, value) => [id, { value }])),
        },
      },
      history: false,
    });
    const profile = startProfile();
    const result = runtime.apply([
      { type: 'entity.remove', at: ['items'], ids: ids.slice(0, 100) },
    ]);
    const counters = profile.stop();

    expect(result.status).toBe('committed');
    expect(counters.journal.orderSnapshots).toBe(0);
    expect(counters.journal.orderItems).toBe(0);
    expect((runtime.address.read(['items']) as { ids: readonly string[] }).ids).toHaveLength(
      49_900
    );
  });

  it('snapshots table order only when an initially present entity can be reordered', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
      history: false,
    });
    const profile = startProfile();
    const result = runtime.apply([
      { type: 'entity.remove', at: ['items'], ids: ['b'] },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'b', value: { value: 2 } }],
        anchor: { at: 'end' },
      },
    ]);
    const counters = profile.stop();

    expect(result.status).toBe('committed');
    expect(counters.journal.orderSnapshots).toBe(1);
    expect(counters.journal.orderItems).toBe(3);
  });

  it('keeps large impact path buckets exact', () => {
    const paths = Array.from(
      { length: 9 },
      (_, index) => ['items', `item-${index}`, 'value'] as const
    );
    const impact = createImpact({
      schema: optimizationSchema,
      operations: [],
      paths,
    });

    expect(impact.affects(optimizationSchema.value(path => path.items.item('item-4').value))).toBe(
      true
    );
    expect(impact.affects(optimizationSchema.value(path => path.title))).toBe(false);
    expect(impact.affects({ kind: 'value', at: [] })).toBe(true);
  });

  it('coalesces field restore, entity restore, and order restore', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const listener = vi.fn();
    runtime.subscribe(listener);

    expect(
      runtime.apply([
        { type: 'field.set', at: ['items', 'a', 'note'], value: 'temporary' },
        { type: 'field.clear', at: ['items', 'a', 'note'] },
        { type: 'entity.remove', at: ['items'], ids: ['b'] },
        {
          type: 'entity.create',
          at: ['items'],
          entries: [{ id: 'b', value: { value: 2 } }],
          anchor: { before: 'c' },
        },
        { type: 'entity.move', at: ['items'], id: 'a', anchor: { after: 'c' } },
        {
          type: 'entity.move',
          at: ['items'],
          id: 'a',
          anchor: { before: 'b' },
        },
      ]).status
    ).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('marks remove and recreate at a new position as an order change', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const source = optimizationSchema.collection(path => path.items);
    const result = runtime.apply([
      { type: 'entity.remove', at: ['items'], ids: ['b'] },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'b', value: { value: 2 } }],
        anchor: { at: 'end' },
      },
    ]);

    expect(result.status).toBe('committed');
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'c', 'b']);
    if (result.status !== 'committed') return;
    const change = result.commit.impact.collection(source);
    expect(change).toMatchObject({ kind: 'incremental', orderChanged: true });
    if (change.kind === 'incremental') {
      expect([...change.added]).toEqual([]);
      expect([...change.removed]).toEqual([]);
      expect([...change.updated]).toEqual([]);
    }
  });

  it('publishes exact collection changes after journal coalescing', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const source = optimizationSchema.collection(path => path.items);
    const result = runtime.update(tx => {
      tx.write.items.item('a').value.set(10);
      tx.write.items.remove('b');
      tx.write.items.create({ id: 'd', value: { value: 4 } });
      tx.write.items.move('c', { before: 'a' });
    });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    const change = result.commit.impact.collection(source);
    expect(change.kind).toBe('incremental');
    if (change.kind !== 'incremental') return;
    expect([...change.added]).toEqual(['d']);
    expect([...change.removed]).toEqual(['b']);
    expect([...change.updated]).toEqual(['a']);
    expect(change.orderChanged).toBe(true);
  });

  it('rolls back multiple inverse groups after a rejected operation', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const result = runtime.apply([
      { type: 'field.set', at: ['title'], value: 'changed' },
      { type: 'entity.remove', at: ['items'], ids: ['b'] },
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'a', value: { value: 9 } }],
      },
    ]);
    expect(result.status).toBe('rejected');
    expect(select(runtime, read => read.title.get())).toBe('initial');
    expect(select(runtime, read => read.items.ids())).toEqual(['a', 'b', 'c']);
    expect(select(runtime, read => read.items.get('b')?.value.get())).toBe(2);
  });

  it('removes and restores a 10k-node tree without recursive traversal', () => {
    const nodes: Record<
      string,
      { parentId?: string; children: string[]; value: { label: string } }
    > = {};
    for (let index = 0; index < 10_000; index += 1) {
      const id = `node-${index}`;
      const child = index + 1 < 10_000 ? `node-${index + 1}` : undefined;
      nodes[id] = {
        ...(index ? { parentId: `node-${index - 1}` } : {}),
        children: child ? [child] : [],
        value: { label: id },
      };
    }
    const document = {
      ...initial(),
      outline: { rootId: 'node-0', nodes },
    } satisfies ReadonlyDocument<typeof optimizationSchema>;
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: document,
    });
    const profile = startProfile();
    expect(
      runtime.apply([{ type: 'tree.remove', at: ['outline'], treeNodeId: 'node-0' }]).status
    ).toBe('committed');
    const removalCounters = profile.stop();
    expect(removalCounters.mutation.inverseCreated).toBe(10_000);
    expect(removalCounters.clone.nodes.inverse).toBe(20_000);
    expect(select(runtime, read => read.outline.rootId())).toBeUndefined();
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.outline.rootId())).toBe('node-0');
    expect(select(runtime, read => read.outline.has('node-9999'))).toBe(true);
  });

  it('replaces a 100k-item list without a spread argument limit', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const rows = Array.from({ length: 100_000 }, (_, index) => ({
      id: `row-${index}`,
      value: index,
    }));
    expect(runtime.update(tx => tx.write.rows.replace(rows)).status).toBe('committed');
    expect(select(runtime, read => read.rows.length())).toBe(100_000);
    expect(select(runtime, read => read.rows.at(99_999))).toEqual(rows[99_999]);
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.rows.values())).toEqual([{ id: 'old', value: 0 }]);
  });

  it('keeps list journal observations minimal and preserves undo order', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const profile = startProfile();
    const unchanged = runtime.update(tx => {
      tx.write.rows.insert({ id: 'temporary', value: 1 });
      tx.write.rows.remove('temporary');
    });
    const counters = profile.stop();
    expect(unchanged.status).toBe('unchanged');
    expect(counters.clone.nodes.journal).toBe(0);
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });

    expect(
      runtime.update(tx => tx.write.rows.insert({ id: 'next', value: 2 }, { at: 'start' })).status
    ).toBe('committed');
    expect(select(runtime, read => read.rows.at(0))).toEqual({
      id: 'next',
      value: 2,
    });
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.rows.values())).toEqual([{ id: 'old', value: 0 }]);
    expect(runtime.history.redo().status).toBe('committed');
    expect(select(runtime, read => read.rows.at(0))?.id).toBe('next');
  });

  it('updates one row in a 100k CollectionView without copying all', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => `row-${index}`);
    const byId = Object.fromEntries(rows.map((id, index) => [id, { value: index }]));
    const document = {
      ...initial(),
      items: { ids: rows, byId },
    } satisfies ReadonlyDocument<typeof optimizationSchema>;
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: document,
    });
    const source = optimizationSchema.collection(path => path.items);
    const initializationProfile = startProfile();
    const view = createCollectionView({
      runtime,
      source,
      map: (_id, entry) => entry.value.get(),
    });
    const initializationCounters = initializationProfile.stop();
    expect(initializationCounters.collectionView.mappedItems).toBe(100_000);
    expect(initializationCounters.collectionView.idsScanned).toBe(100_000);
    expect(initializationCounters.collectionView.arraysCopied).toBe(0);
    const allListener = vi.fn();
    const rowListener = vi.fn();
    view.all.subscribe(allListener);
    view.item('row-42').subscribe(rowListener);

    const profile = startProfile();
    runtime.update(tx => tx.write.items.item('row-42').value.set(999));
    const beforeRead = profile.snapshot();
    expect(beforeRead.collectionView.mappedItems).toBe(1);
    expect(beforeRead.collectionView.arraysCopied).toBe(0);
    expect(beforeRead.collectionView.idsScanned).toBe(0);
    expect(beforeRead.mutation.normalized).toBe(1);
    expect(beforeRead.mutation.executed).toBe(1);
    expect(beforeRead.mutation.inverseCreated).toBe(1);
    expect(beforeRead.journal.subjects).toBe(1);
    expect(beforeRead.journal.comparisons).toBeGreaterThan(0);
    expect(beforeRead.address.schemaSteps).toBeGreaterThan(0);
    expect(beforeRead.address.documentSteps).toBeGreaterThan(0);
    expect(beforeRead.address.arraysCopied).toBe(0);
    expect(beforeRead.batch.journalRecords).toBe(1);
    expect(beforeRead.journal.absorbed).toBe(0);
    expect(rowListener).toHaveBeenCalledTimes(1);
    expect(allListener).toHaveBeenCalledTimes(1);
    const first = view.all.current();
    const second = view.all.current();
    const afterRead = profile.stop();
    expect(first).toBe(second);
    expect(first[42]).toBe(999);
    expect(afterRead.collectionView.arraysCopied).toBe(1);
    view.dispose();
  });

  it('attributes every structural clone to its ownership boundary', () => {
    const profile = startProfile();
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    runtime.apply([
      {
        type: 'entity.create',
        at: ['items'],
        entries: [{ id: 'd', value: { value: 4 } }],
      },
    ]);
    runtime.apply([{ type: 'entity.remove', at: ['items'], ids: ['a'] }]);
    select(runtime, read => read.rows.values());
    runtime.apply([
      {
        type: 'list.replace',
        at: ['rows'],
        value: [{ id: 'next', value: 1 }],
        keys: ['next'],
      },
    ]);
    runtime.replace(initial());
    const counters = profile.stop();
    expect(counters.clone.nodes.initial).toBeGreaterThan(0);
    expect(counters.clone.documents.initial).toBe(1);
    expect(counters.clone.containers).toBeGreaterThan(0);
    expect(counters.clone.nodes.canonical).toBe(0);
    expect(counters.clone.nodes.commit).toBeGreaterThan(0);
    expect(counters.clone.nodes.inverse).toBeGreaterThan(0);
    expect(counters.clone.nodes.reader).toBeGreaterThan(0);
    expect(counters.clone.nodes.replace).toBeGreaterThan(0);
    expect(counters.clone.nodes.journal).toBe(0);
    expect(counters.clone.deepEqual.calls).toBeGreaterThan(0);
    expect(counters.clone.deepEqual.containers).toBeGreaterThan(0);
    expect(counters.address.arraysCopied).toBeGreaterThan(0);
    expect(counters.clone.calls).toBe(
      counters.clone.nodes.initial +
        counters.clone.nodes.canonical +
        counters.clone.nodes.commit +
        counters.clone.nodes.inverse +
        counters.clone.nodes.reader +
        counters.clone.nodes.replace +
        counters.clone.nodes.journal
    );
  });

  it('maps only added items during a structural CollectionView update', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const source = optimizationSchema.collection(path => path.items);
    const view = createCollectionView({
      runtime,
      source,
      map: (_id, entry) => entry.value.get(),
    });
    const profile = startProfile();
    runtime.update(tx => {
      tx.write.items.remove('b');
      tx.write.items.create({ id: 'd', value: { value: 4 } }, { at: 'start' });
      tx.write.items.move('c', { before: 'a' });
    });
    const counters = profile.stop();
    expect(counters.collectionView.mappedItems).toBe(1);
    expect(counters.collectionView.idsScanned).toBe(3);
    expect(counters.collectionView.arraysCopied).toBe(0);
    expect(view.ids.current()).toEqual(['d', 'c', 'a']);
    expect(view.item('b').current()).toBeUndefined();
    expect(view.item('d').current()).toBe(4);

    const allListener = vi.fn();
    view.all.subscribe(allListener);
    runtime.apply([
      {
        type: 'field.set',
        at: ['items', 'a', 'note'],
        value: 'does not change mapped value',
      },
    ]);
    expect(allListener).not.toHaveBeenCalled();
    view.dispose();
  });

  it('counts materialized update and learned dependency skip', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const title = optimizationSchema.value(path => path.title);
    const view = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.title.get(),
        update: ({ impact, read }) => {
          if (!impact.affects(title)) return { kind: 'unchanged' as const };
          return {
            kind: 'changed' as const,
            value: read.title.get(),
            change: undefined,
          };
        },
      }),
    });
    const profile = startProfile();
    runtime.update(tx => tx.write.title.set('next'));
    runtime.update(tx => tx.write.items.item('a').value.set(10));
    const counters = profile.stop();
    expect(counters.materialized.updated).toBe(1);
    expect(counters.materialized.skipped).toBe(1);
    expect(counters.impact.affectsChecks).toBeGreaterThan(0);
    expect(counters.address.prefixComparisons).toBeGreaterThan(0);
    expect(counters.address.segmentsCompared).toBeGreaterThan(0);
    view.dispose();
  });

  it('compacts disposed processors and preserves the active pipeline', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    for (let index = 0; index < 10_000; index += 1) {
      createMaterializedView(runtime, {
        build: ({ read }) => ({
          value: read.title.get(),
          update: () => ({ kind: 'unchanged' as const }),
        }),
      }).dispose();
    }
    const active = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.title.get(),
        update: ({ read }) => ({
          kind: 'changed' as const,
          value: read.title.get(),
          change: undefined,
        }),
      }),
    });
    const profile = startProfile();
    runtime.update(tx => tx.write.title.set('after-churn'));
    const counters = profile.stop();
    expect(counters.materialized.updated).toBe(1);
    expect(active.current()).toBe('after-churn');
    active.dispose();
  });

  it('uses a listener snapshot for the current CollectionView notification', () => {
    const runtime = createDocument({
      schema: optimizationSchema,
      initial: initial(),
    });
    const source = optimizationSchema.collection(path => path.items);
    const view = createCollectionView({
      runtime,
      source,
      map: (_id, entry) => entry.value.get(),
    });
    const late = vi.fn();
    let unsubscribe = () => {};
    const first = vi.fn(() => {
      unsubscribe();
      view.item('a').subscribe(late);
    });
    unsubscribe = view.item('a').subscribe(first);
    runtime.update(tx => tx.write.items.item('a').value.set(10));
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    runtime.update(tx => tx.write.items.item('a').value.set(11));
    expect(late).toHaveBeenCalledTimes(1);
    view.dispose();
  });
});
