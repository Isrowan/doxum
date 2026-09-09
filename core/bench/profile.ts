import { performance } from 'node:perf_hooks';
import {
  createDocument,
  createProjectionStore,
  field,
  list,
  map,
  object,
  project,
  table,
  tree,
  type Draft,
} from '../src';
import { startProfile } from '../src/profile';
import { MutationSession } from '../src/mutation/session';
const schema = object({
  entities: map(
    object({ position: object({ x: field<number>(), y: field<number>() }), name: field<string>() })
  ),
});
for (const [count, changed, subscribers] of [
  [1000, 1000, 0],
  [10000, 10000, 0],
  [10000, 10000, 1],
  [10000, 10000, 1000],
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
  const store = createProjectionStore({
    onError: error => {
      throw error;
    },
  });
  const values = project(
    runtime,
    p => p.entities,
    (_id, entity) => entity.position.x
  );
  store.get(values);
  let measuring = false;
  let writesMs = 0;
  const tick = () =>
    runtime.update(d => {
      const start = measuring ? performance.now() : 0;
      for (let i = 0; i < changed; i++) {
        const position = d.entities[ids[i]]!.position;
        position.x++;
        position.y += 2;
      }
      if (measuring) writesMs += performance.now() - start;
    });
  for (let i = 0; i < 10; i++) tick();
  const profile = startProfile(),
    start = performance.now();
  const result = tick(),
    elapsed = performance.now() - start,
    counters = profile.stop();
  if (
    result.status !== 'committed' ||
    result.commit.changes.changes.length !== changed ||
    store.get(values).get(ids[0]) !== 11
  )
    throw new Error('Profile workload failed');
  console.log(JSON.stringify({ count, changed, subscribers, elapsed, counters }));
  const finish = MutationSession.prototype.finish;
  let sealMs = 0;
  MutationSession.prototype.finish = function () {
    const start = performance.now();
    try {
      return finish.call(this);
    } finally {
      sealMs += performance.now() - start;
    }
  };
  measuring = true;
  const phaseStart = performance.now();
  try {
    for (let i = 0; i < 60; i++) tick();
  } finally {
    MutationSession.prototype.finish = finish;
    measuring = false;
  }
  const totalMs = performance.now() - phaseStart;
  const queries = startProfile();
  const queryStart = performance.now();
  if (result.status === 'committed')
    result.commit.impact.affects(p => p.entities.item(ids[0]).position.x);
  const queryMs = performance.now() - queryStart;
  console.log(
    JSON.stringify({
      count,
      changed,
      subscribers,
      phases: {
        writesMs: writesMs / 60,
        sealMs: sealMs / 60,
        publicationAndRuntimeMs: (totalMs - writesMs - sealMs) / 60,
        explicitImpactQueryMs: queryMs,
      },
      queryCounters: queries.stop(),
    })
  );
  store.dispose();
  runtime.dispose();
}

const structuralSchema = object({
  rows: table(object({ n: field<number>() })),
  items: list(field<{ id: string; n: number }>(), { keyOf: value => value.id }),
  outline: tree(field<number>()),
});
const keys = Array.from({ length: 10000 }, (_, i) => String(i));
const structuralInitial = {
  rows: { ids: keys, byId: Object.fromEntries(keys.map(id => [id, { n: 0 }])) },
  items: keys.map(id => ({ id, n: 0 })),
  outline: { rootId: 'r', nodes: { r: { children: [], value: 0 } } },
};
const edits: [string, (draft: Draft<typeof structuralSchema>) => void][] = [
  [
    'structural-replacement',
    d => {
      d.items.replace([...structuralInitial.items.slice(1), { id: 'next', n: 1 }]);
    },
  ],
  [
    'table-membership',
    d => {
      d.rows.remove(keys.slice(0, 100));
      d.rows.create(keys.slice(0, 100).map(id => ({ id: `next:${id}`, value: { n: 1 } })));
    },
  ],
  [
    'list-membership',
    d => {
      d.items.remove('0');
      d.items.insert({ id: 'next', n: 1 });
    },
  ],
  [
    'list-values',
    d => {
      for (let i = 0; i < 100; i++) d.items.set(String(i), { id: String(i), n: 1 });
    },
  ],
  [
    'order-roundtrip',
    d => {
      for (let i = 0; i < 100; i++) {
        d.items.move('0');
        d.items.move('0', { at: 'start' });
      }
    },
  ],
  [
    'tree-repeated',
    d => {
      for (let i = 0; i < 1000; i++) d.outline.set('r', i + 1);
    },
  ],
];
for (const [name, edit] of [...edits, ['root-reset', undefined] as const]) {
  const runtime = createDocument({
    schema: structuralSchema,
    initial: structuralInitial,
    history: false,
  });
  const invalidate = MutationSession.prototype.invalidate;
  let invalidations = 0;
  MutationSession.prototype.invalidate = function () {
    invalidations++;
    invalidate.call(this);
  };
  const profile = startProfile();
  try {
    const start = performance.now();
    const result = edit
      ? runtime.update(edit)
      : runtime.replace({ ...structuralInitial, items: [] });
    const elapsed = performance.now() - start;
    if (result.status !== (name === 'order-roundtrip' ? 'unchanged' : 'committed'))
      throw new Error('Structural profile workload failed');
    console.log(JSON.stringify({ name, elapsed, invalidations, counters: profile.stop() }));
  } finally {
    profile.stop();
    MutationSession.prototype.invalidate = invalidate;
    runtime.dispose();
  }
}
