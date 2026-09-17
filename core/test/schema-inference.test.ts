import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  list,
  map,
  object,
  observe,
  type Infer,
} from '../src';

describe('projection schema inference', () => {
  it('infers observed collection values from the schema', () => {
    const person = object({ name: field<string>() });
    const model = object({ people: map(person) });
    type Model = Infer<typeof model>;
    const document = createDocument({ schema: model, initial: { people: { a: { name: 'A' } } } });
    const people = observe(document, path => path.people);
    const runtime = createProjectionRuntime();
    const value = runtime.get(people);
    expectTypeOf(value.get('a')).toEqualTypeOf<Model['people'][string] | undefined>();
    expect(value.get('a')?.name).toBe('A');
    document.dispose();
    runtime.dispose();
  });

  it('infers keyed list observations as collection projections', () => {
    const model = object({
      items: list(field<{ id: string; n: number }>(), { keyOf: item => item.id }),
      plain: field<readonly { id: string; n: number }[]>(),
    });
    type Model = Infer<typeof model>;
    const document = createDocument({
      schema: model,
      initial: { items: [{ id: 'a', n: 1 }], plain: [{ id: 'p', n: 2 }] },
    });
    const items = observe(document, path => path.items);
    const item = observe(document, path => path.items.item('a'));
    const plain = observe(document, path => path.plain);
    const runtime = createProjectionRuntime();
    const collection = runtime.get(items);
    expectTypeOf(collection.get('a')).toEqualTypeOf<Model['items'][number] | undefined>();
    expectTypeOf(runtime.get(item)).toEqualTypeOf<Model['items'][number]>();
    expect(collection.get('a')?.n).toBe(1);
    expect(runtime.get(item).n).toBe(1);
    expect(runtime.get(plain)).toEqual([{ id: 'p', n: 2 }]);
    document.dispose();
    runtime.dispose();
  });
});
