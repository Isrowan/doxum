import { performance } from 'node:perf_hooks';
import { createDocument, createProjectionRuntime, field, map, object } from '../src';
import { startProfile } from '../src/profile';
const schema = object({
  entities: map(
    object({ position: object({ x: field<number>(), y: field<number>() }), name: field<string>() })
  ),
});
for (const [count, changed, subscribers] of [
  [1000, 1000, 0],
  [10000, 10000, 0],
  [100000, 1000, 0],
  [10000, 100, 1000],
]) {
  const ids = Array.from({ length: count }, (_, i) => String(i));
  const runtime = createDocument({
    schema,
    initial: {
      entities: Object.fromEntries(ids.map(id => [id, { position: { x: 0, y: 0 }, name: id }])),
    },
    history: false,
  });
  for (let i = 0; i < subscribers; i++)
    runtime.subscribe(
      p => p.entities.item(ids[i]).position.x,
      () => {}
    );
  const projection = createProjectionRuntime({
    onError: error => {
      throw error;
    },
  });
  const values = projection.map(
    projection.document(runtime).collection(p => p.entities),
    (_id, entity) => entity.position.x
  );
  const tick = () =>
    runtime.update(d => {
      for (let i = 0; i < changed; i++) {
        const position = d.entities[ids[i]]!.position;
        position.x++;
        position.y += 2;
      }
    });
  for (let i = 0; i < 10; i++) tick();
  const profile = startProfile(),
    start = performance.now();
  const result = tick(),
    elapsed = performance.now() - start,
    counters = profile.stop();
  if (
    result.status !== 'committed' ||
    result.commit.changes.changes.length !== changed * 2 ||
    values.item(ids[0]).current() !== 11
  )
    throw new Error('Profile workload failed');
  console.log(JSON.stringify({ count, changed, subscribers, elapsed, counters }));
  projection.dispose();
  runtime.dispose();
}
