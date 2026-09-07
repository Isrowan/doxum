import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createDocument,
  dict,
  field,
  list,
  map,
  object,
  optional,
  schema,
  select,
  table,
  tree,
  variant,
  type DocumentTreeValue,
  type DocumentWriter,
  type Infer,
  type ValueSelector,
} from 'doxum';

const outcome = variant('kind', {
  victory: object({ reason: field<'sealed' | 'destroyed'>() }),
  defeat: object({ reason: field<'deadline' | 'collapse'>() }),
});
type Outcome = Infer<typeof outcome>;
type ExpectedOutcome =
  | { readonly kind: 'victory'; readonly reason: 'sealed' | 'destroyed' }
  | { readonly kind: 'defeat'; readonly reason: 'deadline' | 'collapse' };

declare const brand: unique symbol;
type EntityId = string & { readonly [brand]: 'entity' };
type Payload = { left: string } & { right: number };
type Callback = ((id: EntityId) => Payload) & { label: string };

describe('schema value inference', () => {
  it('flattens each discriminated branch and preserves narrowing and readonly fields', () => {
    expectTypeOf<Outcome>().toEqualTypeOf<ExpectedOutcome>();
    expectTypeOf<Extract<Outcome, { kind: 'victory' }>>().toEqualTypeOf<{
      readonly kind: 'victory';
      readonly reason: 'sealed' | 'destroyed';
    }>();

    const check = (value: Outcome) => {
      if (value.kind === 'victory') {
        expectTypeOf(value.reason).toEqualTypeOf<'sealed' | 'destroyed'>();
        // @ts-expect-error A discriminant is readonly, including when assigning the same tag.
        value.kind = 'victory';
        // @ts-expect-error Schema-generated properties are readonly.
        value.reason = 'sealed';
      } else {
        expectTypeOf(value.reason).toEqualTypeOf<'deadline' | 'collapse'>();
      }
      // @ts-expect-error A defeat reason cannot be paired with the victory tag.
      const invalid: Outcome = { kind: 'victory', reason: 'deadline' };
      return invalid;
    };
    void check;
  });

  it('uses one inference entry for schemas and nodes, including nested collections', () => {
    const entry = object({ title: field<string>(), note: optional(field<string>()) });
    const model = schema({
      details: object({ outcome, entry }),
      outcomes: table(outcome),
      entries: map(entry),
      empty: object({}),
    });
    type Entry = { readonly title: string; readonly note?: string };
    expectTypeOf<Infer<typeof entry>>().toEqualTypeOf<Entry>();
    expectTypeOf<Infer<typeof model>>().toEqualTypeOf<{
      readonly details: { readonly outcome: ExpectedOutcome; readonly entry: Entry };
      readonly outcomes: {
        readonly ids: readonly string[];
        readonly byId: Readonly<Record<string, ExpectedOutcome>>;
      };
      readonly entries: Readonly<Record<string, Entry>>;
      readonly empty: {};
    }>();
    const emptyBranch = variant('status', { empty: object({}), ready: entry });
    expectTypeOf<Infer<typeof emptyBranch>>().toEqualTypeOf<
      | { readonly status: 'empty' }
      | { readonly status: 'ready'; readonly title: string; readonly note?: string }
    >();
    const flags = object({ enabled: optional(field<boolean>()) });
    expectTypeOf<Infer<typeof flags>>().toEqualTypeOf<{ readonly enabled?: boolean }>();
    expectTypeOf<Infer<typeof entry | typeof outcome>>().toEqualTypeOf<Entry | ExpectedOutcome>();
    // @ts-expect-error Infer accepts schema nodes and schemas, not raw shapes or arbitrary values.
    expectTypeOf<Infer<{ title: string }>>().toEqualTypeOf<never>();
  });

  it('preserves opaque user types inside fields and scalar containers', () => {
    const id = field<EntityId>();
    const payload = field<Payload>();
    const callback = field<Callback>();
    const tuple = field<readonly [EntityId, Payload?]>();
    const date = field<Date>();
    const unknownValue = field<unknown>();
    const impossible = field<never>();
    const model = schema({ id, payload, callback, tuple, date });
    expectTypeOf<Infer<typeof id>>().toEqualTypeOf<EntityId>();
    expectTypeOf<Infer<typeof payload>>().toEqualTypeOf<Payload>();
    expectTypeOf<Infer<typeof callback>>().toEqualTypeOf<Callback>();
    expectTypeOf<Infer<typeof tuple>>().toEqualTypeOf<readonly [EntityId, Payload?]>();
    expectTypeOf<Infer<typeof date>>().toEqualTypeOf<Date>();
    expectTypeOf<Infer<typeof unknownValue>>().toEqualTypeOf<unknown>();
    expectTypeOf<Infer<typeof impossible>>().toEqualTypeOf<never>();
    expectTypeOf<Infer<typeof model>>().toEqualTypeOf<{
      readonly id: EntityId;
      readonly payload: Payload;
      readonly callback: Callback;
      readonly tuple: readonly [EntityId, Payload?];
      readonly date: Date;
    }>();
    const values = dict<'left' | 'right', Payload>();
    const rows = list<Payload>({ keyOf: value => value.left });
    const outline = tree<Payload>();
    expectTypeOf<Infer<typeof values>>().toEqualTypeOf<
      Readonly<Partial<Record<'left' | 'right', Payload>>>
    >();
    expectTypeOf<Infer<typeof rows>>().toEqualTypeOf<readonly Payload[]>();
    expectTypeOf<Infer<typeof outline>>().toEqualTypeOf<DocumentTreeValue<Payload>>();
  });

  it('represents absence for every optional node without making required fields optional', () => {
    const note = optional(field<string>());
    const result = optional(outcome);
    const values = optional(dict<'count', number>());
    const rows = optional(list<string>({ keyOf: value => value }));
    const outline = optional(tree<string>());
    const model = schema({ title: field<string>(), note, result, values, rows, outline });
    expectTypeOf<Infer<typeof note>>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Infer<typeof result>>().toEqualTypeOf<ExpectedOutcome | undefined>();
    expectTypeOf<Infer<typeof values>>().toEqualTypeOf<{ readonly count?: number } | undefined>();
    expectTypeOf<Infer<typeof rows>>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<Infer<typeof outline>>().toEqualTypeOf<DocumentTreeValue<string> | undefined>();
    expectTypeOf<Infer<typeof model>>().toEqualTypeOf<{
      readonly title: string;
      readonly note?: string;
      readonly result?: ExpectedOutcome;
      readonly values?: { readonly count?: number };
      readonly rows?: readonly string[];
      readonly outline?: DocumentTreeValue<string>;
    }>();
    // @ts-expect-error Required schema fields must remain required.
    const missing: Infer<typeof model> = {};
    void missing;
  });

  it('aligns snapshot, reader, writer and selector types with optional variant presence', () => {
    const result = optional(outcome);
    const model = schema({ result });
    const runtime = createDocument({ schema: model, initial: {} });
    expectTypeOf(runtime.snapshot()).toEqualTypeOf<Infer<typeof model>>();
    expectTypeOf(model.value(path => path.result)).toEqualTypeOf<
      ValueSelector<Infer<typeof result>>
    >();
    const read = () => select(runtime, reader => reader.result.get());
    expectTypeOf(read()).toEqualTypeOf<Infer<typeof result>>();
    expect(read()).toBeUndefined();
    runtime.update(tx => {
      expectTypeOf(tx.write.result.replace).parameter(0).toEqualTypeOf<Outcome>();
      tx.write.result.replace({ kind: 'victory', reason: 'sealed' });
    });
    expect(read()).toEqual({ kind: 'victory', reason: 'sealed' });
    runtime.update(tx => tx.write.result.clear());
    expect(read()).toBeUndefined();
    runtime.dispose();
  });

  it('requires present variant values for replacement and collection creation', () => {
    const result = optional(outcome);
    const model = schema({ result, rows: table(result), entries: map(result) });
    type Entry = { readonly id: string; readonly value: ExpectedOutcome };
    type Writer = DocumentWriter<typeof model>;
    expectTypeOf<Writer['rows']['create']>().parameter(0).toEqualTypeOf<Entry | readonly Entry[]>();
    expectTypeOf<Writer['entries']['create']>()
      .parameter(0)
      .toEqualTypeOf<Entry | readonly Entry[]>();
    expectTypeOf<Infer<typeof model>['rows']['byId'][string]>().toEqualTypeOf<ExpectedOutcome>();
    expectTypeOf<Infer<typeof model>['entries'][string]>().toEqualTypeOf<ExpectedOutcome>();
    const check = (write: Writer) => {
      // @ts-expect-error Clearing an optional variant requires clear().
      write.result.replace(undefined);
      // @ts-expect-error Collection creation requires a present entry value.
      write.rows.create({ id: 'missing', value: undefined });
      // @ts-expect-error A map entry also requires a present value.
      write.entries.create({ id: 'missing', value: undefined });
    };
    void check;
  });
});
