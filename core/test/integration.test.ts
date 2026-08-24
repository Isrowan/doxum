import { describe, expect, it } from 'vitest';
import { DocumentDisposedError, createDocument, field, schema } from '../src';
import { track } from '../src/integration';

describe('framework integration', () => {
  it('returns an immutable dependency snapshot within reader lifetime', () => {
    const documentSchema = schema({ title: field<string>() });
    const runtime = createDocument({
      schema: documentSchema,
      initial: { title: 'initial' },
    });
    const selection = track(runtime, read => read.title.get());
    expect(selection.value).toBe('initial');
    expect(selection.targets).toEqual([{ kind: 'value', at: ['title'] }]);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.targets)).toBe(true);

    runtime.dispose();
    expect(() => track(runtime, read => read.title.get())).toThrow(DocumentDisposedError);
  });
});
