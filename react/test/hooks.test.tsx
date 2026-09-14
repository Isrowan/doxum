import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  input,
  map,
  object,
  observe,
  derive,
} from 'doxum';
import { ProjectionProvider, useInput, useProjection } from '../src';

describe('projection React adapter', () => {
  it('uses the same hook for values, selectors, and inputs', () => {
    const source = input(1);
    const doubled = derive([source], value => value * 2);
    const runtime = createProjectionRuntime();
    let setValue!: (value: number) => void;
    const Probe = () => {
      const [value, set] = useInput(source);
      setValue = set;
      return React.createElement('span', null, `${value}:${useProjection(doubled)}`);
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(ProjectionProvider, { value: runtime }, React.createElement(Probe))
      );
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['1:2'] });
    act(() => setValue(3));
    expect(renderer.toJSON()).toMatchObject({ children: ['3:6'] });
    renderer.unmount();
    runtime.dispose();
  });

  it('tracks keyed collection selectors at the consumer boundary', () => {
    const row = object({ value: field<number>() });
    const model = object({ rows: map(row) });
    const document = createDocument({
      schema: model,
      initial: { rows: { a: { value: 1 }, b: { value: 2 } } },
    });
    const rows = observe(document, path => path.rows);
    const runtime = createProjectionRuntime();
    let renders = 0;
    const Probe = () => {
      renders += 1;
      return React.createElement(
        'span',
        null,
        String(useProjection(rows, value => value.get('a')?.value))
      );
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(ProjectionProvider, { value: runtime }, React.createElement(Probe))
      );
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['1'] });
    const initialRenders = renders;
    act(() => {
      document.update(draft => {
        draft.rows.get('b')!.value = 3;
      });
    });
    expect(renders).toBe(initialRenders);
    act(() => {
      document.update(draft => {
        draft.rows.get('a')!.value = 4;
      });
    });
    expect(renders).toBe(initialRenders + 1);
    renderer.unmount();
    document.dispose();
    runtime.dispose();
  });
});
