import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  object,
  observe,
} from '../src';

describe('projection value boundaries', () => {
  it('keeps scalar values outside borrowed access scopes', () => {
    const model = object({ value: field<number>() });
    const document = createDocument({ schema: model, initial: { value: 1 } });
    const root = observe(document);
    const value = derive([root], snapshot => snapshot.value);
    const runtime = createProjectionRuntime();
    expect(runtime.get(value)).toBe(1);
    document.update(draft => {
      draft.value = 2;
    });
    expect(runtime.get(value)).toBe(2);
    document.dispose();
    runtime.dispose();
  });

  it('uses input equality before publishing a downstream value', () => {
    const source = input({ value: 1 }, (left, right) => left.value === right.value);
    const result = derive([source], current => current.value);
    const runtime = createProjectionRuntime();
    const listener = vi.fn();
    runtime.get(result);
    const stop = runtime.readable(result).subscribe(listener);
    runtime.set(source, { value: 1 });
    expect(listener).not.toHaveBeenCalled();
    stop();
    runtime.dispose();
  });
});
