import { defineProcessor } from '@/projection/definition';
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
  ProjectionDisposedError,
  type Projection,
  select,
} from 'doxum';
import { addListener } from '@/subscription';

const noop = () => undefined;

describe('projection owner shutdown', () => {
  it('runs child callbacks before parent callbacks in LIFO order while the entire graph is readable', () => {
    const runtime = createProjectionRuntime();
    const first = runtime.scope();
    const second = runtime.scope();
    const value = input(1);
    const local = first.own(derive({ value }, ({ value }) => value * 2));
    const readable = first.select(local);
    const events: string[] = [];
    first.onDispose(() => {
      events.push(`first:${readable.current()}`);
      first.dispose();
    });
    second.onDispose(() => events.push(`second:${first.read(local)}`));
    runtime.onDispose(() => events.push(`root-early:${first.read(local)}`));
    runtime.onDispose(() => {
      events.push(`root-late:${runtime.read(value)}`);
      runtime.dispose();
      second.dispose();
    });
    const listener = vi.fn();
    const stop = readable.subscribe(listener);
    runtime.batch(() => {
      runtime.update(value, 3);
      runtime.dispose();
    });
    expect(events).toEqual(['second:6', 'first:6', 'root-late:3', 'root-early:6']);
    expect(listener).not.toHaveBeenCalled();
    expect(() => {
      runtime.dispose();
      first.dispose();
      second.dispose();
      stop();
      stop();
    }).not.toThrow();
    expect(() => readable.current()).toThrow(ProjectionDisposedError);
  });

  it('cancels one callback registration without cancelling another registration of the same callback', () => {
    const runtime = createProjectionRuntime();
    const callback = vi.fn();
    const cancel = runtime.onDispose(callback);
    cancel();
    runtime.onDispose(callback);
    cancel();
    const skipped = vi.fn();
    const cancelSkipped = runtime.onDispose(skipped);
    runtime.onDispose(cancelSkipped);
    runtime.dispose();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
    expect(() => {
      cancel();
      cancelSkipped();
      runtime.dispose();
    }).not.toThrow();
  });

  it('rejects commands, new resources and implicit processor reads in the cleanup window', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const value = input(1);
    const rows = input.collection(new Map([['a', 1]]));
    const readable = runtime.select(value);
    const localReadable = scope.select(value);
    const items = runtime.items(rows);
    const item = items.get('a');
    const cancel = readable.subscribe(noop);
    scope.onDispose(() => {
      expect(readable.current()).toBe(1);
      expect(item.current()).toBe(1);
      expect(items.keys.current()).toEqual(['a']);
      for (const command of [
        () => runtime.update(value, 2),
        () => scope.update(value, 2),
        () => runtime.batch(noop),
        () => scope.batch(noop),
        () => runtime.scope(),
        () => scope.own(input(2)),
        () => runtime.select(value),
        () => scope.select(value),
        () => runtime.items(rows),
        () => items.get('a'),
        () => readable.subscribe(noop),
        () => localReadable.subscribe(noop),
        () => items.keys.subscribe(noop),
        () => item.subscribe(noop),
        () => runtime.onDispose(noop),
        () => scope.onDispose(noop),
      ])
        expect(command).toThrow('cleanup');
      cancel();
      cancel();
      const illegal = derive({}, () => runtime.read(value));
      expect(() => runtime.read(illegal)).toThrow('re-entered');
    });
    runtime.dispose();
  });

  it('allows lazy cleanup reads and balances document write guards even when connections are created during cleanup', () => {
    const document = createDocument({ schema: object({ n: field<number>() }), initial: { n: 1 } });
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const source = scope.own(observe(document, p => p.n));
    const stop = scope.onDispose(() => {
      expect(scope.read(source)).toBe(1);
      expect(() =>
        document.update(d => {
          d.n = 2;
        })
      ).toThrow();
      expect(() => runtime.batch(noop)).toThrow('cleanup');
    });
    scope.dispose();
    expect(() => stop()).not.toThrow();
    expect(
      document.update(d => {
        d.n = 3;
      }).status
    ).toBe('committed');
    const root = observe(document, p => p.n);
    expect(runtime.read(root)).toBe(3);
    runtime.onDispose(() => {
      expect(runtime.read(root)).toBe(3);
      expect(() =>
        document.update(d => {
          d.n = 4;
        })
      ).toThrow();
    });
    runtime.dispose();
    expect(
      document.update(d => {
        d.n = 5;
      }).status
    ).toBe('committed');
    document.dispose();
  });

  it('fully releases scopes and sources after callback and teardown failures, without retrying them', () => {
    const runtime = createProjectionRuntime();
    const first = runtime.scope();
    const second = runtime.scope();
    const firstError = new Error('callback failed');
    const lastError = new Error('source stop failed');
    const events: string[] = [];
    const value = input(1);
    const stop = vi.fn(() => {
      events.push('source stop');
      runtime.dispose();
      expect(() => runtime.read(value)).toThrow(ProjectionDisposedError);
      throw lastError;
    });
    const source = first.own(
      observe({ current: () => 1, revision: () => 0, subscribe: () => stop })
    );
    first.read(source);
    first.onDispose(() => {
      events.push('first');
      throw firstError;
    });
    second.onDispose(() => events.push('second'));
    runtime.onDispose(() => events.push('root'));
    expect(() => runtime.dispose()).toThrow(AggregateError);
    expect(events).toEqual(['second', 'first', 'root', 'source stop']);
    expect(() => {
      runtime.dispose();
      first.dispose();
      second.dispose();
    }).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => runtime.read(value)).toThrow(ProjectionDisposedError);
  });

  it('releases consumers before shared dependencies and source connections even when a release fails', () => {
    const runtime = createProjectionRuntime();
    const events: string[] = [];
    const failure = new Error('processor release');
    const source = observe({
      current: () => 1,
      revision: () => 0,
      subscribe: () => () => {
        events.push('source');
      },
    });
    const make = (name: string, dependencies: readonly Projection<unknown>[]) =>
      defineProcessor({
        dependencies,
        outputs: [{ kind: 'value', equality: Object.is }],
        create: () => ({
          evaluate: ({ outputs }) => {
            const output = outputs[0];
            if (output.kind === 'value') output.output.set(1);
          },
          release: () => {
            events.push(name);
            expect(() => runtime.read(source)).toThrow(ProjectionDisposedError);
            if (name === 'second') throw failure;
          },
        }),
      })[0];
    const shared = make('shared', [source]);
    runtime.read(make('first', [shared]));
    runtime.read(make('second', [shared]));
    runtime.onDispose(() => {
      expect(runtime.read(shared)).toBe(1);
      events.push('cleanup');
    });
    expect(() => runtime.dispose()).toThrow(failure);
    expect(events).toEqual(['cleanup', 'second', 'first', 'shared', 'source']);
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('finishes a failed standalone scope while leaving its parent usable', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const value = scope.own(input(1));
    const failure = new Error('scope cleanup');
    const after = vi.fn();
    scope.onDispose(after);
    scope.onDispose(() => {
      expect(scope.read(value)).toBe(1);
      throw failure;
    });
    expect(() => scope.dispose()).toThrow(failure);
    expect(after).toHaveBeenCalledTimes(1);
    expect(() => scope.dispose()).not.toThrow();
    expect(() => scope.read(value)).toThrow(ProjectionDisposedError);
    const root = input(2);
    runtime.update(root, 3);
    expect(runtime.read(root)).toBe(3);
    runtime.dispose();
  });

  it('rejects asynchronous cleanup at runtime and still runs the remaining callbacks', () => {
    const runtime = createProjectionRuntime();
    const after = vi.fn();
    runtime.onDispose(after);
    runtime.onDispose((() => Promise.resolve()) as never);
    expect(() => runtime.dispose()).toThrow('synchronous');
    expect(after).toHaveBeenCalledTimes(1);
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('rejects initial disposal during processing and notification without starting shutdown', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const cleanup = vi.fn();
    runtime.onDispose(cleanup);
    const value = input(1);
    const computed = derive({ value }, ({ value }) => {
      expect(() => runtime.dispose()).toThrow('re-entered');
      expect(() => scope.dispose()).toThrow('re-entered');
      return value;
    });
    const stop = runtime.select(computed).subscribe(() => {
      expect(() => runtime.dispose()).toThrow('re-entered');
      expect(() => scope.dispose()).toThrow('re-entered');
    });
    runtime.update(value, 2);
    expect(cleanup).not.toHaveBeenCalled();
    expect(runtime.read(computed)).toBe(2);
    stop();
    runtime.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps all ordinary access strict after parent disposal', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const rows = input.collection(new Map([['a', 1]]));
    const view = scope.read(rows);
    const readable = runtime.select(rows);
    const scoped = scope.select(rows);
    const items = runtime.items(rows);
    const member = items.get('a');
    runtime.dispose();
    for (const owner of [runtime, scope]) {
      expect(() => owner.read(rows)).toThrow(ProjectionDisposedError);
      expect(() => owner.update(rows, noop)).toThrow(ProjectionDisposedError);
      expect(() => owner.batch(noop)).toThrow(ProjectionDisposedError);
      expect(() => owner.select(rows)).toThrow(ProjectionDisposedError);
      expect(() => owner.items(rows)).toThrow(ProjectionDisposedError);
      expect(() => owner.onDispose(noop)).toThrow(ProjectionDisposedError);
    }
    expect(() => runtime.scope()).toThrow(ProjectionDisposedError);
    expect(() => scope.own(input(1))).toThrow(ProjectionDisposedError);
    expect(() => view.get('a')).toThrow(ProjectionDisposedError);
    for (const handle of [readable, scoped, items.keys, member]) {
      expect(() => handle.current()).toThrow(ProjectionDisposedError);
      expect(() => handle.revision()).toThrow(ProjectionDisposedError);
      expect(() => handle.subscribe(noop)).toThrow(ProjectionDisposedError);
    }
    expect(() => items.get('a')).toThrow(ProjectionDisposedError);
  });
});

describe('independent subscription registrations', () => {
  it.each([
    'direct',
    'selector',
    'scope',
    'item',
    'keys',
    'document',
    'document-selector',
    'document-filter',
    'history',
  ] as const)('isolates repeated callback registrations and stale unsubscribe for %s', kind => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const source = input.collection(new Map([['a', 0]]));
    const document = createDocument({
      schema: object({ n: field<number>(), rows: map(field<number>()) }),
      initial: { n: 0, rows: {} },
    });
    const items = runtime.items(source);
    const handles = {
      direct: runtime.select(source),
      selector: runtime.select(source, values => values.get('a')),
      scope: scope.select(source, values => values.get('a')),
      item: items.get('a'),
      keys: items.keys,
      document,
      'document-filter': {
        subscribe: (listener: () => void) => document.subscribe(p => p.n, listener),
      },
      'document-selector': select(document, read => read.n),
      history: document.history,
    };
    const handle = handles[kind];
    let tick = 0;
    const update = () => {
      tick++;
      if (kind.startsWith('document') || kind === 'history')
        document.update(d => {
          d.n = tick;
        });
      else
        runtime.update(source, d => {
          d.set('a', tick);
          d.set(`extra-${tick}`, tick);
        });
    };
    const listener = vi.fn();
    const old = handle.subscribe(listener);
    old();
    const current = handle.subscribe(listener);
    old();
    update();
    expect(listener).toHaveBeenCalledTimes(1);
    const duplicate = handle.subscribe(listener);
    update();
    expect(listener).toHaveBeenCalledTimes(3);
    current();
    current();
    update();
    expect(listener).toHaveBeenCalledTimes(4);
    duplicate();
    duplicate();
    update();
    expect(listener).toHaveBeenCalledTimes(4);
    runtime.dispose();
    document.dispose();
    expect(() => {
      old();
      current();
      duplicate();
      scope.dispose();
    }).not.toThrow();
  });

  it('consumes a registration before a failing release and preserves later registrations', () => {
    const listeners = new Set<() => void>();
    const listener = vi.fn();
    const failure = new Error('release');
    const release = vi.fn(() => {
      throw failure;
    });
    const stop = addListener(listeners, listener, release);
    expect(() => stop()).toThrow(failure);
    const next = addListener(listeners, listener);
    expect(() => stop()).not.toThrow();
    for (const callback of listeners) callback();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    next();
  });
});
