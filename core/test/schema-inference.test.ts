import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  assign,
  createDocument,
  createProjectionRuntime,
  field,
  list,
  map,
  object,
  optional,
  select,
  snapshot,
  table,
  tree,
  variant,
  type CollectionImpact,
  type Draft,
  type Infer,
  type Read,
  type DocumentTreeValue,
} from '../src';
const outcome = variant('kind', {
  victory: object({ reason: field<'sealed' | 'destroyed'>() }),
  defeat: object({ reason: field<'deadline' | 'collapse'>() }),
});
type Outcome = Infer<typeof outcome>;
type PersonId = string & { readonly personId: unique symbol };
type TripId = string & { readonly tripId: unique symbol };
const personId = (value: unknown): PersonId => {
  if (typeof value !== 'string' || !value.startsWith('person:')) throw new Error('person ID');
  return value as PersonId;
};
describe('schema inference and public access', () => {
  it('flattens discriminated variants and retains narrowing', () => {
    expectTypeOf<Outcome>().toEqualTypeOf<
      | { readonly kind: 'victory'; readonly reason: 'sealed' | 'destroyed' }
      | { readonly kind: 'defeat'; readonly reason: 'deadline' | 'collapse' }
    >();
    const runtime = createDocument({
      schema: object({ outcome }),
      initial: { outcome: { kind: 'victory', reason: 'sealed' } },
    });
    runtime.update(d => {
      if (d.outcome.kind === 'victory') {
        expectTypeOf(d.outcome.reason).toEqualTypeOf<'sealed' | 'destroyed'>();
        d.outcome.reason = 'destroyed';
      }
    });
    const illegal = (d: Draft<typeof runtime.schema>) => {
      // @ts-expect-error The discriminant is readonly.
      d.outcome.kind = 'defeat';
    };
    void illegal;
  });
  it('infers optional containers and exact independent snapshots', () => {
    const settings = object({ get: field<string>(), n: field<number>() });
    const model = object({
      settings,
      outcome: optional(outcome),
      rows: optional(list(field<string>(), { keyOf: v => v })),
      outline: optional(tree(field<string>())),
    });
    expectTypeOf<Infer<typeof model>>().toEqualTypeOf<{
      readonly settings: { readonly get: string; readonly n: number };
      readonly outcome?: Outcome;
      readonly rows?: readonly string[];
      readonly outline?: DocumentTreeValue<string>;
    }>();
    const runtime = createDocument({ schema: model, initial: { settings: { get: 'G', n: 1 } } });
    expectTypeOf(select(runtime, d => snapshot(d.settings))).toEqualTypeOf<
      Infer<typeof settings>
    >();
    expectTypeOf(select(runtime, d => snapshot(d))).toEqualTypeOf<Infer<typeof model>>();
  });
  it('enforces atomic payload readonly access while preserving Infer user types', () => {
    const opaque = field<{
      n: number;
      points: { x: number }[];
      values: Map<string, { n: number }>;
    }>();
    const model = object({ payload: opaque, n: field<number>() });
    expectTypeOf<Infer<typeof opaque>>().toEqualTypeOf<{
      n: number;
      points: { x: number }[];
      values: Map<string, { n: number }>;
    }>();
    const illegal = (d: Draft<typeof model>, r: Read<typeof model>) => {
      // @ts-expect-error Atomic payload interiors cannot be drafted.
      d.payload.n++;
      // @ts-expect-error Atomic arrays cannot be pushed to.
      d.payload.points.push({ x: 1 });
      // @ts-expect-error Atomic maps cannot be modified.
      d.payload.values.set('a', { n: 1 });
      // @ts-expect-error Structural reads cannot be assigned.
      r.n = 1;
      d.payload = { n: 1, points: [], values: new Map() };
    };
    void illegal;
  });
  it('preserves domain keys across bracket access, table methods, paths, impact and projections', () => {
    const person = object({ age: field<number>() });
    const schema = object({
      people: map(person, { key: personId }),
      ordered: table(person, { key: personId }),
    });
    const runtime = createDocument({
      schema,
      initial: { people: {}, ordered: { ids: [], byId: {} } },
    });
    const id = personId('person:1');
    const result = runtime.update(d => {
      d.people[id] = { age: 1 };
      d.ordered.create({ id, value: { age: 1 } });
    });
    if (result.status !== 'committed') throw new Error('commit');
    expectTypeOf(result.commit.impact.collection(p => p.people)).toEqualTypeOf<
      CollectionImpact<PersonId>
    >();
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const view = projection.map(
      projection.document(runtime).collection(p => p.people),
      (key, value) => {
        expectTypeOf(key).toEqualTypeOf<PersonId>();
        return value.age;
      }
    );
    expectTypeOf(view.ids.current()).toEqualTypeOf<readonly PersonId[]>();
    expect(view.item(id).current()).toBe(1);
    const illegal = (d: Draft<typeof schema>, read: Read<typeof schema>, trip: TripId) => {
      // @ts-expect-error Wrong domain for indexing.
      read.people[trip];
      // @ts-expect-error Wrong domain for writes.
      d.people[trip] = { age: 1 };
      // @ts-expect-error Wrong domain for typed assignment.
      assign(d.people, trip, { age: 1 });
      // @ts-expect-error Wrong domain for table access.
      d.ordered.get(trip);
      // @ts-expect-error Wrong anchor key domain.
      d.ordered.move(id, { before: trip });
      runtime.subscribe(
        // @ts-expect-error Wrong path key domain.
        p => p.people.item(trip).age,
        () => {}
      );
      // @ts-expect-error Wrong projected item key domain.
      view.item(trip);
    };
    void illegal;
    expect(
      runtime.update(d => {
        d.people['trip:1' as PersonId] = { age: 3 };
      }).status
    ).toBe('rejected');
    projection.dispose();
  });
});
