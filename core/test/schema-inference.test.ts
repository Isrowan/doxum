import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  list,
  map,
  object,
  observe,
  optional,
  table,
  tree,
  variant,
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
    const value = runtime.read(people);
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
    const collection = runtime.read(items);
    expectTypeOf(collection.get('a')).toEqualTypeOf<Model['items'][number] | undefined>();
    expectTypeOf(runtime.read(item)).toEqualTypeOf<Model['items'][number] | undefined>();
    expect(collection.get('a')?.n).toBe(1);
    expect(runtime.read(item)?.n).toBe(1);
    expect(runtime.read(plain)).toEqual([{ id: 'p', n: 2 }]);
    document.dispose();
    runtime.dispose();
  });

  it('preserves required and optional tree payload presence in Infer and tree observations', () => {
    const model = object({
      required: tree(field<number>()),
      sparse: tree(optional(field<number>())),
    });
    type Model = Infer<typeof model>;
    const requiredNode: Model['required']['nodes'][string] = { children: [], value: 1 };
    const sparseNode: Model['sparse']['nodes'][string] = { children: [] };
    expectTypeOf(requiredNode.value).toEqualTypeOf<number>();
    expectTypeOf(sparseNode.value).toEqualTypeOf<number | undefined>();

    const document = createDocument({
      schema: model,
      initial: {
        required: { rootId: 'r', nodes: { r: requiredNode } },
        sparse: { rootId: 's', nodes: { s: sparseNode } },
      },
    });
    const nodes = observe(document, path => path.required.nodes);
    const node = observe(document, path => path.required.nodes.item('r'));
    const root = observe(document, path => path.required.rootId);
    const runtime = createProjectionRuntime();
    const observedNodes: ReadonlyMap<string, Model['required']['nodes'][string]> =
      runtime.read(nodes);
    const observedNode: Model['required']['nodes'][string] | undefined = runtime.read(node);
    const observedRoot: string | undefined = runtime.read(root);
    expect(observedNodes.get('r')?.value).toBe(1);
    expect(observedNode?.value).toBe(1);
    expect(observedRoot).toBe('r');
    document.dispose();
    runtime.dispose();
  });

  it('propagates optional tree and dynamic item absence through observations and writes', () => {
    const model = object({
      maybe: optional(tree(field<number>())),
      sparse: tree(optional(field<number>())),
    });
    type Model = Infer<typeof model>;
    const document = createDocument({
      schema: model,
      initial: { sparse: { nodes: {} } },
    });
    const maybe = observe(document, path => path.maybe);
    const missing = observe(document, path => path.sparse.nodes.item('missing'));
    const runtime = createProjectionRuntime();

    expectTypeOf(runtime.read(maybe)).toEqualTypeOf<Model['maybe']>();
    expectTypeOf(runtime.read(missing)).toEqualTypeOf<
      Model['sparse']['nodes'][string] | undefined
    >();
    expect(runtime.read(maybe)).toBeUndefined();
    expect(runtime.read(missing)).toBeUndefined();

    document.update(draft => draft.sparse.insert('s', undefined));
    expect(document.snapshot().sparse.nodes.s).toEqual({ children: [], value: undefined });
    document.dispose();
    runtime.dispose();
  });

  it('keeps container entry presence separate from optional variant member presence', () => {
    const choice = optional(
      variant('kind', {
        text: object({ value: field<string>() }),
        count: object({ value: field<number>() }),
      })
    );
    const optionalNumber = optional(field<number>());
    const model = object({
      choices: map(choice),
      orderedChoices: table(choice),
      values: map(optionalNumber),
    });
    type Model = Infer<typeof model>;

    expectTypeOf<Model['choices'][string]>().toEqualTypeOf<
      | { readonly kind: 'text'; readonly value: string }
      | { readonly kind: 'count'; readonly value: number }
    >();
    expectTypeOf<Model['orderedChoices']['byId'][string]>().toEqualTypeOf<
      | { readonly kind: 'text'; readonly value: string }
      | { readonly kind: 'count'; readonly value: number }
    >();
    expectTypeOf<Model['values'][string]>().toEqualTypeOf<number | undefined>();
  });
});
