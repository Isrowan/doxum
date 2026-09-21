import { afterAll, bench, describe } from 'vitest';
import { createDocument, field, object } from 'doxum';

describe('shared payload validation, publication and history', () => {
  for (const size of [10, 10000, 100000]) {
    const values = [
      { values: new Array<number>(size).fill(0) },
      { values: new Array<number>(size).fill(1) },
    ];
    const schema = object({
      payload: field<(typeof values)[number]>((value): value is (typeof values)[number] =>
        Boolean(
          value && typeof value === 'object' && 'values' in value && Array.isArray(value.values)
        )
      ),
    });
    const runtime = createDocument({ schema, initial: { payload: values[0] } });
    let index = 0;
    afterAll(() => runtime.dispose());
    bench(
      `replace and snapshot ${size} payload items`,
      () => {
        index = 1 - index;
        const payload = values[index];
        const result = runtime.update(d => {
          d.payload = payload;
        });
        if (result.status !== 'committed' || runtime.snapshot().payload !== payload)
          throw new Error('Payload identity lost');
      },
      { time: 200, iterations: 10 }
    );
  }
});
