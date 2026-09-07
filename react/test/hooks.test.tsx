import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createDocument, createProjectionRuntime, field, object, schema, table } from 'doxum';
import { useDocumentSelector, useReadable } from '../src';
import { renderToString } from 'react-dom/server';

const documentSchema = schema({
  title: field<string>(),
  count: field<number>(),
});
const text = (value: unknown) => React.createElement('span', null, String(value));
const valueOf = (renderer: ReactTestRenderer) => renderer.root.findByType('span').children.join('');

describe('doxum/react', () => {
  it('surfaces projection faults to an error boundary and reads recovered values after reset', () => {
    const projection = createProjectionRuntime({ onError: () => undefined });
    const input = projection.input(0);
    let fail = false;
    const value = projection.value({
      sources: { input: input.source },
      build: ({ input }) => {
        if (fail) throw new Error('build failed');
        return {
          value: input.value,
          update: ({ input }) => {
            if (fail) throw new Error('update failed');
            return { kind: 'changed', value: input.value };
          },
        };
      },
    });
    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? text('fault') : this.props.children;
      }
    }
    function Probe() {
      return text(useReadable(value));
    }
    const tree = (key: number) =>
      React.createElement(Boundary, { key, children: React.createElement(Probe) });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(tree(0));
    });
    fail = true;
    act(() => input.set(1));
    expect(valueOf(renderer)).toBe('fault');
    fail = false;
    act(() => {
      value.rebuild();
      renderer.update(tree(1));
    });
    expect(valueOf(renderer)).toBe('1');
    act(() => renderer.unmount());
    projection.dispose();
  });
  it('renders keyed projection items precisely and leaves ownership with the service', () => {
    const model = schema({ rows: table(object({ label: field<string>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { rows: { ids: ['a', 'b'], byId: { a: { label: 'A' }, b: { label: 'B' } } } },
    });
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const rows = projection.map(
      projection.document(runtime).collection(path => path.rows),
      (_id, row) => row.label.get()
    );
    let renders = 0;
    function Probe() {
      renders++;
      return text(useReadable(rows.item('a')));
    }
    expect(renderToString(React.createElement(Probe))).toContain('A');
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const baseline = renders;
    act(() => {
      runtime.update(tx => tx.write.rows.item('b').label.set('BB'));
    });
    expect(renders).toBe(baseline);
    act(() => {
      projection.batch(() => {
        runtime.update(tx => tx.write.rows.item('a').label.set('AA'));
        runtime.update(tx => tx.write.rows.item('a').label.set('AAA'));
      });
    });
    expect(valueOf(renderer)).toBe('AAA');
    expect(renders).toBe(baseline + 1);
    act(() => renderer.unmount());
    runtime.update(tx => tx.write.rows.item('a').label.set('after unmount'));
    expect(rows.item('a').current()).toBe('after unmount');
    expect(renders).toBe(baseline + 1);
    projection.dispose();
    runtime.dispose();
  });
  it('tracks selector dependencies and ignores unrelated commits', () => {
    const runtime = createDocument({
      schema: documentSchema,
      initial: { title: 'one', count: 0 },
    });
    let renders = 0;
    function Probe() {
      renders += 1;
      return text(useDocumentSelector(runtime, read => read.title.get()));
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const initialRenders = renders;
    act(() => {
      runtime.update(tx => tx.write.count.set(1));
    });
    expect(valueOf(renderer)).toBe('one');
    expect(renders).toBe(initialRenders);
    act(() => {
      runtime.update(tx => tx.write.title.set('two'));
    });
    expect(valueOf(renderer)).toBe('two');
    expect(renders).toBe(initialRenders + 1);
    renderer.unmount();
  });
  it('reinstalls dynamic selector dependencies', () => {
    const runtime = createDocument({
      schema: documentSchema,
      initial: { title: 'one', count: 0 },
    });
    let renders = 0;
    function Probe() {
      renders += 1;
      return text(
        useDocumentSelector(runtime, read => {
          const count = read.count.get();
          return count > 0 ? read.title.get() : String(count);
        })
      );
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const initialRenders = renders;

    act(() => {
      runtime.update(tx => tx.write.title.set('ignored'));
    });
    expect(valueOf(renderer)).toBe('0');
    expect(renders).toBe(initialRenders);

    act(() => {
      runtime.update(tx => tx.write.count.set(1));
    });
    expect(valueOf(renderer)).toBe('ignored');
    expect(renders).toBe(initialRenders + 1);

    act(() => {
      runtime.update(tx => tx.write.title.set('observed'));
    });
    expect(valueOf(renderer)).toBe('observed');
    expect(renders).toBe(initialRenders + 2);

    act(() => {
      runtime.update(tx => tx.write.count.set(0));
    });
    expect(valueOf(renderer)).toBe('0');
    expect(renders).toBe(initialRenders + 3);

    act(() => {
      runtime.update(tx => tx.write.title.set('ignored again'));
    });
    expect(valueOf(renderer)).toBe('0');
    expect(renders).toBe(initialRenders + 3);
    renderer.unmount();
  });
  it('works in StrictMode', () => {
    const runtime = createDocument({
      schema: documentSchema,
      initial: { title: 'one', count: 0 },
    });
    function Probe() {
      return text(useDocumentSelector(runtime, read => read.title.get()));
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(StrictMode, null, React.createElement(Probe)));
    });
    act(() => {
      runtime.update(tx => tx.write.title.set('two'));
    });
    expect(valueOf(renderer)).toBe('two');
    renderer.unmount();
  });
});
