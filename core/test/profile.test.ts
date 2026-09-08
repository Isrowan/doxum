import { describe, expect, it } from 'vitest';
import { equal } from '../src/mutation/anchor';
import { copyValue } from '../src/schema-value';
import { field, object } from '../src';
import { startProfile } from '../src/profile';

describe('runtime profile', () => {
  it('collects counters only inside an explicit session', () => {
    const session = startProfile();
    copyValue(object({ nested: field<number[]>() }), { nested: [1, 2, 3] });
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
    copyValue(object({ outside: field<boolean>() }), { outside: true });
    const session = startProfile();
    const snapshot = session.snapshot();
    expect(snapshot.copy.structures).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.copy)).toBe(true);
    expect(Object.isFrozen(snapshot.equality)).toBe(true);
    session.stop();
  });
});
