import { afterAll, bench, describe } from 'vitest';
import { createDocument, field, map, object, schema } from '../src';

const model = schema({ rows: map(object({ x: field<number>(), y: field<number>() })) });

describe('entity frames and subscription matching', () => {
  for (const [count, changed, listeners, offset, mode] of [
    [10000, 100, 0, 2000, 'set'],
    [10000, 100, 1000, 2000, 'set'],
    [10000, 100, 1000, 950, 'set'],
    [10000, 100, 1000, 0, 'set'],
    [10000, 10000, 0, 0, 'set'],
    [10000, 10000, 0, 0, 'update'],
  ] as const) {
    const ids = Array.from({ length: count }, (_, i) => String(i));
    const runtime = createDocument({
      schema: model,
      initial: { rows: Object.fromEntries(ids.map(id => [id, { x: 0, y: 0 }])) },
      history: false,
    });
    for (let i = 0; i < listeners; i++)
      runtime.subscribe(
        model.value(path => path.rows.item(ids[i]).x),
        () => {}
      );
    afterAll(() => runtime.dispose());
    bench(
      `${mode} ${changed}/${count}, ${listeners} listeners, offset ${offset}`,
      () => {
        const result = runtime.update(tx => {
          for (let i = 0; i < changed; i++) {
            const id = ids[(i + offset) % count];
            const write = tx.write.rows.item(id);
            if (mode === 'update') {
              write.x.update(x => x + 1);
              write.y.update(y => y + 2);
            } else {
              const read = tx.read.rows.get(id)!;
              write.x.set(read.x.get() + 1);
              write.y.set(read.y.get() + 2);
            }
          }
        });
        if (result.status !== 'committed' || result.observerErrors.length)
          throw new Error('Frame failed.');
      },
      { time: 200, iterations: 10 }
    );
  }
});

describe('nested entity frames', () => {
  const definition = schema({
    entities: map(
      object({
        position: object({ x: field<number>(), y: field<number>() }),
        health: field<number>(),
        name: field<string>(),
      })
    ),
  });
  for (const mode of ['update', 'unchanged', 'collection-impact', 'affects'] as const) {
    const ids = Array.from({ length: 10000 }, (_, i) => `entity:${i}`);
    const runtime = createDocument({
      schema: definition,
      history: false,
      initial: {
        entities: Object.fromEntries(
          ids.map(id => [id, { position: { x: 0, y: 0 }, health: 100, name: id }])
        ),
      },
    });
    const collection = definition.collection(p => p.entities);
    const target = definition.value(p => p.entities.item(ids[0]).position.x);
    runtime.subscribe(commit => {
      if (mode === 'collection-impact') {
        const change = commit.impact.collection(collection);
        if (change.kind !== 'incremental' || change.updated.size !== ids.length)
          throw new Error('Incorrect collection impact.');
      }
      if (mode === 'affects' && !commit.impact.affects(target))
        throw new Error('Missing field impact.');
    });
    afterAll(() => runtime.dispose());
    bench(
      mode,
      () => {
        const result = runtime.update(tx => {
          for (const id of ids) {
            const position = tx.write.entities.item(id).position;
            position.x.update(x => (mode === 'unchanged' ? x : x + 1));
            position.y.update(y => (mode === 'unchanged' ? y : y + 2));
          }
        });
        if (
          mode === 'unchanged'
            ? result.status !== 'unchanged'
            : result.status !== 'committed' || result.observerErrors.length
        )
          throw new Error('Frame failed.');
      },
      { time: 200, iterations: 10 }
    );
  }
});
