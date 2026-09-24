import { describe, expect, it, vi } from 'vitest';
import { createProjectionRuntime, derive, input, ProjectionDisposedError } from 'doxum';
import { startProfile } from '@/profile';

describe('batch input reads', () => {
  it('reads current source and derived values while notifications wait for settlement', () => {
    const count = input(0);
    const target = input(0);
    const doubled = derive({ count }, ({ count }) => count * 2);
    const runtime = createProjectionRuntime();
    const readable = runtime.select(count);
    const listener = vi.fn();
    readable.subscribe(listener);
    runtime.batch(() => {
      runtime.update(count, runtime.read(count) + 1);
      runtime.update(count, runtime.read(count) + 1);
      runtime.update(target, runtime.read(count) + 10);
      expect(runtime.read(count)).toBe(2);
      expect(runtime.read(target)).toBe(12);
      expect(runtime.read(count)).toBe(2);
      expect(readable.current()).toBe(2);
      expect(runtime.read(doubled)).toBe(4); // Lazy initialization uses current dependencies.
      expect(listener).not.toHaveBeenCalled();
    });
    expect(runtime.read(doubled)).toBe(4);
    expect(runtime.read(target)).toBe(12);
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.update(count, runtime.read(count) + 1);
    expect(runtime.read(count)).toBe(3);
    runtime.dispose();
  });

  it('composes ordinary commands across nested batches and preserves successes after failure', () => {
    const count = input(0);
    const runtime = createProjectionRuntime();
    const increment = () => runtime.update(count, runtime.read(count) + 1);
    const listener = vi.fn();
    runtime.select(count).subscribe(listener);
    const failure = new Error('command failed');
    const result = runtime.batch(() => {
      expect(() =>
        runtime.batch(() => {
          increment();
          throw failure;
        })
      ).toThrow(failure);
      increment();
      expect(runtime.read(count)).toBe(2);
      expect(listener).not.toHaveBeenCalled();
      return 'done';
    });
    expect(result).toBe('done');
    expect(listener).toHaveBeenCalledTimes(1);
    increment();
    expect(runtime.read(count)).toBe(3);
    runtime.dispose();
  });

  it('settles earlier successful updates even when the outer command or reporter fails', () => {
    const count = input(0);
    const failure = new Error('original');
    const runtime = createProjectionRuntime({
      onError: () => {
        throw new Error('reporter');
      },
    });
    runtime.select(count).subscribe(() => {
      throw new Error('listener');
    });
    expect(() =>
      runtime.batch(() => {
        runtime.update(count, runtime.read(count) + 1);
        throw failure;
      })
    ).toThrow(failure);
    expect(runtime.read(count)).toBe(1);
    expect(() => runtime.update(count, 2)).toThrow('error reporter failed');
    runtime.batch(() => expect(runtime.read(count)).toBe(2));
    runtime.dispose();
  });

  it.each(['value', 'collection'] as const)(
    'preflights both equality baselines for %s inputs',
    kind => {
      const failure = new Error('equality');
      const equal = (a: number, b: number) => {
        if ((a === 0 && b === 2) || b === 99) throw failure;
        return a === b;
      };
      const count = input<number>(0, equal);
      const rows = input.collection(
        new Map([
          ['a', 0],
          ['b', 0],
        ]),
        equal
      );
      const errors = vi.fn();
      const runtime = createProjectionRuntime({ onError: errors });
      runtime.batch(() => {
        if (kind === 'value') {
          runtime.update(count, 1);
          expect(() => runtime.update(count, 2)).toThrow(failure);
          expect(() => runtime.update(count, 99)).toThrow(failure);
          expect(runtime.read(count)).toBe(1);
          runtime.update(count, runtime.read(count) + 2);
          expect(runtime.read(count)).toBe(3);
        } else {
          runtime.update(rows, d => d.set('a', 1));
          const before = runtime.read(rows);
          expect(() =>
            runtime.update(rows, d => {
              d.set('b', 8);
              d.set('a', 2);
            })
          ).toThrow(failure);
          expect(() => runtime.update(rows, d => d.set('a', 99))).toThrow(failure);
          expect(runtime.read(rows)).toBe(before);
          expect(runtime.read(rows).get('b')).toBe(0);
          runtime.update(rows, d => {
            expect(d.get('a')).toBe(1);
            d.set('a', 3);
          });
          expect(runtime.read(rows).get('a')).toBe(3);
        }
      });
      expect(errors).not.toHaveBeenCalled();
      expect(kind === 'value' ? runtime.read(count) : runtime.read(rows).get('a')).toBe(3);
      runtime.dispose();
    }
  );

  it('normalizes equivalent accepted values to latest and published references with net-zero publication', () => {
    const original = { n: 0 };
    const equal = (a: { n: number }, b: { n: number }) => a.n === b.n;
    const value = input(original, equal);
    const rows = input.collection(
      new Map([
        ['a', original],
        ['b', { n: 8 }],
      ]),
      equal
    );
    const runtime = createProjectionRuntime();
    const listener = vi.fn();
    runtime.select(value).subscribe(listener);
    runtime.select(rows).subscribe(listener);
    const before = runtime.read(rows);
    runtime.batch(() => {
      const changed = { n: 1 };
      runtime.update(value, changed);
      runtime.update(value, { n: 1 });
      expect(runtime.read(value)).toBe(changed);
      runtime.update(value, { n: 0 });
      expect(runtime.read(value)).toBe(original);
      runtime.update(rows, d => d.set('a', { n: 1 }));
      runtime.update(rows, d => d.set('a', { n: 0 }));
      expect(runtime.read(rows).get('a')).toBe(original);
    });
    expect(runtime.read(rows)).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    runtime.batch(() => {
      runtime.update(rows, d => d.remove('a'));
      runtime.update(rows, d => d.set('a', { n: 0 }));
      expect(runtime.read(rows).get('a')).toBe(original);
      expect([...runtime.read(rows).keys()]).toEqual(['b', 'a']);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('returns durable collection snapshots, preserves edit insertion order and rejects escaped drafts', () => {
    const rows = input.collection<string, number | undefined>(
      new Map([
        ['a', 1],
        ['b', undefined],
      ])
    );
    const runtime = createProjectionRuntime();
    let before!: ReadonlyMap<string, number | undefined>;
    let draftGet!: () => unknown;
    runtime.batch(() => {
      before = runtime.read(rows);
      expect(runtime.read(rows)).toBe(before);
      runtime.update(rows, d => {
        draftGet = () => d.get('a');
        d.remove('a');
        d.set('a', 2);
        d.set('c', 3);
        d.remove('c');
      });
      expect([...runtime.read(rows)]).toEqual([
        ['b', undefined],
        ['a', 2],
      ]);
      expect(runtime.read(rows).has('b')).toBe(true);
      expect([...before]).toEqual([
        ['a', 1],
        ['b', undefined],
      ]);
      expect('set' in runtime.read(rows)).toBe(false);
    });
    expect([...before.keys()]).toEqual(['a', 'b']);
    expect(() => draftGet()).toThrow('no longer active');
    const iterator = before.keys();
    iterator.next();
    const published = runtime.read(rows);
    const publishedIterator = published.entries();
    runtime.dispose();
    for (const run of [
      () => before.size,
      () => iterator.next(),
      () => before.forEach(() => {}),
      () => publishedIterator.next(),
    ])
      expect(run).toThrow(ProjectionDisposedError);
  });

  it('isolates runtimes and checks scope permissions and disposal before source access', () => {
    const value = input(0);
    const first = createProjectionRuntime();
    const second = createProjectionRuntime();
    const scope = first.scope();
    const sibling = first.scope();
    const scoped = scope.own(input(10));
    first.batch(() => {
      first.update(value, 1);
      second.batch(() => {
        expect(second.read(value)).toBe(0);
        second.update(value, 2);
      });
      expect(first.read(value)).toBe(1);
      expect(() => first.read(scoped)).toThrow('another scope');
      scope.batch(() => {
        expect(scope.read(value)).toBe(1);
        expect(scope.read(scoped)).toBe(10);
        expect(() => sibling.batch(() => sibling.read(scoped))).toThrow('another scope');
        scope.dispose();
        expect(() => scope.read(value)).toThrow(ProjectionDisposedError);
      });
    });
    expect(second.read(value)).toBe(2);
    first.batch(() => {
      first.dispose();
      expect(() => first.read(value)).toThrow(ProjectionDisposedError);
    });
    second.dispose();
  });

  it('matches Map membership and insertion order across staged edits and nested batches', () => {
    const rows = input.collection<string, number | undefined>();
    const runtime = createProjectionRuntime();
    const expected = new Map<string, number | undefined>();
    let seed = 12345;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    runtime.batch(() => {
      for (let round = 0; round < 200; round++) {
        const before = runtime.read(rows);
        const beforeEntries = [...before];
        runtime.batch(() => {
          runtime.update(rows, draft => {
            for (let edit = 0; edit < 20; edit++) {
              const key = String(random() % 13);
              if (random() % 3 === 0) {
                draft.remove(key);
                expected.delete(key);
              } else {
                const value = random() % 5 || undefined;
                draft.set(key, value);
                expected.set(key, value);
              }
              expect(draft.has(key)).toBe(expected.has(key));
              expect(draft.get(key)).toBe(expected.get(key));
            }
          });
          expect([...runtime.read(rows)]).toEqual([...expected]);
        });
        expect([...before]).toEqual(beforeEntries);
        expect([...runtime.read(rows)]).toEqual([...expected]);
        expect(runtime.read(rows).size).toBe(expected.size);
      }
    });
    expect([...runtime.read(rows)]).toEqual([...expected]);
    runtime.dispose();
  });

  it('rejects implicit dependencies and reentrant input commands even during initialization', () => {
    const value = input(0);
    const unmaterialized = input(1);
    const rows = input.collection<string, number>();
    const runtime = createProjectionRuntime();
    runtime.batch(() => {
      const derived = derive({}, () => runtime.read(unmaterialized));
      expect(() => runtime.read(derived)).toThrow('re-entered');
      expect(runtime.read(derive({ value }, ({ value }) => value))).toBe(0);
      expect(() =>
        runtime.update(rows, d => {
          d.set('a', 1);
          runtime.read(value);
        })
      ).toThrow('re-entered');
      expect(runtime.read(rows).size).toBe(0);
      expect(() => runtime.update(rows, () => runtime.update(value, 8))).toThrow('re-entered');
      const equal = input(0, () => {
        runtime.read(value);
        return false;
      });
      expect(() => runtime.update(equal, 1)).toThrow('re-entered');
      expect(runtime.read(equal)).toBe(0);
    });
    runtime.dispose();
  });

  it('keeps function/thenable assignment unambiguous and rejects asynchronous commands', () => {
    const initial = vi.fn((n: number) => n);
    const value = input<(n: number) => number>(initial);
    const promise = Promise.resolve(1);
    const asyncValue = input(promise);
    const rows = input.collection<string, number>();
    const runtime = createProjectionRuntime();
    runtime.batch(() => {
      const previous = runtime.read(value);
      runtime.update(value, n => previous(n) + 1);
      expect(initial).not.toHaveBeenCalled();
      expect(runtime.read(value)(1)).toBe(2);
      runtime.update(asyncValue, Promise.resolve(2));
      expect(runtime.read(asyncValue)).not.toBe(promise);
    });
    expect(() => runtime.batch((() => Promise.resolve()) as never)).toThrow('synchronous');
    expect(() =>
      runtime.update(rows, ((d: { set(key: string, value: number): void }) => {
        d.set('a', 1);
        return Promise.resolve();
      }) as never)
    ).toThrow('synchronous');
    expect(runtime.read(rows).size).toBe(0);
    runtime.dispose();
  });

  it('does not scan order or rebuild an index for a large collection value-only update', () => {
    const rows = input.collection(new Map(Array.from({ length: 10000 }, (_, i) => [String(i), i])));
    const runtime = createProjectionRuntime();
    runtime.read(rows);
    const measuring = startProfile();
    runtime.batch(() => {
      const before = runtime.read(rows);
      runtime.update(rows, d => d.set('5000', 99));
      expect(runtime.read(rows).get('5000')).toBe(99);
      expect(before.get('5000')).toBe(5000);
    });
    const stats = measuring.stop();
    expect(stats.collectionIndex.builds).toBe(0);
    expect(stats.collectionIndex.nodes).toBeLessThan(100);
    expect(stats.collectionView.idsScanned).toBe(0);
    runtime.dispose();
  });
});
