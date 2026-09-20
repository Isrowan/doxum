import { describe, expect, it } from 'vitest';
import { equal } from '../src/order/sequence';
import { copyValue } from '../src/schema/value';
import { field, object } from '../src';
import { schemaNodeOf } from '../src/schema/model';
import { startProfile } from '../src/profile';
import { createDependencyTracker } from '../src/access/dependency';

describe('runtime profile', () => {
  it('collects counters only inside an explicit session', () => {
    const session = startProfile();
    copyValue(schemaNodeOf(object({ nested: field<number[]>() })), { nested: [1, 2, 3] });
    expect(equal(['a', 'b'], ['a', 'b'])).toBe(true);
    const snapshot = session.stop();
    expect(snapshot.copy.structures).toBe(1);
    expect(snapshot.equality).toEqual({ calls: 1, containers: 1 });

    const next = startProfile();
    expect(next.stop().copy.structures).toBe(0);
  });

  it('does not allow overlapping sessions', () => {
    const session = startProfile();
    expect(() => startProfile()).toThrow('already active');
    session.stop();
  });

  it('keeps the inactive path free of recorded work and freezes nested snapshots', () => {
    copyValue(schemaNodeOf(object({ outside: field<boolean>() })), { outside: true });
    const session = startProfile();
    const snapshot = session.snapshot();
    expect(snapshot.copy.structures).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.copy)).toBe(true);
    expect(Object.isFrozen(snapshot.equality)).toBe(true);
    session.stop();
  });

  it('indexes distinct selector dependencies without quadratic target comparisons', () => {
    const tracker = createDependencyTracker();
    const session = startProfile();
    for (let index = 0; index < 2_000; index++)
      tracker.record({ kind: 'value', at: ['rows', String(index), 'value'] });
    const measured = session.stop();
    expect(tracker.snapshot()).toHaveLength(2_000);
    expect(measured.dependency).toEqual({ comparisons: 0, segmentsCompared: 0 });

    tracker.record({ kind: 'value', at: ['rows', '1999', 'value'] });
    expect(tracker.snapshot()).toHaveLength(2_000);
  });

  it('keeps exact schema target equality inside a dependency bucket', () => {
    const tracker = createDependencyTracker();
    const left = schemaNodeOf(object({ value: field<number>() }));
    const right = schemaNodeOf(object({ value: field<number>() }));
    tracker.record({ kind: 'value', schema: left, address: [] });
    tracker.record({ kind: 'value', schema: right, address: [] });
    tracker.record({ kind: 'value', schema: left, address: [] });
    expect(tracker.snapshot()).toHaveLength(2);
  });
});
