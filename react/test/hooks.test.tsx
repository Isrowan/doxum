import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createProjectionStore,
  field,
  input,
  object,
  project,
  table,
  snapshot,
} from 'doxum';
import { ProjectionProvider, useDocumentSelector, useProjection, useReadable } from '../src';
import { renderToString } from 'react-dom/server';
const documentSchema = object({
  title: field<string>(),
  count: field<number>(),
});
const text = (value: unknown) => React.createElement('span', null, String(value));
const valueOf = (renderer: ReactTestRenderer) => renderer.root.findByType('span').children.join('');
describe('doxum/react', () => {
  it('tracks subtree snapshots and entity membership across dynamic selection', () => {
    const model = object({
      selected: field<string>(),
      rows: table(object({ n: field<number>() })),
    });
    const runtime = createDocument({
      schema: model,
      initial: { selected: 'a', rows: { ids: ['a', 'b'], byId: { a: { n: 1 }, b: { n: 2 } } } },
    });
    let renders = 0;
    function Probe() {
      renders++;
      const row = useDocumentSelector(runtime, read => {
        const item = read.rows.get(read.selected);
        return item ? snapshot(item) : undefined;
      });
      return text(row?.n ?? 'missing');
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const baseline = renders;
    act(() => {
      runtime.update(tx => (tx.rows.get('b')!.n = (n => n + 1)(tx.rows.get('b')!.n)));
    });
    expect(renders).toBe(baseline);
    act(() => {
      runtime.update(tx => (tx.selected = 'b'));
    });
    expect(valueOf(renderer)).toBe('3');
    act(() => {
      runtime.update(tx => tx.rows.remove('b'));
    });
    expect(valueOf(renderer)).toBe('missing');
    act(() => {
      runtime.history.undo();
    });
    expect(valueOf(renderer)).toBe('3');
    act(() => renderer.unmount());
    runtime.dispose();
  });
  it('caches allocating inline selectors and refreshes selector props without a document commit', () => {
    const runtime = createDocument({ schema: documentSchema, initial: { title: 'one', count: 0 } });
    let renders = 0;
    function Probe({ prefix }: { prefix: string }) {
      renders++;
      const value = useDocumentSelector(runtime, read => ({
        title: `${prefix}:${read.title}`,
      }));
      return text(value.title);
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe, { prefix: 'A' }));
    });
    expect(valueOf(renderer)).toBe('A:one');
    expect(renders).toBeLessThan(5);
    const before = renders;
    act(() => {
      runtime.update(tx => (tx.count = 1));
    });
    expect(renders).toBe(before);
    act(() => {
      renderer.update(React.createElement(Probe, { prefix: 'B' }));
    });
    expect(valueOf(renderer)).toBe('B:one');
    act(() => {
      runtime.update(tx => (tx.title = 'two'));
    });
    expect(valueOf(renderer)).toBe('B:two');
    act(() => renderer.unmount());
    runtime.dispose();
  });
  it('uses Object.is for signed zero and NaN selector notifications', () => {
    const runtime = createDocument({ schema: documentSchema, initial: { title: '', count: 0 } });
    function Probe() {
      const n = useDocumentSelector(runtime, read => read.count);
      return text(Object.is(n, -0) ? '-0' : String(n));
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    act(() => {
      runtime.update(tx => (tx.count = -0));
    });
    expect(valueOf(renderer)).toBe('-0');
    act(() => {
      runtime.update(tx => (tx.count = NaN));
    });
    expect(valueOf(renderer)).toBe('NaN');
    act(() => renderer.unmount());
    runtime.dispose();
  });
  it('surfaces projection faults to an error boundary and reads recovered values after reset', () => {
    const store = createProjectionStore({ onError: () => undefined });
    const source = input(0);
    let fail = false;
    const value = project({
      kind: 'value',
      sources: { input: source },
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
    class Boundary extends React.Component<
      {
        children: React.ReactNode;
      },
      {
        failed: boolean;
      }
    > {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? text('fault') : this.props.children;
      }
    }
    function Probe() {
      return text(useProjection(value, store));
    }
    const tree = (key: number) =>
      React.createElement(Boundary, { key, children: React.createElement(Probe) });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(tree(0));
    });
    fail = true;
    act(() => store.set(source, 1));
    expect(valueOf(renderer)).toBe('fault');
    fail = false;
    act(() => {
      store.rebuild(value);
      renderer.update(tree(1));
    });
    expect(valueOf(renderer)).toBe('1');
    act(() => renderer.unmount());
    store.dispose();
  });
  it('renders keyed projection items precisely and leaves ownership with the service', () => {
    const model = object({ rows: table(object({ label: field<string>() })) });
    const runtime = createDocument({
      schema: model,
      initial: { rows: { ids: ['a', 'b'], byId: { a: { label: 'A' }, b: { label: 'B' } } } },
    });
    const store = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const rows = project(
      runtime,
      path => path.rows,
      (_id, row) => row.label
    );
    const rowA = project({ rows }, ({ rows }) => rows.get('a'));
    let renders = 0;
    function Probe() {
      renders++;
      return text(useProjection(rowA));
    }
    const app = () =>
      React.createElement(ProjectionProvider, { value: store }, React.createElement(Probe));
    expect(renderToString(app())).toContain('A');
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(app());
    });
    const baseline = renders;
    act(() => {
      runtime.update(tx => (tx.rows.get('b')!.label = 'BB'));
    });
    expect(renders).toBe(baseline);
    act(() => {
      store.batch(() => {
        runtime.update(tx => (tx.rows.get('a')!.label = 'AA'));
        runtime.update(tx => (tx.rows.get('a')!.label = 'AAA'));
      });
    });
    expect(valueOf(renderer)).toBe('AAA');
    expect(renders).toBe(baseline + 1);
    act(() => renderer.unmount());
    runtime.update(tx => (tx.rows.get('a')!.label = 'after unmount'));
    expect(store.get(rows).get('a')).toBe('after unmount');
    expect(renders).toBe(baseline + 1);
    store.dispose();
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
      return text(useDocumentSelector(runtime, read => read.title));
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const initialRenders = renders;
    act(() => {
      runtime.update(tx => (tx.count = 1));
    });
    expect(valueOf(renderer)).toBe('one');
    expect(renders).toBe(initialRenders);
    act(() => {
      runtime.update(tx => (tx.title = 'two'));
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
          const count = read.count;
          return count > 0 ? read.title : String(count);
        })
      );
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    const initialRenders = renders;
    act(() => {
      runtime.update(tx => (tx.title = 'ignored'));
    });
    expect(valueOf(renderer)).toBe('0');
    expect(renders).toBe(initialRenders);
    act(() => {
      runtime.update(tx => (tx.count = 1));
    });
    expect(valueOf(renderer)).toBe('ignored');
    expect(renders).toBe(initialRenders + 1);
    act(() => {
      runtime.update(tx => (tx.title = 'observed'));
    });
    expect(valueOf(renderer)).toBe('observed');
    expect(renders).toBe(initialRenders + 2);
    act(() => {
      runtime.update(tx => (tx.count = 0));
    });
    expect(valueOf(renderer)).toBe('0');
    expect(renders).toBe(initialRenders + 3);
    act(() => {
      runtime.update(tx => (tx.title = 'ignored again'));
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
      return text(useDocumentSelector(runtime, read => read.title));
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(StrictMode, null, React.createElement(Probe)));
    });
    act(() => {
      runtime.update(tx => (tx.title = 'two'));
    });
    expect(valueOf(renderer)).toBe('two');
    renderer.unmount();
  });
});
