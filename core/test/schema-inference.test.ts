import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
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
});
