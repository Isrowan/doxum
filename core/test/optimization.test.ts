import { describe, expect, it } from 'vitest';
import { createDocument, createProjectionRuntime, field, map, object, observe } from '../src';

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
});
