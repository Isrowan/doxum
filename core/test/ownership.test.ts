import { describe, expect, it } from 'vitest';
import { createDocument, createProjectionRuntime, field, map, object, observe } from '../src';

describe('projection ownership', () => {
  it('returns immutable snapshots rather than borrowed document readers', () => {
    const row = object({ title: field<string>() });
    const model = object({ rows: map(row) });
    const document = createDocument({ schema: model, initial: { rows: { a: { title: 'A' } } } });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    const value = runtime.get(rows).get('a');
    expect(value).toEqual({ title: 'A' });
    document.update(draft => {
      draft.rows.get('a')!.title = 'B';
    });
    expect(value).toEqual({ title: 'A' });
    document.dispose();
    runtime.dispose();
  });
});
