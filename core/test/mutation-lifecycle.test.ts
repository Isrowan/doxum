import { describe, expect, it, vi } from 'vitest';
import { createDocument, field, object, TransactionRejected, type Draft } from '../src';
import { installRuntimeWriteDriver } from '../src/runtime/driver';

const schema = object({ a: field<number>(), z: field<number>() });
const initial = { a: 0, z: 0 };
const changes = (n: number) => ({
  changes: [
    {
      kind: 'members',
      at: [],
      members: [{ key: 'a', kind: 'updated', before: 0, after: n }],
    },
  ],
});

describe('mutation execution boundary', () => {
  it('propagates write authorization failures without classifying them as transaction rejections', () => {
    const runtime = createDocument({ schema, initial });
    const failure = new TransactionRejected({ code: 'driver', message: 'write unavailable' });
    const driver = installRuntimeWriteDriver(runtime, {
      assertWritable: () => {
        throw failure;
      },
    });
    const callback = vi.fn();
    expect(() => runtime.update(callback)).toThrow(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(runtime.revision()).toBe(0);
    driver.dispose();
    expect(runtime.update(d => d.a++).status).toBe('committed');
  });
  it('checks each write intent once and keeps the runtime locked through publication', () => {
    const runtime = createDocument({ schema, initial });
    const intents: string[] = [];
    const driver = installRuntimeWriteDriver(runtime, {
      assertWritable: intent => {
        intents.push(`${intent.kind}:${intent.source}`);
      },
    });
    const errors: unknown[] = [];
    runtime.subscribe(() => {
      try {
        runtime.update(d => d.z++);
      } catch (error) {
        errors.push(error);
      }
    });
    expect(runtime.update(d => d.a++).status).toBe('committed');
    expect(runtime.apply(changes(2), { expectedRevision: 1 }).status).toBe('committed');
    expect(runtime.replace({ a: 3, z: 0 }).status).toBe('committed');
    expect(runtime.history.undo().status).toBe('committed');
    expect(intents).toEqual(['update:local', 'apply:local', 'replace:system', 'apply:history']);
    expect(errors).toHaveLength(4);
    expect(runtime.snapshot()).toEqual({ a: 2, z: 0 });
    driver.dispose();
  });

  it('unlocks after decoding failures and preserves ordinary exceptions before observers', () => {
    const runtime = createDocument({ schema, initial });
    const failure = new Error('decoder getter');
    expect(() =>
      runtime.apply(
        {
          get changes() {
            throw failure;
          },
        },
        { expectedRevision: 0 }
      )
    ).toThrow(failure);
    expect(runtime.apply({}, { expectedRevision: 0 }).status).toBe('rejected');
    expect(runtime.apply(changes(1), { expectedRevision: 9 }).status).toBe('rejected');
    const observer = new Error('observer');
    runtime.subscribe(() => {
      throw observer;
    });
    const result = runtime.update(d => {
      d.a = 1;
      return 'value';
    });
    expect(result).toMatchObject({
      status: 'committed',
      value: 'value',
      observerErrors: [{ error: observer }],
    });
    expect(runtime.snapshot()).toEqual({ a: 1, z: 0 });
    expect(runtime.revision()).toBe(1);
    expect(runtime.history.current().undoDepth).toBe(1);
  });

  it('rolls back all preceding writes for business failures, thrown values and asynchronous returns', () => {
    const runtime = createDocument({ schema, initial });
    const listener = vi.fn();
    runtime.subscribe(listener);
    expect(
      runtime.update(d => {
        d.a = 1;
        throw new TransactionRejected({ code: 'denied', message: 'denied' });
      })
    ).toMatchObject({ status: 'rejected', issues: [{ source: 'application', code: 'denied' }] });
    const failure = new Error('application failure');
    expect(() =>
      runtime.update(d => {
        d.a = 2;
        throw failure;
      })
    ).toThrow(failure);
    expect(() =>
      runtime.update(d => {
        d.a = 3;
        // The runtime also rejects untyped thenables crossing the synchronous boundary.
        return { then: () => {} };
      })
    ).toThrow('synchronous');
    expect(runtime.snapshot()).toEqual(initial);
    expect(runtime.revision()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(runtime.update(d => d.a++).status).toBe('committed');
  });

  it('restores earlier replay batches when a later history batch fails validation', () => {
    let rejectZero = false;
    const model = object({
      a: field((v: unknown) => {
        if (typeof v !== 'number' || (rejectZero && v === 0)) throw new Error('number');
        return v;
      }),
      z: field<number>(),
    });
    const runtime = createDocument({ schema: model, initial });
    const group = runtime.history.group();
    runtime.update(d => (d.a = 1));
    runtime.update(d => (d.z = 2));
    group.end();
    const listener = vi.fn();
    runtime.subscribe(listener);
    rejectZero = true;
    expect(runtime.history.undo().status).toBe('rejected');
    expect(runtime.snapshot()).toEqual({ a: 1, z: 2 });
    expect(runtime.revision()).toBe(2);
    expect(runtime.history.current()).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(listener).not.toHaveBeenCalled();
    rejectZero = false;
    expect(runtime.history.undo().status).toBe('committed');
    expect(runtime.snapshot()).toEqual(initial);
  });
});
