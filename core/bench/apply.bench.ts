import { bench, describe } from 'vitest';
import { createDocument, field, object, schema, table } from '../src/index';

const project = object({ name: field<string>(), value: field<number>() });
const documentSchema = schema({
  value: field<number>(),
  meta: object({ value: field<number>() }),
  projects: table(project),
});
const makeInitial = (projectCount: number) => ({
  value: 0,
  meta: { value: 0 },
  projects: {
    ids: Array.from({ length: projectCount }, (_, index) => `project-${index}`),
    byId: Object.fromEntries(
      Array.from({ length: projectCount }, (_, index) => [
        `project-${index}`,
        { name: `Project ${index}`, value: index },
      ])
    ),
  },
});

describe('runtime steady-state', () => {
  const scalarRuntime = createDocument({
    schema: documentSchema,
    initial: makeInitial(1),
    history: false,
  });
  let scalarIndex = 0;
  bench('apply / scalar update', () => {
    scalarRuntime.apply([{ type: 'field.set', at: ['value'], value: scalarIndex++ }]);
  });

  const noOpRuntime = createDocument({
    schema: documentSchema,
    initial: makeInitial(1),
    history: false,
  });
  bench('apply / scalar no-op', () => {
    noOpRuntime.apply([{ type: 'field.set', at: ['value'], value: 0 }]);
  });

  const transactionRuntime = createDocument({
    schema: documentSchema,
    initial: makeInitial(1),
    history: false,
  });
  let transactionIndex = 0;
  bench('update / scalar update', () => {
    transactionRuntime.update(tx => tx.write.value.set(transactionIndex++));
  });

  const collectionRuntime = createDocument({
    schema: documentSchema,
    initial: makeInitial(10_000),
    history: false,
  });
  let collectionIndex = 0;
  bench('apply / 10k collection single item', () => {
    const index = collectionIndex++ % 10_000;
    collectionRuntime.apply([
      {
        type: 'field.set',
        at: ['projects', `project-${index}`, 'name'],
        value: `Updated ${collectionIndex}`,
      },
    ]);
  });

  for (const size of [1, 10, 100, 1000]) {
    const runtime = createDocument({
      schema: documentSchema,
      initial: makeInitial(1),
      history: false,
    });
    let batchIndex = 0;
    bench(`apply / batch ${size}`, () => {
      const value = batchIndex++;
      runtime.apply(
        Array.from({ length: size }, (_, index) => ({
          type: 'field.set' as const,
          at: ['meta', 'value'] as const,
          value: value * size + index,
        }))
      );
    });
  }
});
