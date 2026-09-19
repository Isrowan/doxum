import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  field,
  input,
  list,
  map,
  object,
  observe,
  derive,
} from 'doxum';
import { ProjectionProvider, useDocumentSelector, useInput, useProjection } from '../src';

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

  it('tracks keyed list selectors with the same collection semantics', () => {
    const model = object({
      rows: list(field<{ id: string; value: number }>(), { keyOf: row => row.id }),
    });
    const document = createDocument({
      schema: model,
      initial: {
        rows: [
          { id: 'a', value: 1 },
          { id: 'b', value: 2 },
        ],
      },
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
    const initialRenders = renders;
    act(() => {
      document.update(draft => draft.rows.replace('b', { id: 'b', value: 3 }));
    });
    expect(renders).toBe(initialRenders);
    act(() => {
      document.update(draft => draft.rows.replace('a', { id: 'a', value: 4 }));
    });
    expect(renders).toBe(initialRenders + 1);
    expect(renderer.toJSON()).toMatchObject({ children: ['4'] });
    renderer.unmount();
    document.dispose();
    runtime.dispose();
  });

  it('reads and writes a scope-owned projection through the same provider', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const count = scope.input(1);
    const doubled = scope.derive([count], value => value * 2);
    let setCount!: (value: number) => void;
    const Probe = () => {
      const [value, set] = useInput(count);
      setCount = set;
      return React.createElement('span', null, `${value}:${useProjection(doubled)}`);
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(ProjectionProvider, { value: scope }, React.createElement(Probe))
      );
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['1:2'] });
    act(() => setCount(3));
    expect(renderer.toJSON()).toMatchObject({ children: ['3:6'] });
    act(() => renderer.unmount());
    scope.dispose();
    runtime.dispose();
  });
});

describe('document React adapter', () => {
  it('delegates dynamic selector dependencies to the Core readable', () => {
    const schema = object({
      useA: field<boolean>(),
      a: field<number>(),
      b: field<number>(),
    });
    const document = createDocument({
      schema,
      initial: { useA: true, a: 1, b: 2 },
    });
    let renders = 0;
    const Probe = () => {
      renders += 1;
      const value = useDocumentSelector(document, state => (state.useA ? state.a : state.b));
      return React.createElement('span', null, String(value));
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const initialRenders = renders;
    expect(renderer.toJSON()).toMatchObject({ children: ['1'] });

    act(() => {
      document.update(draft => {
        draft.b = 3;
      });
    });
    expect(renders).toBe(initialRenders);

    act(() => {
      document.update(draft => {
        draft.useA = false;
      });
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['3'] });
    expect(renders).toBe(initialRenders + 1);

    act(() => {
      document.update(draft => {
        draft.a = 4;
      });
    });
    expect(renders).toBe(initialRenders + 1);

    act(() => {
      document.update(draft => {
        draft.b = 5;
      });
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['5'] });
    expect(renders).toBe(initialRenders + 2);

    act(() => renderer.unmount());
    document.dispose();
  });
});
