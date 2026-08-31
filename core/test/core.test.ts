import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createCollectionView,
  createDocument,
  createMaterializedView,
  asReadable,
  commandFootprint,
  dict,
  field,
  list,
  map,
  object,
  optional,
  schema,
  select,
  footprintsOverlap,
  table,
  target,
  tree,
  variant,
  type CollectionSelector,
  type CollectionReader,
  type DictionaryWriter,
  type DocumentReader,
  type DocumentWriter,
  type FieldReader,
  type FieldWriter,
  type ListReader,
  type ListWriter,
  type TreeReader,
  type TreeWriter,
  type ReaderOfNode,
  type ValueSelector,
} from '../src';

const project = object({ name: field<string>(), archived: field<boolean>() });
const projectSchema = schema({
  title: field<string>(),
  projects: table(project),
});
const initial = {
  title: 'one',
  projects: { ids: ['a'], byId: { a: { name: 'A', archived: false } } },
};

type SelectorValue<T> = T extends ValueSelector<infer TValue> ? TValue : never;
type CollectionTypes<T> =
  T extends CollectionSelector<infer TId, infer TNode>
    ? { id: TId; entry: import('../src').DocumentValueOfNode<TNode> }
    : never;

describe('mutable Doxum runtime', () => {
  it('derives collection entry access from schema nodes', () => {
    const entry = object({
      title: field<string>(),
      note: optional(field<string>()),
      outline: optional(tree<string>()),
      tags: optional(list<string>({ keyOf: value => value })),
      attrs: optional(dict<string, number>()),
    });
    const documentSchema = schema({ items: table(entry) });
    type Writer = DocumentWriter<typeof documentSchema>;
    type ItemWriter = ReturnType<Writer['items']['item']>;
    expectTypeOf<ItemWriter['title']>().toEqualTypeOf<FieldWriter<string>>();
    expectTypeOf<ItemWriter['note']>().toEqualTypeOf<FieldWriter<string | undefined, true>>();
    expectTypeOf<ItemWriter['outline']>().toMatchTypeOf<TreeWriter<string>>();
    expectTypeOf<ItemWriter['outline']['clear']>().toEqualTypeOf<() => void>();
    expectTypeOf<ItemWriter['tags']>().toMatchTypeOf<ListWriter<string>>();
    expectTypeOf<ItemWriter['tags']['clear']>().toEqualTypeOf<() => void>();
    expectTypeOf<ItemWriter['attrs']>().toMatchTypeOf<DictionaryWriter<string, number>>();
    expectTypeOf<ItemWriter['attrs']['clear']>().toEqualTypeOf<() => void>();

    type Reader = DocumentReader<typeof documentSchema>;
    expectTypeOf<Reader['items']>().toEqualTypeOf<CollectionReader<string, typeof entry>>();
    expectTypeOf<Reader['items']['get']>().toEqualTypeOf<
      (id: string) => ReaderOfNode<typeof entry> | undefined
    >();
    type EntryReader = ReaderOfNode<typeof entry>;
    expectTypeOf<EntryReader['title']>().toEqualTypeOf<FieldReader<string>>();
    expectTypeOf<EntryReader['note']>().toEqualTypeOf<FieldReader<string | undefined>>();
    expectTypeOf<EntryReader['outline']>().toEqualTypeOf<TreeReader<string>>();
    expectTypeOf<EntryReader['tags']>().toEqualTypeOf<ListReader<string>>();
    expectTypeOf<EntryReader['attrs']>().toEqualTypeOf<
      FieldReader<Readonly<Partial<Record<string, number>>>>
    >();
  });

  it('infers selector and collection types from schema paths', () => {
    const title = projectSchema.value(path => path.title);
    const name = projectSchema.value(path => path.projects.item('a').name);
    const projects = projectSchema.collection(path => path.projects);
    expectTypeOf<SelectorValue<typeof title>>().toEqualTypeOf<string>();
    expectTypeOf<SelectorValue<typeof name>>().toEqualTypeOf<string>();
    const collectionTypes: CollectionTypes<typeof projects> = {
      id: '',
      entry: { name: '', archived: false },
    };
    expect(collectionTypes).toEqual({ id: '', entry: { name: '', archived: false } });

    const otherSchema = schema({
      entries: map(project),
      numbers: list<number>({ keyOf: value => String(value) }),
      outline: tree<{ label: string }>(),
    });
    const entries = otherSchema.collection(path => path.entries);
    const numbers = otherSchema.value(path => path.numbers);
    const outline = otherSchema.value(path => path.outline);
    const entryTypes: CollectionTypes<typeof entries> = {
      id: '',
      entry: { name: '', archived: false },
    };
    expect(entryTypes.entry.archived).toBe(false);
    expectTypeOf<SelectorValue<typeof numbers>>().toEqualTypeOf<readonly number[]>();
    const outlineValue: SelectorValue<typeof outline> = {
      rootId: 'root',
      nodes: { root: { children: [], value: { label: 'root' } } },
    };
    expect(outlineValue.rootId).toBe('root');
  });
  it('infers value selectors through variant branch fields', () => {
    const variantSchema = schema({
      card: variant('kind', {
        note: object({ kind: field<'note'>(), text: field<string>() }),
        task: object({ kind: field<'task'>(), done: field<boolean>() }),
      }),
    });
    const text = variantSchema.value(path => path.card.text);
    const done = variantSchema.value(path => path.card.done);
    expectTypeOf<SelectorValue<typeof text>>().toEqualTypeOf<string>();
    expectTypeOf<SelectorValue<typeof done>>().toEqualTypeOf<boolean>();
  });
  it('updates in place and rolls back rejected batches', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    expect(
      runtime.update(tx => {
        tx.write.title.set('two');
        return tx.read.title.get();
      })
    ).toMatchObject({ status: 'committed', value: 'two' });
    expect(select(runtime, read => read.title.get())).toBe('two');
    const rejected = runtime.apply([
      { type: 'field.set', at: ['title'], value: 'three' },
      {
        type: 'entity.create',
        at: ['projects'],
        entries: [{ id: 'a', value: {} }],
      } as never,
    ]);
    expect(rejected.status).toBe('rejected');
    expect(select(runtime, read => read.title.get())).toBe('two');
    expect(() =>
      runtime.update(tx => {
        tx.write.title.set('temporary');
        throw new Error('stop');
      })
    ).toThrow('stop');
    expect(select(runtime, read => read.title.get())).toBe('two');
  });
  it('prepares a typed update without publishing or mutating the runtime', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const prepared = runtime.prepare(tx => {
      tx.write.title.set('two');
      tx.write.projects.create({
        id: 'b',
        value: { name: 'B', archived: false },
      });
      return tx.read.title.get();
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.value).toBe('two');
    expect(prepared.operations).toHaveLength(2);
    expect(prepared.inverse).toHaveLength(2);
    expect(runtime.revision()).toBe(0);
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(listener).not.toHaveBeenCalled();
    expect(select(runtime, read => read.title.get())).toBe('one');
    expect(select(runtime, read => read.projects.has('b'))).toBe(false);

    expect(runtime.apply(prepared.operations).status).toBe('committed');
    expect(select(runtime, read => read.title.get())).toBe('two');
    expect(select(runtime, read => read.projects.get('b')?.name.get())).toBe('B');
    expect(runtime.update(tx => tx.write.projects.item('b').name.set('BB')).status).toBe(
      'committed'
    );
    expect(select(runtime, read => read.projects.get('b')?.name.get())).toBe('BB');
  });
  it('returns typed unchanged and rejected prepare outcomes without a revision', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const unchanged = runtime.prepare(tx => {
      tx.write.title.set('one');
      return tx.read.title.get();
    });
    expect(unchanged).toEqual({ status: 'unchanged', value: 'one', reports: [] });
    const rejected = runtime.prepare(tx =>
      tx.reject({ source: 'application', code: 'invalid', message: 'No.' })
    );
    expect(rejected).toEqual({
      status: 'rejected',
      issues: [{ source: 'application', code: 'invalid', message: 'No.' }],
    });
    expect(runtime.revision()).toBe(0);
  });
  it('publishes immutable prepared payloads that can safely cross an async durable boundary', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const payload = { name: 'B', archived: false };
    const prepared = runtime.prepare(tx => {
      tx.write.projects.create({ id: 'b', value: payload });
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    payload.name = 'mutated';
    expect(runtime.apply(prepared.operations).status).toBe('committed');
    expect(select(runtime, read => read.projects.get('b')?.name.get())).toBe('B');
    const operation = prepared.operations[0] as unknown as {
      readonly entries: readonly [{ readonly value: object }];
    };
    expect(Object.isFrozen(operation.entries[0].value)).toBe(true);
  });
  it('exports a frozen document snapshot and a read-only runtime capability', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const snapshot = runtime.snapshot();
    expect(snapshot).toEqual(initial);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.projects)).toBe(true);
    expect(Object.isFrozen(snapshot.projects.byId.a)).toBe(true);
    const readable = asReadable(runtime);
    expect(select(readable, read => read.title.get())).toBe('one');
    expect('update' in readable).toBe(false);
    runtime.update(tx => tx.write.title.set('two'));
    expect(select(readable, read => read.title.get())).toBe('two');
  });
  it('derives stable operation footprints for persisted command conflict checks', () => {
    const update = commandFootprint([
      { type: 'field.set', at: ['projects', 'a', 'name'], value: 'AA' },
    ]);
    const remove = commandFootprint([{ type: 'entity.remove', at: ['projects'], ids: ['a'] }]);
    const other = commandFootprint([
      { type: 'field.set', at: ['projects', 'b', 'name'], value: 'BB' },
    ]);
    expect(Object.isFrozen(update)).toBe(true);
    expect(Object.isFrozen(update[0])).toBe(true);
    expect(footprintsOverlap(update, remove)).toBe(true);
    expect(footprintsOverlap(update, other)).toBe(false);
  });
  it('rejects malformed operation envelopes before touching document state', () => {
    const cases = [
      {
        operation: { type: 'field.set' },
        code: 'invalid-address',
        message: 'Operation address is malformed.',
      },
      {
        operation: { type: 'entity.create', at: ['projects'], entries: {} },
        code: 'invalid-operation',
        message: 'Entity create payload is malformed.',
      },
      {
        operation: { type: 'not.real', at: [] },
        code: 'unknown-operation',
        message: 'Unknown document operation.',
      },
    ] as const;
    for (const entry of cases) {
      const runtime = createDocument({ schema: projectSchema, initial });
      const result = runtime.apply([entry.operation]);
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') continue;
      expect(result.issues).toEqual([
        {
          source: 'mutation',
          code: entry.code,
          address: [],
          message: entry.message,
        },
      ]);
      expect(runtime.revision()).toBe(0);
      expect(select(runtime, read => read.title.get())).toBe('one');
    }
  });
  it('resolves string addresses through the runtime address domain', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const ref = runtime.address.resolve(['projects', 'a', 'name']);
    expect(ref?.address).toEqual(['projects', 'a', 'name']);
    expect(runtime.address.read(['projects', 'a', 'name'])).toBe('A');
    expect(runtime.address.contains(['projects'], ['projects', 'a', 'name'])).toBe(true);
    expect(runtime.address.overlaps(['title'], ['projects'])).toBe(false);
    expect(runtime.address.resolve(['missing', 'path'])).toBeUndefined();
  });
  it('rejects a non-array apply batch at the unknown boundary', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const result = runtime.apply({ type: 'field.set', at: ['title'], value: 'ignored' });
    expect(result).toMatchObject({
      status: 'rejected',
      revision: 0,
      issues: [
        {
          source: 'mutation',
          code: 'invalid-operation',
          address: [],
          message: 'Operation batch must be an array.',
        },
      ],
    });
    if (result.status !== 'rejected') return;
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(Object.isFrozen(result.issues[0])).toBe(true);
    expect(Object.isFrozen(result.issues[0].address)).toBe(true);
    expect(runtime.revision()).toBe(0);
    expect(select(runtime, read => read.title.get())).toBe('one');
  });
  it('publishes fine grained inverse and history', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const result = runtime.update(tx => tx.write.projects.item('a').name.set('AA'));
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect((result.commit as { document?: unknown }).document).toBeUndefined();
      expect(result.commit.inverse[0]).toMatchObject({
        type: 'field.set',
        value: 'A',
      });
    }
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.projects.get('a')?.name.get())).toBe('A');
    expect(runtime.history.redo().status).toBe('committed');
  });
  it('filters subscriptions and deduplicates multi-target matches', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const listener = vi.fn();
    const title = projectSchema.value(path => path.title);
    const name = projectSchema.value(path => path.projects.item('a').name);
    runtime.subscribe([title, name], listener);
    runtime.update(tx => tx.write.title.set('two'));
    runtime.update(tx => tx.write.projects.item('a').name.set('AA'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it('keeps schema identity in shared impact target equality', () => {
    const otherSchema = schema({
      title: field<string>(),
      projects: table(project),
    });
    const own = projectSchema.value(path => path.title);
    const foreign = otherSchema.value(path => path.title);
    expect(target.same(own, foreign)).toBe(false);
    expect(Object.isFrozen(own.address)).toBe(true);
  });
  it('updates collection and materialized views', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const source = projectSchema.collection(path => path.projects);
    const collection = createCollectionView({
      runtime,
      source,
      map: (_id, entry) => entry.name.get(),
    });
    expect(collection.all.current()).toEqual(['A']);
    runtime.update(tx => tx.write.projects.item('a').name.set('AA'));
    expect(collection.item('a').current()).toBe('AA');
    const view = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.projects.ids().length,
        update: ({ read }) => ({
          kind: 'changed',
          value: read.projects.ids().length,
          change: undefined,
        }),
      }),
    });
    expect(view.current()).toBe(1);
    runtime.update(tx =>
      tx.write.projects.create({
        id: 'b',
        value: { name: 'B', archived: false },
      })
    );
    expect(view.current()).toBe(2);
    view.dispose();
    collection.dispose();
  });
  it('caches collection item handles and makes disposed handles inert', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const source = projectSchema.collection(path => path.projects);
    const collection = createCollectionView({
      runtime,
      source,
      map: (_id, entry) => entry.name.get(),
    });
    const item = collection.item('a');
    expect(collection.item('a')).toBe(item);
    const listener = vi.fn();
    item.subscribe(listener);
    collection.dispose();
    expect(item.current()).toBeUndefined();
    runtime.update(tx => tx.write.title.set('two'));
    expect(listener).not.toHaveBeenCalled();
    expect(item.subscribe(listener)).toBeTypeOf('function');
    runtime.dispose();
  });
  it('stops history and subscribers after runtime disposal', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.update(tx => tx.write.title.set('two'));
    runtime.dispose();
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(runtime.history.undo().status).toBe('unchanged');
    expect(() => runtime.subscribe(() => undefined)).toThrow('disposed');
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('transfers structural payloads and snapshots published history', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const payload = { name: 'B', archived: false };
    const address = ['projects'];
    const result = runtime.apply([
      {
        type: 'entity.create',
        at: address,
        entries: [{ id: 'b', value: payload }],
      },
    ]);
    address[0] = 'title';
    payload.name = 'mutated';
    expect(select(runtime, read => read.projects.get('b')?.name.get())).toBe('mutated');
    expect(result.status).toBe('committed');
    if (result.status === 'committed')
      expect(
        (
          result.commit.operations[0] as unknown as {
            entries: readonly [{ value: { name: string } }];
          }
        ).entries[0].value.name
      ).toBe('B');
    if (result.status === 'committed')
      expect(
        Object.isFrozen(
          (
            result.commit.operations[0] as unknown as {
              entries: readonly [{ value: object }];
            }
          ).entries[0].value
        )
      ).toBe(true);
    if (result.status === 'committed') expect(result.commit.operations[0].at).toEqual(['projects']);
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.projects.has('b'))).toBe(false);
    runtime.update(tx => tx.write.title.set('changed'));
    expect(runtime.replace(initial).status).toBe('committed');
    expect(runtime.history.current()).toEqual({ undoDepth: 0, redoDepth: 0 });
  });
  it('propagates materialized source changes in creation order', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const source = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.projects.ids().length,
        update: ({ read }) => ({
          kind: 'changed',
          value: read.projects.ids().length,
          change: { count: read.projects.ids().length },
        }),
      }),
    });
    const downstream = createMaterializedView(runtime, {
      sources: { source },
      build: ({ sources }) => ({
        value: sources.source.value * 2,
        update: ({ sources }) => ({
          kind: 'changed',
          value: sources.source.value * 2,
          change: sources.source.change,
        }),
      }),
    });
    runtime.update(tx =>
      tx.write.projects.create({
        id: 'b',
        value: { name: 'B', archived: false },
      })
    );
    expect(source.current()).toBe(2);
    expect(downstream.current()).toBe(4);
    downstream.dispose();
    source.dispose();
  });
  it('settles the materialized pipeline before notifying listeners', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const source = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.projects.ids().length,
        update: ({ impact, read }) => {
          impact.collection(projectSchema.collection(path => path.projects));
          return {
            kind: 'changed' as const,
            value: read.projects.ids().length,
            change: undefined,
          };
        },
      }),
    });
    const downstream = createMaterializedView(runtime, {
      sources: { source },
      build: ({ sources }) => ({
        value: sources.source.value * 2,
        update: ({ sources }) => ({
          kind: 'changed' as const,
          value: sources.source.value * 2,
          change: undefined,
        }),
      }),
    });
    const observed: number[] = [];
    source.subscribe(() => observed.push(downstream.current()));
    runtime.update(tx =>
      tx.write.projects.create({
        id: 'b',
        value: { name: 'B', archived: false },
      })
    );
    expect(observed).toEqual([4]);
  });
  it('skips a materialized update after learning an unrelated impact dependency', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const projects = projectSchema.collection(path => path.projects);
    const update = vi.fn();
    const view = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.projects.ids().length,
        update: input => {
          update();
          input.impact.collection(projects);
          return { kind: 'unchanged' as const };
        },
      }),
    });
    runtime.update(tx => tx.write.projects.item('a').name.set('AA'));
    runtime.update(tx => tx.write.title.set('two'));
    expect(update).toHaveBeenCalledTimes(1);
    view.dispose();
  });
  it('detects net-zero tree moves without cloning or comparing the whole tree', () => {
    const mindmapSchema = schema({ mindmap: tree<string>() });
    const runtime = createDocument({
      schema: mindmapSchema,
      initial: {
        mindmap: {
          rootId: 'root',
          nodes: {
            root: { children: ['a', 'b'], value: 'root' },
            a: { parentId: 'root', children: [], value: 'a' },
            b: { parentId: 'root', children: [], value: 'b' },
          },
        },
      },
    });
    const result = runtime.update(tx => {
      tx.write.mindmap.move('a', 'root', 1);
      tx.write.mindmap.move('a', 'root', 0);
    });
    expect(result.status).toBe('unchanged');
    expect(select(runtime, read => read.mindmap.children('root'))).toEqual(['a', 'b']);
  });
  it('preserves single-root tree integrity for operations and replacement snapshots', () => {
    const mindmapSchema = schema({ mindmap: tree<string>() });
    const runtime = createDocument({
      schema: mindmapSchema,
      initial: {
        mindmap: {
          rootId: 'root',
          nodes: {
            root: { children: ['a'], value: 'root' },
            a: { parentId: 'root', children: [], value: 'a' },
          },
        },
      },
    });
    const expectRejected = (operation: unknown) => {
      const result = runtime.apply([operation]);
      expect(result.status).toBe('rejected');
      expect(select(runtime, read => read.mindmap.rootId())).toBe('root');
      expect(select(runtime, read => read.mindmap.parent('a'))).toBe('root');
    };

    expectRejected({
      type: 'tree.insert',
      at: ['mindmap'],
      treeNodeId: 'orphan',
      value: 'orphan',
    });
    expectRejected({
      type: 'tree.move',
      at: ['mindmap'],
      treeNodeId: 'a',
    });
    expectRejected({
      type: 'tree.replace',
      at: ['mindmap'],
      value: {
        rootId: 'loop',
        nodes: { loop: { children: ['loop'], value: 'loop' } },
      },
    });
    const document = {
      mindmap: {
        rootId: 'loop',
        nodes: { loop: { children: ['loop'], value: 'loop' } },
      },
    };
    expect(runtime.replace(document).status).toBe('rejected');
    expect(select(runtime, read => read.mindmap.children('root'))).toEqual(['a']);

    const replacement = {
      rootId: 'next',
      nodes: { next: { children: [] as string[], value: 'next' } },
    };
    expect(
      runtime.apply([{ type: 'tree.replace', at: ['mindmap'], value: replacement }]).status
    ).toBe('committed');
    replacement.nodes.next.children.push('next');
    expect(select(runtime, read => read.mindmap.children('next'))).toEqual([]);
  });
  it('allows an absent optional tree while still validating present trees', () => {
    const optionalTreeSchema = schema({
      mindmap: optional(tree<string>()),
    });
    expect(() => createDocument({ schema: optionalTreeSchema, initial: {} })).not.toThrow();
    expect(() =>
      createDocument({
        schema: optionalTreeSchema,
        initial: {
          mindmap: {
            rootId: 'loop',
            nodes: { loop: { children: ['loop'], value: 'loop' } },
          },
        },
      })
    ).toThrow('invalid tree');
  });
  it('initializes, clears, and undoes optional structured leaves', () => {
    const optionalSchema = schema({
      outline: optional(tree<string>()),
      tags: optional(list<string>({ keyOf: value => value })),
      attrs: optional(dict<string, number>()),
    });
    const runtime = createDocument({ schema: optionalSchema, initial: {} });
    const outline = {
      rootId: 'root',
      nodes: { root: { children: [], value: 'root' } },
    };
    expect(
      runtime.update(tx => {
        tx.write.outline.replace(outline);
        tx.write.tags.replace(['one', 'two']);
        tx.write.attrs.replace({ count: 2 });
      }).status
    ).toBe('committed');
    expect(select(runtime, read => read.outline.rootId())).toBe('root');
    expect(select(runtime, read => read.tags.values())).toEqual(['one', 'two']);
    expect(select(runtime, read => read.attrs.get())).toEqual({ count: 2 });

    expect(
      runtime.update(tx => {
        tx.write.outline.clear();
        tx.write.tags.clear();
        tx.write.attrs.clear();
      }).status
    ).toBe('committed');
    expect(select(runtime, read => read.outline.rootId())).toBeUndefined();
    expect(select(runtime, read => read.tags.values())).toEqual([]);
    expect(select(runtime, read => read.attrs.get())).toBeUndefined();
    expect(runtime.history.undo().status).toBe('committed');
    expect(select(runtime, read => read.outline.rootId())).toBe('root');
    expect(select(runtime, read => read.tags.values())).toEqual(['one', 'two']);
    expect(select(runtime, read => read.attrs.get())).toEqual({ count: 2 });
  });
  it('reports observer errors on committed results without rolling back', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    runtime.subscribe(() => {
      throw new Error('root listener failure');
    });
    runtime.subscribe(
      projectSchema.value(path => path.title),
      () => {
        throw new Error('target listener failure');
      }
    );
    const result = runtime.update(tx => tx.write.title.set('two'));
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.observerErrors).toHaveLength(2);
    expect(result.observerErrors.map(entry => entry.phase)).toEqual(['listener', 'listener']);
    expect(select(runtime, read => read.title.get())).toBe('two');
    expect(runtime.history.current()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(runtime.update(tx => tx.write.title.set('three')).status).toBe('committed');
    expect(select(runtime, read => read.title.get())).toBe('three');
  });
  it('publishes copied, frozen application diagnostics', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const address = ['title'];
    const result = runtime.update(tx => {
      tx.report({
        source: 'application',
        code: 'title-warning',
        message: 'Review the title.',
        address,
      });
      return tx.read.title.get();
    });
    address[0] = 'projects';
    expect(result.status).toBe('unchanged');
    if (result.status !== 'unchanged') return;
    expect(result.reports).toEqual([
      {
        source: 'application',
        code: 'title-warning',
        message: 'Review the title.',
        address: ['title'],
      },
    ]);
    expect(Object.isFrozen(result.reports)).toBe(true);
    expect(Object.isFrozen(result.reports[0])).toBe(true);
    expect(Object.isFrozen(result.reports[0].address)).toBe(true);
  });
  it('captures processor errors after committing and settling its recovery', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const view = createMaterializedView(runtime, {
      build: ({ read }) => ({
        value: read.title.get(),
        update: () => {
          throw new Error('processor failure');
        },
      }),
    });
    const result = runtime.update(tx => tx.write.title.set('two'));
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.observerErrors).toHaveLength(1);
    expect(result.observerErrors[0].phase).toBe('processor');
    expect(select(runtime, read => read.title.get())).toBe('two');
    expect(view.current()).toBe('two');
    view.dispose();
  });

  it('coalesces net-zero entity changes without publishing a commit', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const listener = vi.fn();
    runtime.subscribe(listener);
    const result = runtime.update(tx => {
      tx.write.projects.create({
        id: 'b',
        value: { name: 'B', archived: false },
      });
      tx.write.projects.remove('b');
    });
    expect(result.status).toBe('unchanged');
    expect(runtime.revision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(select(runtime, read => read.projects.has('b'))).toBe(false);
  });

  it('materializes collection all lazily and keeps the snapshot stable', () => {
    const runtime = createDocument({ schema: projectSchema, initial });
    const source = projectSchema.collection(path => path.projects);
    const view = createCollectionView({
      runtime,
      source,
      map: (_id, entry) => entry.name.get(),
    });
    runtime.update(tx => tx.write.projects.item('a').name.set('AA'));
    const first = view.all.current();
    expect(first).toEqual(['AA']);
    runtime.update(tx => tx.write.projects.item('a').name.set('AAA'));
    expect(view.item('a').current()).toBe('AAA');
    expect(view.all.current()).toEqual(['AAA']);
    expect(view.all.current()).toBe(view.all.current());
    view.dispose();
  });
});
