import { createDocument, field, object, map, select } from 'doxum';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const entity = object({
  position: object({ x: field(), y: field() }),
  health: field(),
  name: field(),
});
const definition = object({ entities: map(entity) });
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
  const memory = [];
  let gcCount = 0;
  let gcMs = 0;
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
      const target = p => p.entities.item(ids[i]).position.x;
      unsubscribers.push(runtime.subscribe(target, () => notices++));
    }
    const tick = () => {
      const result = runtime.update(draft => {
        for (let i = 0; i < changed; i++) {
          const id = ids[(frame * changed + i) % count];
          const position = draft.entities[id].position;
          position.x += 1;
          position.y += 2;
        }
      });
      assert.equal(result.status, 'committed');
      assert.equal(result.observerErrors.length, 0);
      frame++;
    };
    for (let i = 0; i < 20; i++) tick();
    const gcEvents = [];
    const observer = new PerformanceObserver(list => gcEvents.push(...list.getEntries()));
    observer.observe({ entryTypes: ['gc'] });
    const heapBefore = process.memoryUsage().heapUsed;
    const measuredStart = performance.now();
    const trialSamples = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      tick();
      trialSamples.push(performance.now() - start);
    }
    const measuredEnd = performance.now();
    memory.push(process.memoryUsage().heapUsed - heapBefore);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    observer.disconnect();
    for (const event of gcEvents) {
      if (event.startTime < measuredStart || event.startTime > measuredEnd) continue;
      gcCount++;
      gcMs += event.duration;
    }
    samples.push(...trialSamples);
    means.push(trialSamples.reduce((a, b) => a + b, 0) / trialSamples.length);
    const total = select(runtime, read =>
      ids.reduce((sum, id) => sum + read.entities[id].position.x, 0)
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
    gcCount,
    gcMs,
    heapDeltaBytes: memory,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ node: process.version, rows }, null, 2));
