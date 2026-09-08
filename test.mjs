import { createDocument, field, object, map, schema, select } from 'doxum';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const entity = object({
  position: object({ x: field(), y: field() }),
  health: field(),
  name: field(),
});
const definition = schema({ entities: map(entity) });
const rows = [];
for (const [count, fraction, listeners] of [
  [1000, 1, 0],
  [10000, 1, 0],
  [10000, 0.01, 0],
  [100000, 0.01, 0],
  [10000, 0.01, 1000],
]) {
  const changed = Math.max(1, Math.floor(count * fraction));
  const samples = [];
  const means = [];
  let notices = 0;
  for (let trial = 0; trial < 3; trial++) {
    const ids = Array.from({ length: count }, (_, i) => `entity:${i}`);
    const initial = {
      entities: Object.fromEntries(
        ids.map(id => [id, { position: { x: 0, y: 0 }, health: 100, name: id }])
      ),
    };
    const runtime = createDocument({ schema: definition, initial, history: false });
    let frame = 0;
    let observed = 0;
    const unsubscribers = [];
    runtime.subscribe(() => observed++);
    for (let i = 0; i < listeners; i++) {
      const target = definition.value(p => p.entities.item(ids[i]).position.x);
      unsubscribers.push(runtime.subscribe(target, () => notices++));
    }
    const tick = () => {
      const result = runtime.update(tx => {
        for (let i = 0; i < changed; i++) {
          const id = ids[(frame * changed + i) % count];
          const read = tx.read.entities.get(id);
          const write = tx.write.entities.item(id);
          write.position.x.set(read.position.x.get() + 1);
          write.position.y.set(read.position.y.get() + 2);
        }
      });
      assert.equal(result.status, 'committed');
      assert.equal(result.observerErrors.length, 0);
      frame++;
    };
    for (let i = 0; i < 20; i++) tick();
    const trialSamples = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      tick();
      trialSamples.push(performance.now() - start);
    }
    samples.push(...trialSamples);
    means.push(trialSamples.reduce((a, b) => a + b, 0) / trialSamples.length);
    const total = select(runtime, read =>
      ids.reduce((sum, id) => sum + read.entities.get(id).position.x.get(), 0)
    );
    assert.equal(total, 80 * changed);
    assert.equal(observed, 80);
    assert.equal(runtime.revision(), 80);
    for (const stop of unsubscribers) stop();
    runtime.dispose();
  }
  samples.sort((a, b) => a - b);
  const average = samples.reduce((a, b) => a + b, 0) / samples.length;
  const row = {
    count,
    changed,
    fields: changed * 2,
    listeners,
    mean: average,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    max: samples.at(-1),
    trials: means,
    notices,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ node: process.version, rows }, null, 2));
