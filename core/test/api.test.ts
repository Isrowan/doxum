import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  map,
  object,
  observe,
  table,
} from '../src';

const task = object({ title: field<string>(), done: field<boolean>() });
const model = object({ title: field<string>(), tasks: map(task), ordered: table(task) });

const documentFor = () =>
  createDocument({
    schema: model,
    initial: {
      title: 'Launch',
      tasks: { a: { title: 'Write', done: false }, b: { title: 'Review', done: true } },
      ordered: { ids: ['a'], byId: { a: { title: 'Write', done: false } } },
    },
  });

describe('final projection API', () => {
  it('keeps input definitions runtime-local and composes named dependencies', () => {
    const n = input(1);
    const doubled = derive({ n }, ({ n }) => n * 2);
    const first = createProjectionRuntime();
    const second = createProjectionRuntime();

    expect(first.read(doubled)).toBe(2);
    expect(second.read(doubled)).toBe(2);
    first.update(n, 3);
    expect(first.read(doubled)).toBe(6);
    expect(second.read(doubled)).toBe(2);

    first.dispose();
    second.dispose();
  });

  it('observes document collections as immutable map-like values', () => {
    const document = documentFor();
    const rows = observe(document, path => path.tasks);
    const filter = input('open' as 'open' | 'done');
    const visible = derive({ rows, filter }, ({ rows: tasks, filter: state }) => {
      const result = new Map<string, { readonly title: string; readonly done: boolean }>();
      for (const [id, value] of tasks)
        if ((state === 'open' && !value.done) || (state === 'done' && value.done))
          result.set(id, value);
      return result;
    });
    const runtime = createProjectionRuntime();

    const current = runtime.read(rows);
    expect(current.size).toBe(2);
    expect(current.get('a')?.title).toBe('Write');
    expect([...current.keys()]).toEqual(['a', 'b']);
    expect('set' in current).toBe(false);
    expect(runtime.read(visible).size).toBe(1);

    runtime.update(filter, 'done');
    expect([...runtime.read(visible).keys()]).toEqual(['b']);
    document.dispose();
    runtime.dispose();
  });

  it('supports whole-document snapshots and readable bridges', () => {
    const document = documentFor();
    const snapshot = observe(document);
    const title = derive({ snapshot }, ({ snapshot }) => snapshot.title);
    const directTitle = observe(document, path => path.title);
    const runtime = createProjectionRuntime();
    expect(runtime.read(title)).toBe('Launch');
    expect(runtime.read(directTitle)).toBe('Launch');
    document.update(draft => {
      draft.title = 'Done';
    });
    expect(runtime.read(title)).toBe('Done');
    expect(runtime.read(directTitle)).toBe('Done');
    runtime.dispose();
    document.dispose();
  });

  it('publishes one invalidation for a batch and keeps listener failures outside writes', () => {
    const value = input(1);
    const doubled = derive({ value }, ({ value }) => value * 2);
    const runtime = createProjectionRuntime({ onError: () => undefined });
    const listener = vi.fn(() => {
      throw new Error('observer');
    });
    runtime.read(doubled);
    const stop = runtime.select(doubled).subscribe(listener);
    runtime.batch(
      () => {
        runtime.update(value, 2);
        runtime.update(value, 3);
      },
      { cause: { action: 'edit' } }
    );
    expect(runtime.read(doubled)).toBe(6);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    runtime.dispose();
  });

  it('accepts the final callback-first batch contract', () => {
    const runtime = createProjectionRuntime();
    expect(runtime.batch(() => 42, { cause: 'typed' })).toBe(42);
    if (false) {
      // @ts-expect-error options-first batch is not part of the public contract
      runtime.batch({ cause: 'legacy' }, () => undefined);
    }
    runtime.dispose();
  });
});
