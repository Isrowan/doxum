import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  object,
  observe,
} from 'doxum';

describe('projection value boundaries', () => {
  it('keeps scalar values outside borrowed access scopes', () => {
    const model = object({ value: field<number>() });
    const document = createDocument({ schema: model, initial: { value: 1 } });
    const root = observe(document);
    const value = derive({ root }, ({ root }) => root.value);
    const runtime = createProjectionRuntime();
    expect(runtime.read(value)).toBe(1);
    document.update(draft => {
      draft.value = 2;
    });
    expect(runtime.read(value)).toBe(2);
    document.dispose();
    runtime.dispose();
  });

  it('uses input equality before publishing a downstream value', () => {
    const source = input({ value: 1 }, (left, right) => left.value === right.value);
    const result = derive({ source }, ({ source }) => source.value);
    const runtime = createProjectionRuntime();
    const listener = vi.fn();
    runtime.read(result);
    const stop = runtime.select(result).subscribe(listener);
    runtime.update(source, { value: 1 });
    expect(listener).not.toHaveBeenCalled();
    stop();
    runtime.dispose();
  });
});

describe('validator boundaries', () => {
  it('accepts predicate and assertion validators without replacing canonical input', () => {
    function assertNumber(value: unknown): asserts value is number {
      if (typeof value !== 'number') throw new TypeError('Expected number.');
    }
    const schema = object({
      asserted: field<number>(assertNumber),
      positive: field<number>((value): value is number => typeof value === 'number' && value >= 0),
    });
    const document = createDocument({ schema, initial: { asserted: 1, positive: 2 } });
    expect(document.snapshot()).toEqual({ asserted: 1, positive: 2 });
    document.dispose();
    expect(() => createDocument({ schema, initial: { asserted: 1, positive: -1 } })).toThrow(
      'Value validation failed'
    );
  });

  it('rejects function and Standard Schema validators that attempt to transform input', () => {
    const functionSchema = object({
      value: field<number>(((value: unknown) => value) as never),
    });
    expect(() => createDocument({ schema: functionSchema, initial: { value: 1 } })).toThrow(
      'Function validators must return boolean or undefined'
    );

    const standardSchema = object({
      value: field<number>({
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (_value: unknown) => ({ value: 2 }),
        },
      }),
    });
    expect(() => createDocument({ schema: standardSchema, initial: { value: 1 } })).toThrow(
      'Validators must not transform values'
    );
  });
});
