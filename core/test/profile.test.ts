import { describe, expect, it } from 'vitest';
import { cloneValue, deepEqual } from '../src/value/ownership';
import { startProfile } from '../src/profile';

describe('runtime profile', () => {
  it('collects counters only inside an explicit session', () => {
    const session = startProfile();
    const value = cloneValue({ nested: [1, 2, 3] });
    expect(deepEqual(value, { nested: [1, 2, 3] })).toBe(true);
    const snapshot = session.stop();
    expect(snapshot.clone.calls).toBeGreaterThan(1);
    expect(snapshot.clone.deepEqual.calls).toBeGreaterThan(1);

    const next = startProfile();
    expect(next.stop().clone.calls).toBe(0);
  });

  it('does not allow overlapping sessions', () => {
    const session = startProfile();
    expect(() => startProfile()).toThrow('already active');
    session.stop();
  });

  it('keeps the inactive path free of recorded work and freezes nested snapshots', () => {
    cloneValue({ outside: true });
    const session = startProfile();
    const snapshot = session.snapshot();
    expect(snapshot.clone.calls).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.clone)).toBe(true);
    expect(Object.isFrozen(snapshot.clone.nodes)).toBe(true);
    session.stop();
  });
});
