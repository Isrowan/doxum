import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  map,
  object,
  observe,
} from '../src';

describe('projection scenes', () => {
  it('composes document observation, input state, and tuple derivation', () => {
    const item = object({ done: field<boolean>() });
    const model = object({ items: map(item) });
    const document = createDocument({
      schema: model,
      initial: { items: { a: { done: false }, b: { done: true } } },
    });
    const filter = input(false);
    const items = observe(document, path => path.items);
    const visible = derive([items, filter], (all, done) => {
      const result = new Map<string, { readonly done: boolean }>();
      for (const [id, itemValue] of all) if (itemValue.done === done) result.set(id, itemValue);
      return result;
    });
    const runtime = createProjectionRuntime();
    expect([...runtime.get(visible).keys()]).toEqual(['a']);
    runtime.set(filter, true);
    expect([...runtime.get(visible).keys()]).toEqual(['b']);
    document.dispose();
    runtime.dispose();
  });
});
