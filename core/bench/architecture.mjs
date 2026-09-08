import assert from 'node:assert/strict';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// A saved build uses exactly the same public workloads, including its own apply format.
const modulePath = process.env.DOXUM_BENCH_MODULE;
const { createDocument, field, object, map, table, list, tree } = await import(
  modulePath ? pathToFileURL(resolve(modulePath)).href : 'doxum'
);
const allocation = process.argv.includes('--allocation');
const trials = Number(process.env.DOXUM_BENCH_TRIALS ?? (allocation ? 1 : 3));
const warmup = Number(process.env.DOXUM_BENCH_WARMUP ?? 20);
const measured = Number(process.env.DOXUM_BENCH_SAMPLES ?? 60);
const scenarios = [
  ['full', 10000, 10000, 0],
  ['full-one-listener', 10000, 10000, 1],
  ['full-many-listeners', 10000, 10000, 1000],
  ['full-unrelated-listeners', 10000, 10000, 1000],
  ['sparse', 10000, 100, 0],
  ['large-sparse', 100000, 1000, 0],
  ['single-field', 10000, 10000, 0],
  ['deep', 1000, 1000, 0],
  ['history', 10000, 1000, 0],
  ['apply', 10000, 1000, 0],
  ['replacement', 10000, 1000, 0],
  ['list-order', 10000, 1, 0],
  ['tree', 1000, 1, 0],
  ['repeated', 1, 100000, 0],
  ['unchanged', 1, 100000, 0],
  ['table-apply-one', 100000, 1, 0],
  ['list-values', 2000, 2000, 0],
  ['mixed-order', 10000, 10000, 0],
].filter(
  ([name]) =>
    !process.env.DOXUM_BENCH_FILTER || process.env.DOXUM_BENCH_FILTER.split(',').includes(name)
);

if (process.argv.includes('--isolate')) {
  const rows = [];
  for (const [name] of scenarios) {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(arg => arg !== '--isolate')],
      {
        env: { ...process.env, DOXUM_BENCH_FILTER: name },
        encoding: 'utf8',
      }
    );
    if (child.status !== 0)
      throw new Error(child.stderr || child.error?.message || 'Benchmark child failed');
    const report = JSON.parse(child.stdout.trim().split('\n').at(-1));
    rows.push(...report.rows);
    console.log(JSON.stringify(report.rows[0]));
  }
  console.log(
    JSON.stringify({
      node: process.version,
      module: modulePath ?? 'doxum',
      allocation,
      trials,
      warmup,
      measured,
      explicitGC: false,
      isolated: true,
      rows,
    })
  );
  process.exit(0);
}

function setup(name, count, changed, listeners) {
  if (name === 'table-apply-one' || name === 'list-values') {
    const ids = Array.from({ length: count }, (_, i) => String(i));
    const runtime =
      name === 'table-apply-one'
        ? createDocument({
            schema: object({ rows: table(object({ n: field() })) }),
            initial: { rows: { ids, byId: Object.fromEntries(ids.map(id => [id, { n: 0 }])) } },
            history: false,
          })
        : createDocument({
            schema: object({ rows: list(field(), { keyOf: v => v.id }) }),
            initial: { rows: ids.map(id => ({ id, n: 0 })) },
            history: false,
          });
    let frame = 0;
    return {
      tick: () =>
        name === 'table-apply-one'
          ? runtime.apply(
              {
                changes: [
                  {
                    kind: 'members',
                    at: ['rows'],
                    members: [
                      { key: '0', kind: 'updated', before: { n: frame }, after: { n: ++frame } },
                    ],
                  },
                ],
              },
              { expectedRevision: runtime.revision() }
            )
          : runtime.update(d => {
              frame++;
              for (const id of ids) d.rows.set(id, { id, n: frame });
            }),
      verify: () => {
        assert.equal(runtime.revision(), warmup + measured);
        const rows = runtime.snapshot().rows;
        if (name === 'table-apply-one') assert.equal(rows.byId['0'].n, frame);
        else
          assert.equal(
            rows.reduce((sum, row) => sum + row.n, 0),
            count * frame
          );
      },
      dispose: () => runtime.dispose(),
    };
  }
  const position = object({ x: field(), y: field() });
  const entity = object({
    position: name === 'deep' ? object({ a: object({ b: position }) }) : position,
  });
  const schema = object({
    entities: map(entity),
    ...(name === 'mixed-order' ? { order: list(field(), { keyOf: v => v }) } : {}),
  });
  const ids = Array.from({ length: count }, (_, i) => String(i));
  const initial = {
    ...(name === 'mixed-order' ? { order: ['a', 'b'] } : {}),
    entities: Object.fromEntries(
      ids.map(id => [
        id,
        { position: name === 'deep' ? { a: { b: { x: 0, y: 0 } } } : { x: 0, y: 0 } },
      ])
    ),
  };
  const runtime = createDocument({ schema, initial, history: name === 'history' });
  let notices = 0;
  runtime.subscribe(() => {});
  for (let i = 0; i < listeners; i++) {
    const id = name === 'full-unrelated-listeners' ? `missing:${i}` : ids[i];
    runtime.subscribe(
      p => p.entities.item(id).position.x,
      () => notices++
    );
  }
  let frame = 0;
  let tick;
  if (name === 'apply') {
    const producer = createDocument({ schema, initial, history: false });
    const changes = [1, 0].map(n => {
      const result = producer.update(d => {
        for (let i = 0; i < changed; i++) {
          d.entities[ids[i]].position.x = n;
          d.entities[ids[i]].position.y = n;
        }
      });
      assert.equal(result.status, 'committed');
      return result.commit.changes;
    });
    producer.dispose();
    tick = () => runtime.apply(changes[frame++ % 2], { expectedRevision: runtime.revision() });
  } else {
    tick = () =>
      runtime.update(d => {
        if (name === 'repeated' || name === 'unchanged') {
          const p = d.entities['0'].position;
          for (let i = 0; i < changed; i++) p.x = name === 'unchanged' ? p.x : p.x + 1;
        } else {
          for (let i = 0; i < changed; i++) {
            const id = ids[(frame * changed + i) % count];
            if (name === 'replacement')
              d.entities[id] = { position: { x: frame + 1, y: frame + 1 } };
            else {
              const p = name === 'deep' ? d.entities[id].position.a.b : d.entities[id].position;
              p.x++;
              if (name !== 'single-field') p.y += 2;
            }
          }
        }
        if (name === 'mixed-order') d.order.move(frame % 2 ? 'b' : 'a');
        frame++;
      });
  }
  if (name === 'list-order' || name === 'tree') {
    runtime.dispose();
    const doc =
      name === 'list-order'
        ? createDocument({
            schema: object({ rows: list(field(), { keyOf: v => v }) }),
            initial: { rows: ids },
            history: false,
          })
        : createDocument({
            schema: object({ outline: tree(field()) }),
            initial: {
              outline: {
                rootId: 'r',
                nodes: Object.fromEntries([
                  ['r', { children: ids, value: 0 }],
                  ...ids.map(id => [id, { parentId: 'r', children: [], value: 0 }]),
                ]),
              },
            },
            history: false,
          });
    let n = 0;
    return {
      tick: () =>
        doc.update(d =>
          name === 'list-order' ? d.rows.move(ids[n++ % count]) : d.outline.set(ids[n++ % count], n)
        ),
      verify: () => assert.equal(doc.revision(), warmup + measured),
      dispose: () => doc.dispose(),
    };
  }
  return {
    tick,
    dispose: () => runtime.dispose(),
    verify: () => {
      assert.equal(runtime.revision(), name === 'unchanged' ? 0 : warmup + measured);
      assert.equal(
        notices,
        name === 'full-unrelated-listeners' ? 0 : (warmup + measured) * listeners
      );
      if (
        [
          'full',
          'full-one-listener',
          'full-many-listeners',
          'full-unrelated-listeners',
          'sparse',
          'large-sparse',
          'single-field',
          'history',
          'deep',
          'mixed-order',
        ].includes(name)
      ) {
        const snapshot = runtime.snapshot();
        const total = Object.values(snapshot.entities).reduce(
          (sum, row) => sum + (name === 'deep' ? row.position.a.b.x : row.position.x),
          0
        );
        assert.equal(total, (warmup + measured) * changed);
      }
    },
  };
}

const rows = [];
for (const [name, count, changed, listeners] of scenarios) {
  const samples = [],
    means = [],
    allocations = [];
  const allocationSites = new Map();
  let gcCount = 0,
    gcMs = 0;
  for (let trial = 0; trial < trials; trial++) {
    const workload = setup(name, count, changed, listeners);
    const tick = () => {
      const result = workload.tick();
      assert.equal(result.status, name === 'unchanged' ? 'unchanged' : 'committed');
      if (result.status === 'committed') assert.equal(result.observerErrors.length, 0);
    };
    for (let i = 0; i < warmup; i++) tick();
    let inspector;
    if (allocation) {
      inspector = new Session();
      inspector.connect();
      await inspector.post('HeapProfiler.startSampling', {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const events = [];
    const observer = new PerformanceObserver(list => events.push(...list.getEntries()));
    observer.observe({ entryTypes: ['gc'] });
    const times = [];
    const begin = performance.now();
    for (let i = 0; i < measured; i++) {
      const start = performance.now();
      tick();
      times.push(performance.now() - start);
    }
    const end = performance.now();
    if (inspector) {
      const { profile } = await inspector.post('HeapProfiler.stopSampling');
      const size = node =>
        node.selfSize + node.children.reduce((sum, child) => sum + size(child), 0);
      allocations.push(size(profile.head) / measured);
      const sites = node => {
        const key = `${node.callFrame.functionName}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
        allocationSites.set(
          key,
          (allocationSites.get(key) ?? 0) + node.selfSize / measured / trials
        );
        node.children.forEach(sites);
      };
      sites(profile.head);
      inspector.disconnect();
    }
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    observer.disconnect();
    for (const event of events)
      if (event.startTime >= begin && event.startTime <= end) {
        gcCount++;
        gcMs += event.duration;
      }
    workload.verify();
    workload.dispose();
    samples.push(...times);
    means.push(times.reduce((sum, n) => sum + n, 0) / measured);
  }
  samples.sort((a, b) => a - b);
  const row = {
    name,
    count,
    changed,
    listeners,
    mean: samples.reduce((sum, n) => sum + n, 0) / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    max: samples.at(-1),
    means,
    gcCount,
    gcMs,
    allocatedBytesPerTransaction: allocations,
    allocationSites: [...allocationSites].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.log(
  JSON.stringify({
    node: process.version,
    module: modulePath ?? 'doxum',
    allocation,
    trials,
    warmup,
    measured,
    explicitGC: false,
    rows,
  })
);
