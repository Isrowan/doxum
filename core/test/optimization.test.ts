import { describe, expect, it } from 'vitest';
import { createDocument, createProjectionRuntime, field, list, map, object, observe } from '../src';
import { measureProfile } from '../src/profile';

describe('projection optimization boundaries', () => {
  it('preserves stable references for unchanged collection entries', () => {
    const row = object({ value: field<number>() });
    const model = object({ rows: map(row) });
    const document = createDocument({
      schema: model,
      initial: { rows: { a: { value: 1 }, b: { value: 2 } } },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const before = runtime.get(rows);
    const stable = before.get('a');
    document.update(draft => {
      draft.rows.get('b')!.value = 3;
    });
    const after = runtime.get(rows);
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
    runtime.get(rows);

    const update = measureProfile(() =>
      document.update(draft => draft.rows.replace('row-500', { id: 'row-500', value: 2_000 }))
    ).profile;
    expect(update.collectionView.mappedItems).toBe(1);
    expect(update.collectionView.idsScanned).toBe(0);
    expect(update.access.snapshots).toBeLessThanOrEqual(2);

    const move = measureProfile(() =>
      document.update(draft => draft.rows.move('row-500', { at: 'start' }))
    ).profile;
    expect(move.collectionView.mappedItems).toBe(0);
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
});
