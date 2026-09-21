import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  list,
  map,
  object,
  observe,
  tree,
} from 'doxum';
import { incremental } from 'doxum/advanced';
import { measureProfile } from '@/profile';

describe('projection optimization boundaries', () => {
  it('reorders a keyed subset without restaging unchanged values', () => {
    const rows = input.collection(
      new Map(
        Array.from({ length: 1_000 }, (_, index) => [`row-${index}`, { value: index }] as const)
      )
    );
    const selected = input<readonly string[]>(
      Array.from({ length: 500 }, (_, index) => `row-${index}`)
    );
    const subset = derive.keyed.subset(rows, selected);
    const runtime = createProjectionRuntime();
    runtime.read(subset);

    const reordered = Array.from({ length: 500 }, (_, index) => `row-${499 - index}`);
    const reorder = measureProfile(() => runtime.update(selected, reordered)).profile;
    expect(reorder.projection.touchedKeys).toBe(0);
    expect(reorder.projection.changedKeys).toBe(0);
    expect([...runtime.read(subset).keys()]).toEqual(reordered);

    const changedMembership = ['row-500', ...reordered.slice(0, -1)];
    const membership = measureProfile(() => runtime.update(selected, changedMembership)).profile;
    expect(membership.projection.touchedKeys).toBe(2);
    expect(membership.projection.changedKeys).toBe(2);
    expect([...runtime.read(subset).keys()]).toEqual(changedMembership);
    runtime.dispose();
  });

  it('preserves stable references for unchanged collection entries', () => {
    const row = object({ value: field<number>() });
    const model = object({ rows: map(row) });
    const document = createDocument({
      schema: model,
      initial: { rows: { a: { value: 1 }, b: { value: 2 } } },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const before = runtime.read(rows);
    const stable = before.get('a');
    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });
    const after = runtime.read(rows);
    expect(after.get('a')).toBe(stable);
    expect(after.get('b')?.value).toBe(3);
    document.dispose();
    runtime.dispose();
  });

  it('updates one observed list item without rescanning collection values', () => {
    const model = object({
      rows: list(field<{ id: string; value: number }>(), { keyOf: row => row.id }),
    });
    const document = createDocument({
      schema: model,
      initial: {
        rows: Array.from({ length: 1_000 }, (_, index) => ({ id: `row-${index}`, value: index })),
      },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    runtime.read(rows);

    const update = measureProfile(() =>
      document.update(draft => draft.rows.replace('row-500', { id: 'row-500', value: 2_000 }))
    ).profile;
    expect(update.collectionView.mappedItems).toBe(1);
    expect(update.collectionView.idsScanned).toBe(0);
    expect(update.collectionIndex.builds).toBe(0);
    expect(update.collectionIndex.nodes).toBeGreaterThan(0);
    expect(update.collectionIndex.nodes).toBeLessThan(100);
    expect(update.access.snapshots).toBeLessThanOrEqual(2);

    const move = measureProfile(() =>
      document.update(draft => draft.rows.move('row-500', { at: 'start' }))
    ).profile;
    expect(move.collectionView.mappedItems).toBe(0);
    expect(move.collectionIndex.nodes).toBe(0);
    expect(move.access.snapshots).toBe(0);

    const reorderedIds = Array.from({ length: 1_000 }, (_, index) => `row-${999 - index}`);
    const reorder = measureProfile(() =>
      document.update(draft => draft.rows.reorder(reorderedIds))
    ).profile;
    expect(reorder.collectionView.mappedItems).toBe(0);
    expect(reorder.access.snapshots).toBe(0);

    document.dispose();
    runtime.dispose();
  });

  it('materializes one tree node without rebuilding unchanged node structures', () => {
    const outline = tree(field<number>());
    const board = object({ title: field<string>(), outline });
    const model = object({ boards: map(board) });
    const count = 1_024;
    const nodes = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `node-${index}`,
        index === 0
          ? {
              children: Array.from({ length: count - 1 }, (_, child) => `node-${child + 1}`),
              value: 0,
            }
          : { parentId: 'node-0', children: [], value: index },
      ])
    );
    const document = createDocument({
      schema: model,
      initial: { boards: { board: { title: 'Board', outline: { rootId: 'node-0', nodes } } } },
    });
    const boards = observe(document, path => path.boards);
    const treeNodes = observe(document, path => path.boards.item('board').outline.nodes);
    const runtime = createProjectionRuntime();
    const beforeBoard = runtime.read(boards).get('board')!;
    const beforeNodes = runtime.read(treeNodes);
    const stableBoardNode = beforeBoard.outline.nodes['node-1'];
    const stableCollectionNode = beforeNodes.get('node-1');

    const measured = measureProfile(() =>
      document.update(draft => draft.boards.get('board')!.outline.replace('node-512', 9_999))
    ).profile;
    const afterBoard = runtime.read(boards).get('board')!;
    const afterNodes = runtime.read(treeNodes);
    expect(afterBoard.outline.nodes['node-1']).toBe(stableBoardNode);
    expect(afterBoard.outline.nodes['node-512']).not.toBe(beforeBoard.outline.nodes['node-512']);
    expect(afterNodes.get('node-1')).toBe(stableCollectionNode);
    expect(afterNodes.get('node-512')?.value).toBe(9_999);
    expect(measured.collectionView.mappedItems).toBe(2);
    expect(measured.collectionView.idsScanned).toBe(0);
    expect(measured.copy.treeNodes).toBeLessThan(10);

    document.dispose();
    runtime.dispose();
  });

  it('keeps special tree node keys as own properties in aggregate projections', () => {
    const model = object({ outline: tree(field<number>()) });
    const document = createDocument({ schema: model, initial: { outline: { nodes: {} } } });
    const outline = observe(document, path => path.outline);
    const nodes = observe(document, path => path.outline.nodes);
    const runtime = createProjectionRuntime();
    runtime.read(outline);
    runtime.read(nodes);

    document.update(draft => draft.outline.insert('__proto__', 42));

    const canonical = document.snapshot().outline.nodes;
    const aggregate = runtime.read(outline).nodes;
    const keyed = runtime.read(nodes);
    expect(Object.hasOwn(canonical, '__proto__')).toBe(true);
    expect(Object.hasOwn(aggregate, '__proto__')).toBe(true);
    expect(aggregate.__proto__).toEqual({ children: [], value: 42 });
    expect(Object.getPrototypeOf(aggregate)).toBe(Object.prototype);
    expect(keyed.get('__proto__')).toEqual({ children: [], value: 42 });

    document.dispose();
    runtime.dispose();
  });

  it('folds tree updates that return to the published value inside one projection batch', () => {
    const model = object({
      outline: tree(field<number>()),
    });
    const document = createDocument({
      schema: model,
      initial: { outline: { rootId: 'r', nodes: { r: { children: [], value: 1 } } } },
    });
    const outline = observe(document, path => path.outline);
    const nodes = observe(document, path => path.outline.nodes);
    const runtime = createProjectionRuntime();
    const beforeOutline = runtime.read(outline);
    const beforeNode = runtime.read(nodes).get('r');
    let notifications = 0;
    const stop = runtime.select(outline).subscribe(() => notifications++);

    runtime.batch(() => {
      document.update(draft => draft.outline.replace('r', 2));
      expect(runtime.read(outline)).toBe(beforeOutline);
      document.update(draft => draft.outline.replace('r', 1));
      expect(runtime.read(outline)).toBe(beforeOutline);
    });

    expect(runtime.read(outline)).toBe(beforeOutline);
    expect(runtime.read(nodes).get('r')).toBe(beforeNode);
    expect(notifications).toBe(0);
    stop();
    document.dispose();
    runtime.dispose();
  });

  it('keeps native tree-node work separate from aggregate record copying', () => {
    const count = 1_024;
    const schema = object({ outline: tree(field<number>()) });
    const initial = () => ({
      outline: {
        rootId: 'node-0',
        nodes: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `node-${index}`,
            index === 0
              ? {
                  children: Array.from({ length: count - 1 }, (_, child) => `node-${child + 1}`),
                  value: 0,
                }
              : { parentId: 'node-0', children: [], value: index },
          ])
        ),
      },
    });

    const nativeDocument = createDocument({ schema, initial: initial() });
    const nativeRuntime = createProjectionRuntime();
    const native = observe(nativeDocument, path => path.outline.nodes);
    nativeRuntime.read(native);
    const nativeProfile = measureProfile(() =>
      nativeDocument.update(draft => draft.outline.replace('node-512', 9_999))
    ).profile;
    expect(nativeProfile.collectionView.idsScanned).toBe(0);
    expect(nativeProfile.copy.shallowRecordItems).toBe(0);

    const aggregateDocument = createDocument({ schema, initial: initial() });
    const aggregateRuntime = createProjectionRuntime();
    const aggregate = observe(aggregateDocument, path => path.outline);
    aggregateRuntime.read(aggregate);
    const aggregateProfile = measureProfile(() =>
      aggregateDocument.update(draft => draft.outline.replace('node-512', 9_999))
    ).profile;
    expect(aggregateProfile.copy.shallowRecordItems).toBeGreaterThanOrEqual(count);

    nativeDocument.dispose();
    nativeRuntime.dispose();
    aggregateDocument.dispose();
    aggregateRuntime.dispose();
  });

  it('routes plural keyed invalidation in proportion to affected bindings', () => {
    const count = 1_000;
    const drivers = input.collection(
      new Map(
        Array.from({ length: count }, (_, index) => [
          `driver-${index}`,
          { sourceIds: [`source-${index}`] as readonly string[] },
        ])
      )
    );
    const sources = input.collection(
      new Map(Array.from({ length: count }, (_, index) => [`source-${index}`, index]))
    );
    let deriveCalls = 0;
    let incrementalCalls = 0;
    const pure = derive.keyed(
      drivers,
      { sources: { source: sources, keys: driver => driver.sourceIds } },
      (_driver, _key, dependencies) => {
        deriveCalls++;
        return [...dependencies.sources.values()][0];
      }
    );
    const retained = incremental.keyed(
      drivers,
      { sources: { source: sources, keys: driver => driver.sourceIds } },
      {
        process: ({ dependencies }) => {
          incrementalCalls++;
          return [...dependencies.sources.values()][0];
        },
      }
    );
    const runtime = createProjectionRuntime();
    runtime.read(pure);
    runtime.read(retained);
    deriveCalls = 0;
    incrementalCalls = 0;

    runtime.update(sources, draft => draft.set('source-500', 5_000));
    expect(deriveCalls).toBe(1);
    expect(incrementalCalls).toBe(1);
    expect(runtime.read(pure).get('driver-500')).toBe(5_000);
    expect(runtime.read(retained).get('driver-500')).toBe(5_000);
    runtime.dispose();
  });

  it('fans one keyed item update only to that cached readable', () => {
    const count = 1_000;
    const rows = input.collection(
      new Map(Array.from({ length: count }, (_, index) => [`row-${index}`, index]))
    );
    const runtime = createProjectionRuntime();
    const items = runtime.items(rows);
    const notifications = Array.from({ length: count }, () => 0);
    for (let index = 0; index < count; index++)
      items.get(`row-${index}`).subscribe(() => notifications[index]++);

    runtime.update(rows, draft => draft.set('row-500', 5_000));
    expect(notifications.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(notifications[500]).toBe(1);
    runtime.dispose();
  });

  it('reuses all unrelated entry tuples on a value-only keyed update', () => {
    const count = 1_000;
    const rows = input.collection(
      new Map(Array.from({ length: count }, (_, index) => [`row-${index}`, { value: index }]))
    );
    const entries = derive.keyed.entries(rows);
    const runtime = createProjectionRuntime();
    const before = runtime.read(entries);
    runtime.update(rows, draft => draft.set('row-500', { value: 5_000 }));
    const after = runtime.read(entries);
    for (let index = 0; index < count; index++)
      if (index === 500) expect(after[index]).not.toBe(before[index]);
      else expect(after[index]).toBe(before[index]);
    runtime.dispose();
  });
});
