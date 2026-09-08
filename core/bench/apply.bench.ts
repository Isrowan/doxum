import { afterAll, bench, describe } from 'vitest';
import { createDocument, field, map, object } from '../src';
const model = object({ rows: map(object({ n: field<number>() })) });
describe('ChangeSet and draft costs', () => {
  for (const count of [1, 100, 10000]) {
    const initial = {
      rows: Object.fromEntries(Array.from({ length: count }, (_, n) => [String(n), { n: 0 }])),
    };
    const runtime = createDocument({ schema: model, initial, history: false });
    let value = 0;
    afterAll(() => runtime.dispose());
    bench(
      `apply ${count} final field facts`,
      () => {
        const before = value++,
          after = value;
        const changes = {
          changes: Array.from({ length: count }, (_, n) => ({
            kind: 'value',
            at: ['rows', String(n), 'n'],
            before: { present: true, value: before },
            after: { present: true, value: after },
          })),
        };
        if (runtime.apply(changes, { expectedRevision: runtime.revision() }).status !== 'committed')
          throw new Error('Apply failed');
      },
      { time: 150, iterations: 5 }
    );
  }
  for (const repeats of [1, 100, 10000]) {
    const runtime = createDocument({
      schema: object({ n: field<number>() }),
      initial: { n: 0 },
      history: false,
    });
    afterAll(() => runtime.dispose());
    bench(
      `draft ${repeats} writes to one field`,
      () => {
        runtime.update(d => {
          for (let n = 0; n < repeats; n++) d.n++;
        });
      },
      { time: 150, iterations: 5 }
    );
    bench(
      `draft ${repeats} unchanged writes`,
      () => {
        runtime.update(d => {
          for (let n = 0; n < repeats; n++) d.n = d.n;
        });
      },
      { time: 150, iterations: 5 }
    );
  }
});
