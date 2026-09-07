import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  asReadable,
  createDocument,
  createProjectionRuntime,
  field,
  object,
  schema,
  table,
  type ProjectionRuntime,
  type ProjectionError,
  type CollectionImpact,
  type ProjectionCollectionWriter,
} from '../src';
import { projectionDebug } from '../src/integration';
import { startProfile } from '../src/profile';

const model = schema({
  title: field<string>(),
  items: table(object({ value: field<number>(), group: field<string>() })),
});
const initial = () => ({
  title: 'one',
  items: { ids: ['a', 'b'], byId: { a: { value: 1, group: 'x' }, b: { value: 2, group: 'y' } } },
});
const owners: ProjectionRuntime[] = [];
const setup = () => {
  const errors: ProjectionError[] = [];
  const projection = createProjectionRuntime({ onError: error => errors.push(error) });
  owners.push(projection);
  const runtime = createDocument({ schema: model, initial: initial() });
  const document = projection.document(runtime);
  const source = document.collection(path => path.items);
  return { projection, runtime, document, source, errors };
};
afterEach(() => {
  owners.splice(0).forEach(owner => owner.dispose());
});

describe('projection source and value', () => {
  it('binds schema paths once, caches identity and shares one document subscription', () => {
    const { projection, runtime, document, source } = setup();
    const pick = vi.fn((path: Parameters<Parameters<typeof model.collection>[0]>[0]) => path.items);
    expect(document.collection(pick)).toBe(source);
    const selected = document.targets(model.collection(path => path.items));
    expect(document.targets(model.collection(path => path.items))).toBe(selected);
    expect(document.collection(path => path.items)).toBe(source);
    expect(projection.document(asReadable(runtime))).toBe(document);
    const view = projection.map(source, (_id, entry) => entry.value.get());
    expectTypeOf(view.item('a').current()).toEqualTypeOf<number | undefined>();
    runtime.update(tx => tx.write.items.item('a').value.set(5));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(projectionDebug(projection).subscriptions).toBe(1);
    expect(() =>
      document.collection(path => {
        // @ts-expect-error A field is not a collection path.
        const invalid: Parameters<typeof document.collection>[0] = p => p.title;
        void invalid;
        return path.items;
      })
    ).not.toThrow();
  });

  it('keeps readers scoped and skips unrelated collection commits', () => {
    const { projection, runtime, source } = setup();
    let saved: { get(): number } | undefined;
    const mapper = vi.fn((_id: string, entry: { value: { get(): number } }) => {
      saved = entry.value;
      return entry.value.get();
    });
    projection.map(source, mapper);
    expect(() => saved!.get()).toThrow('no longer active');
    runtime.update(tx => tx.write.title.set('two'));
    expect(mapper).toHaveBeenCalledTimes(2);
  });

  it('uses explicit targets and preserves output references and revisions on equality', () => {
    const { projection, runtime, document } = setup();
    const update = vi.fn(({ document }: { document: { read: { title: { get(): string } } } }) => ({
      kind: 'changed' as const,
      value: { title: document.read.title.get() },
    }));
    const value = projection.value({
      sources: { document: document.targets(model.value(path => path.title)) },
      build: ({ document }) => ({ value: { title: document.read.title.get() }, update }),
      isEqual: (a, b) => a.title === b.title,
    });
    const before = value.current();
    const listener = vi.fn();
    value.subscribe(listener);
    runtime.update(tx => tx.write.items.item('a').value.set(3));
    expect(update).not.toHaveBeenCalled();
    expect(value.revision()).toBe(0);
    value.rebuild();
    expect(value.current()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    runtime.update(tx => tx.write.title.set('two'));
    expect(value.current()).toEqual({ title: 'two' });
    expect(value.revision()).toBe(1);
  });

  it('settles a diamond once before listeners and supports document plus upstream dependencies', () => {
    const { projection, runtime, document, source } = setup();
    const mapped = projection.map(source, (_id, entry) => entry.value.get());
    const count = projection.value({
      sources: { mapped },
      build: ({ mapped }) => ({
        value: mapped.ids().length,
        update: ({ mapped }) => ({ kind: 'changed', value: mapped.ids().length }),
      }),
    });
    const update = vi.fn(({ mapped, count, document }) => ({
      kind: 'changed' as const,
      value: `${count.value}:${mapped.get('a')}:${document.read.title.get()}`,
    }));
    const summary = projection.value({
      sources: { mapped, count, document },
      build: inputs => ({
        value: `${inputs.count.value}:${inputs.mapped.get('a')}:${inputs.document.read.title.get()}`,
        update,
      }),
    });
    const seen: string[] = [];
    mapped.subscribe(() => seen.push(summary.current()));
    count.subscribe(() => seen.push(summary.current()));
    runtime.update(tx => {
      tx.write.items.create({ id: 'c', value: { value: 3, group: 'x' } });
      tx.write.items.item('a').value.set(10);
    });
    expect(summary.current()).toBe('3:10:one');
    expect(update).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['3:10:one', '3:10:one']);
  });

  it('settles every graph before starting graph listeners', () => {
    const { projection, runtime, source } = setup();
    const other = createProjectionRuntime({ onError: () => undefined });
    owners.push(other);
    const a = projection.map(source, (_id, entry) => entry.value.get());
    const b = other.map(
      other.document(runtime).collection(path => path.items),
      (_id, entry) => entry.value.get()
    );
    a.subscribe(() => expect(b.item('a').current()).toBe(9));
    const result = runtime.update(tx => tx.write.items.item('a').value.set(9));
    expect(result.status === 'committed' && result.observerErrors).toEqual([]);
  });

  it('accepts external readables without owning them and suppresses equal input', () => {
    const { projection } = setup();
    let current = { width: 5 };
    let revision = 0;
    const listeners = new Set<() => void>();
    const source = projection.fromReadable(
      {
        current: () => current,
        revision: () => revision,
        subscribe: listener => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      { isEqual: (a, b) => a.width === b.width }
    );
    const update = vi.fn(({ size }: { size: { value: { width: number } } }) => ({
      kind: 'changed' as const,
      value: size.value.width,
    }));
    const value = projection.value({
      sources: { size: source },
      build: ({ size }) => ({ value: size.value.width, update }),
    });
    current = { width: 5 };
    revision++;
    listeners.forEach(listener => listener());
    expect(update).not.toHaveBeenCalled();
    current = { width: 10 };
    revision++;
    listeners.forEach(listener => listener());
    expect(value.current()).toBe(10);
    projection.dispose();
    expect(listeners.size).toBe(0);
  });

  it('rejects foreign sources, invalid schema targets and reads after disposal', () => {
    const { projection, runtime, document, source } = setup();
    const other = createProjectionRuntime({ onError: () => undefined });
    owners.push(other);
    expect(() => other.map(source, () => 0)).toThrow('foreign');
    expect(() =>
      document.targets(schema({ title: field<string>() }).value(path => path.title))
    ).toThrow('another schema');
    const value = projection.map(source, (_id, entry) => entry.value.get());
    expect(() => other.fromReadable(value.all)).toThrow();
    projection.dispose();
    expect(() => value.ids.current()).toThrow('disposed');
    expect(() => projection.document(runtime)).toThrow('disposed');
  });
});

describe('projection collection publication', () => {
  it('emits exact keys, lazy all, stable ids and item handles', () => {
    const { projection, runtime, source } = setup();
    const mapped = projection.map(source, (_id, entry) => ({ value: entry.value.get() }), {
      isEqual: (a, b) => a.value === b.value,
    });
    const ids = mapped.ids.current();
    const item = mapped.item('a');
    const before = item.current();
    const changes: CollectionImpact<string>[] = [];
    const bRevision = mapped.item('b').revision();
    mapped.subscribe(change => changes.push(change));
    expect(mapped.item('a')).toBe(item);
    runtime.update(tx => tx.write.items.item('a').group.set('z'));
    expect(item.current()).toBe(before);
    expect(changes).toEqual([]);
    expect(mapped.revision()).toBe(0);
    const profile = startProfile();
    runtime.update(tx => tx.write.items.item('a').value.set(3));
    expect(profile.snapshot().collectionView.arraysCopied).toBe(0);
    expect(mapped.ids.current()).toBe(ids);
    expect(mapped.ids.revision()).toBe(0);
    expect(mapped.item('b').revision()).toBe(bRevision);
    expect(mapped.all.current()).toBe(mapped.all.current());
    expect(profile.stop().collectionView.arraysCopied).toBe(1);
    expect(changes[0].kind).toBe('incremental');
    if (changes[0].kind === 'incremental') {
      expect([...changes[0].updated]).toEqual(['a']);
      expect('add' in changes[0].updated).toBe(false);
    }
  });

  it('preserves order without remapping items and reports removal', () => {
    const { projection, runtime, source } = setup();
    const mapper = vi.fn((_id: string, entry: { value: { get(): number } }) => entry.value.get());
    const view = projection.map(source, mapper);
    const removed = vi.fn();
    view.item('a').subscribe(removed);
    runtime.update(tx => tx.write.items.move('b', { before: 'a' }));
    expect(view.ids.current()).toEqual(['b', 'a']);
    expect(mapper).toHaveBeenCalledTimes(2);
    runtime.update(tx => tx.write.items.remove('a'));
    expect(view.item('a').current()).toBeUndefined();
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('stages net-zero writes, undefined presence, order and replacement equality', () => {
    const { projection } = setup();
    const input = projection.input(0);
    let writer: ProjectionCollectionWriter<string, number | undefined> | undefined;
    const collection = projection.collection({
      sources: { input: input.source },
      isEqual: (a: number | undefined, b) => Object.is(a, b),
      build: ({ writer: output }) => {
        output.set('a', 1);
        output.set('b', undefined);
        return {
          update: ({ writer: output, previous, next, sources }) => {
            writer = output;
            expect(previous.get('a')).toBe(1);
            output.set('a', 2);
            expect(next.get('a')).toBe(2);
            expect(previous.get('a')).toBe(1);
            if (sources.input.value === 1) {
              output.remove('a');
              output.set('a', 1);
              output.remove('missing');
            } else if (sources.input.value === 2)
              output.replace([
                ['a', 1],
                ['b', undefined],
              ]);
            else {
              output.set('a', 1);
              output.order(['b', 'a']);
            }
          },
        };
      },
    });
    const notify = vi.fn();
    collection.subscribe(notify);
    input.set(1);
    input.set(2);
    expect(notify).not.toHaveBeenCalled();
    expect(collection.revision()).toBe(0);
    expect(collection.ids.current()).toEqual(['a', 'b']);
    expect(() => writer!.set('a', 4)).toThrow('no longer active');
    input.set(3);
    expect(collection.ids.current()).toEqual(['b', 'a']);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not expose partially mapped output when a structural update fails', () => {
    const { projection, runtime, source, errors } = setup();
    let fail = true;
    const view = projection.map(source, (id, entry) => {
      if (id === 'd' && fail) throw new Error('map failure');
      return entry.value.get();
    });
    const unchangedItem = view.item('a');
    const recovered = vi.fn();
    unchangedItem.subscribe(recovered);
    const result = runtime.update(tx => {
      tx.write.items.create({ id: 'c', value: { value: 3, group: 'z' } });
      tx.write.items.create({ id: 'd', value: { value: 4, group: 'z' } });
    });
    expect(result.status).toBe('committed');
    expect(errors).toHaveLength(2);
    expect(() => view.ids.current()).toThrow('Projection');
    expect(() => view.item('c')).toThrow('Projection');
    fail = false;
    view.rebuild();
    expect(view.ids.current()).toEqual(['a', 'b', 'c', 'd']);
    expect(view.all.current()).toEqual([1, 2, 3, 4]);
    expect(unchangedItem.current()).toBe(1);
    expect(recovered).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed order or duplicate keys before publishing and recovers once', () => {
    const { projection, errors } = setup();
    const input = projection.input(0);
    const view = projection.collection({
      sources: { input: input.source },
      isEqual: (a: number, b) => a === b,
      build: ({ writer }) => {
        writer.set('a', 1);
        return {
          update: ({ writer, sources }) => {
            writer.set('a', 9);
            if (sources.input.value === 1) writer.order(['missing']);
            else
              writer.replace([
                ['a', 1],
                ['a', 2],
              ]);
          },
        };
      },
    });
    input.set(1);
    expect(view.item('a').current()).toBe(1);
    input.set(2);
    expect(view.item('a').current()).toBe(1);
    expect(errors).toHaveLength(2);
  });

  it('isolates every collection listener failure', () => {
    const { projection, runtime, source } = setup();
    const view = projection.map(source, (_id, entry) => entry.value.get());
    const later = vi.fn();
    const item = vi.fn();
    view.all.subscribe(() => {
      throw new Error('listener');
    });
    view.all.subscribe(later);
    view.item('a').subscribe(item);
    const result = runtime.update(tx => tx.write.items.item('a').value.set(3));
    expect(later).toHaveBeenCalledTimes(1);
    expect(item).toHaveBeenCalledTimes(1);
    expect(result.status === 'committed' && result.observerErrors.length).toBe(1);
  });
});

describe('batch, recovery and lifecycle', () => {
  it('batches remote apply, replace, another document and boundary input together', () => {
    const { projection, runtime, document } = setup();
    const sessionSchema = schema({ selected: field<string>() });
    const editor = createDocument({ schema: sessionSchema, initial: { selected: 'a' } });
    const session = projection.document(editor);
    const viewport = projection.input(1);
    const view = projection.value({
      sources: { document, session, viewport: viewport.source },
      build: ({ document, session, viewport }) => ({
        value: `${document.read.title.get()}:${session.read.selected.get()}:${viewport.value}`,
        update: ({ document, session, viewport }) => ({
          kind: 'changed',
          value: `${document.read.title.get()}:${session.read.selected.get()}:${viewport.value}`,
        }),
      }),
    });
    const listener = vi.fn();
    view.subscribe(listener);
    projection.batch(() => {
      runtime.apply([{ type: 'field.set', at: ['title'], value: 'remote' }], { source: 'remote' });
      runtime.replace({ ...initial(), title: 'replacement' });
      editor.update(tx => tx.write.selected.set('b'));
      viewport.set(2);
    });
    expect(view.current()).toBe('replacement:b:2');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('discards equality failures and notifies retained equal items on recovery', () => {
    const { projection, runtime, source } = setup();
    const view = projection.map(source, (_id, item) => item.value.get(), {
      isEqual: (a, b) => {
        if (b === 9) throw new Error('equality');
        return a === b;
      },
    });
    const stable = view.item('b');
    const notify = vi.fn();
    stable.subscribe(notify);
    runtime.update(tx => tx.write.items.item('a').value.set(9));
    expect(() => stable.current()).toThrow();
    runtime.update(tx => tx.write.items.item('a').value.set(10));
    expect(stable.current()).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(stable.revision()).toBe(0);
  });

  it('reports external read failures and recovers when the source becomes readable again', () => {
    const { projection, errors } = setup();
    let receive = () => {};
    let fail = false;
    let value = 1;
    const source = projection.fromReadable({
      current: () => {
        if (fail) throw new Error('external');
        return value;
      },
      revision: () => value,
      subscribe: listener => {
        receive = listener;
        return () => {};
      },
    });
    const view = projection.value({
      sources: { source },
      build: ({ source }) => ({
        value: source.value,
        update: ({ source }) => ({ kind: 'changed', value: source.value }),
      }),
    });
    fail = true;
    receive();
    expect(() => view.current()).toThrow();
    expect(errors.at(-1)?.phase).toBe('source');
    fail = false;
    value = 2;
    receive();
    expect(view.current()).toBe(2);
  });

  it('does not reinterpret reporter failures as external source failures', () => {
    const reporter = vi.fn(() => {
      throw new Error('reporter');
    });
    const projection = createProjectionRuntime({ onError: reporter });
    owners.push(projection);
    const input = projection.input(0);
    const view = projection.value({
      sources: { input: input.source },
      build: ({ input }) => ({
        value: input.value,
        update: () => {
          throw new Error('update');
        },
      }),
    });
    expect(() => input.set(1)).toThrow('reporter failed');
    expect(view.current()).toBe(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    const original = new Error('original');
    expect(() =>
      projection.batch(() => {
        input.set(2);
        throw original;
      })
    ).toThrow(original);
    expect(view.current()).toBe(2);
  });

  it('rejects processor and listener reentrancy without nested flushes', () => {
    const { projection, errors } = setup();
    const input = projection.input(0);
    const view = projection.value({
      sources: { input: input.source },
      build: ({ input: source }) => ({
        value: source.value,
        update: () => {
          input.set(100);
          return { kind: 'unchanged' };
        },
      }),
    });
    const later = vi.fn();
    view.subscribe(() => view.rebuild());
    view.subscribe(later);
    input.set(1);
    expect(view.current()).toBe(1);
    expect(errors).toHaveLength(2);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('cleans a failed source registration and finishes cleanup even when an external unsubscribe throws', () => {
    const { projection } = setup();
    const before = projectionDebug(projection);
    expect(() =>
      projection.fromReadable({
        current: () => 0,
        revision: () => 0,
        subscribe: () => {
          throw new Error('subscribe');
        },
      })
    ).toThrow('subscribe');
    expect(projectionDebug(projection)).toEqual(before);
    projection.fromReadable({
      current: () => 0,
      revision: () => 0,
      subscribe: () => () => {
        throw new Error('cleanup');
      },
    });
    const view = projection.value({
      sources: {},
      build: () => ({ value: 1, update: () => ({ kind: 'unchanged' }) }),
    });
    expect(() => projection.dispose()).toThrow('cleanup failed');
    expect(() => view.current()).toThrow('disposed');
    expect(projectionDebug(projection)).toEqual({
      nodes: 0,
      sources: 0,
      subscriptions: 0,
      pending: 0,
    });
  });

  it('handles a source event raised during a processor as a fault rather than reentering settlement', () => {
    const { projection } = setup();
    let receive = () => {};
    let current = 0;
    const source = projection.fromReadable({
      current: () => current,
      revision: () => current,
      subscribe: listener => {
        receive = listener;
        return () => {};
      },
    });
    const view = projection.value({
      sources: { source },
      build: ({ source }) => ({
        value: source.value,
        update: () => {
          current++;
          receive();
          return { kind: 'unchanged' };
        },
      }),
    });
    current++;
    receive();
    expect(() => view.current()).toThrow();
    receive();
    expect(view.current()).toBe(current);
  });

  it('combines document and synchronous editor cleanup, preserving ordered commits and old batch reads', () => {
    const { projection, runtime, document } = setup();
    const editor = createDocument({
      schema: schema({ selected: field<string>() }),
      initial: { selected: 'a' },
    });
    const session = projection.document(editor);
    const update = vi.fn(({ document, session }) => ({
      kind: 'changed' as const,
      value: `${document.read.items.ids().join(',')}:${session.read.selected.get()}`,
    }));
    const value = projection.value({
      sources: { document, session },
      build: () => ({ value: 'a,b:a', update }),
    });
    const listener = vi.fn();
    value.subscribe(listener);
    runtime.subscribe(() => editor.update(tx => tx.write.selected.set('')));
    projection.batch(() => {
      runtime.update(tx => tx.write.items.remove('a'));
      expect(value.current()).toBe('a,b:a');
      projection.batch(() => runtime.update(tx => tx.write.title.set('two')));
    });
    expect(value.current()).toBe('b:');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].document.commits).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flushes committed changes on callback throw and rejects async batches', () => {
    const { projection, runtime, source } = setup();
    const view = projection.map(source, (_id, entry) => entry.value.get());
    const original = new Error('command failed');
    expect(() =>
      projection.batch(() => {
        runtime.update(tx => tx.write.items.item('a').value.set(5));
        throw original;
      })
    ).toThrow(original);
    expect(view.item('a').current()).toBe(5);
    expect(() => projection.batch(() => Promise.resolve())).toThrow('synchronous');
  });

  it('coalesces net-zero mapped changes and rebuilds after reset within a batch', () => {
    const { projection, runtime, source } = setup();
    const view = projection.map(source, (_id, entry) => entry.value.get());
    const listener = vi.fn();
    view.subscribe(listener);
    projection.batch(() => {
      runtime.update(tx => tx.write.items.item('a').value.set(5));
      runtime.update(tx => tx.write.items.item('a').value.set(1));
    });
    expect(listener).not.toHaveBeenCalled();
    projection.batch(() => {
      runtime.replace({ ...initial(), title: 'reset' });
      runtime.update(tx => tx.write.items.item('b').value.set(7));
    });
    expect(view.all.current()).toEqual([1, 7]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('replaces corrupted processor instances, blocks failed descendants and recovers', () => {
    const { projection, runtime, document, errors } = setup();
    let builds = 0;
    let failBuild = false;
    const upstream = projection.value({
      sources: { document },
      build: ({ document }) => {
        builds++;
        if (failBuild) throw new Error('build');
        let privateState = document.read.title.get();
        return {
          value: privateState,
          update: () => {
            privateState = 'corrupted';
            throw new Error(privateState);
          },
        };
      },
    });
    const downstream = projection.value({
      sources: { upstream },
      build: ({ upstream }) => ({
        value: upstream.value.toUpperCase(),
        update: ({ upstream }) => ({ kind: 'changed', value: upstream.value.toUpperCase() }),
      }),
    });
    const independent = projection.map(
      document.collection(path => path.items),
      (_id, entry) => entry.value.get()
    );
    runtime.update(tx => tx.write.title.set('two'));
    expect(upstream.current()).toBe('two');
    expect(downstream.current()).toBe('TWO');
    expect(builds).toBe(2);
    expect(errors).toHaveLength(1);
    failBuild = true;
    runtime.update(tx => {
      tx.write.title.set('three');
      tx.write.items.item('a').value.set(10);
    });
    expect(() => upstream.current()).toThrow();
    expect(() => downstream.current()).toThrow();
    expect(independent.item('a').current()).toBe(10);
    failBuild = false;
    upstream.rebuild();
    expect(downstream.current()).toBe('THREE');
  });

  it('routes explicit rebuild through descendants and blocks writes during processing and notifications', () => {
    const { projection, runtime, document } = setup();
    let factor = 1;
    const upstream = projection.value({
      sources: { document },
      build: ({ document }) => ({
        value: document.read.items.get('a')!.value.get() * factor,
        update: () => ({ kind: 'unchanged' }),
      }),
    });
    const update = vi.fn(({ upstream }: { upstream: { value: number } }) => ({
      kind: 'changed' as const,
      value: upstream.value * 2,
    }));
    const downstream = projection.value({
      sources: { upstream },
      build: ({ upstream }) => ({ value: upstream.value * 2, update }),
    });
    const notify = vi.fn();
    upstream.subscribe(() => {
      expect(downstream.current()).toBe(4);
      expect(() => runtime.update(tx => tx.write.title.set('bad'))).toThrow('re-entered');
      notify();
    });
    factor = 2;
    upstream.rebuild();
    expect(downstream.current()).toBe(4);
    expect(notify).toHaveBeenCalledTimes(1);
    upstream.rebuild();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(() =>
      projection.value({
        sources: { document },
        build: () => {
          runtime.update(tx => tx.write.title.set('bad'));
          return { value: 1, update: () => ({ kind: 'unchanged' }) };
        },
      })
    ).toThrow('re-entered');
  });

  it('enforces graph disposal, invalidates retained handles and releases subscriptions', () => {
    const { projection, runtime, source } = setup();
    const mapped = projection.map(source, (_id, entry) => entry.value.get());
    const item = mapped.item('a');
    const child = projection.value({
      sources: { mapped },
      build: ({ mapped }) => ({ value: mapped.get('a'), update: () => ({ kind: 'unchanged' }) }),
    });
    expect(() => mapped.dispose()).toThrow('downstream');
    child.dispose();
    mapped.dispose();
    mapped.dispose();
    expect(() => item.current()).toThrow('disposed');
    expect(() => item.subscribe(() => undefined)).toThrow('disposed');
    projection.dispose();
    expect(projectionDebug(projection)).toEqual({
      nodes: 0,
      sources: 0,
      subscriptions: 0,
      pending: 0,
    });
    expect(() => runtime.update(tx => tx.write.title.set('two'))).not.toThrow();
  });

  it('invalidates nodes when their document is disposed', () => {
    const { projection, runtime, source } = setup();
    const view = projection.map(source, (_id, entry) => entry.value.get());
    const notify = vi.fn();
    view.all.subscribe(notify);
    runtime.dispose();
    expect(() => view.all.current()).toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not observe rejected or prepared mutations and follows undo/redo', () => {
    const { projection, runtime, source } = setup();
    const view = projection.map(source, (_id, entry) => entry.value.get());
    const notify = vi.fn();
    view.subscribe(notify);
    runtime.prepare(tx => tx.write.items.item('a').value.set(7));
    runtime.update(tx => {
      tx.write.items.item('a').value.set(7);
      tx.reject({ source: 'application', code: 'no', message: 'no' });
    });
    expect(view.item('a').current()).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    runtime.update(tx => tx.write.items.item('a').value.set(7));
    runtime.history.undo();
    expect(view.item('a').current()).toBe(1);
    runtime.history.redo();
    expect(view.item('a').current()).toBe(7);
  });
});
