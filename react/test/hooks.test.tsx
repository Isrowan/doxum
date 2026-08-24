import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createDocument, field, object, schema } from '@doxa/core';
import { useDocumentSelector } from '../src';

const documentSchema = schema({
  title: field<string>(),
  count: field<number>(),
});
const text = (value: unknown) => React.createElement('span', null, String(value));
const valueOf = (renderer: ReactTestRenderer) => renderer.root.findByType('span').children.join('');

describe('@doxa/react', () => {
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
