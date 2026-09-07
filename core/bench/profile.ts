import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  createDocument,
  createProjectionRuntime,
  field,
  object,
  schema,
  table,
  tree,
  type DocumentOperation,
  type DocumentRuntime,
} from '../src/index';
import { measureProfile, type ProfileSnapshot } from '../src/profile';

const item = object({ group: field<string>(), value: field<number>() });
const link = object({ from: field<string>(), to: field<string>() });
const documentSchema = schema({
  items: table(item),
  links: table(link),
  groups: tree<{ label: string }>(),
  metadata: object({ value: field<number>(), note: field<string>() }),
});

type Size = {
  readonly items: number;
  readonly links: number;
  readonly groups: number;
};
type Row = {
  readonly scenario: string;
  readonly scale: string;
  readonly pipeline: boolean;
  readonly iterations: number;
  readonly commits: number;
  readonly averageUs: number;
  readonly p50Us: number;
  readonly maxUs: number;
  readonly p95Us: number;
  readonly oracleMs: number;
  readonly heapBefore: number;
  readonly heapAfter: number;
  readonly gcMs: number;
  readonly profile: ProfileSnapshot;
};

const sizes: Record<string, Size> = {
  small: { items: 1_000, links: 5_000, groups: 100 },
  standard: { items: 10_000, links: 50_000, groups: 1_000 },
  stress: { items: 50_000, links: 100_000, groups: 5_000 },
};

const args = new Map(
  process.argv
    .slice(2)
    .filter(value => value.startsWith('--'))
    .map(value => {
      const [key, ...rest] = value.slice(2).split('=');
      return [key, rest.join('=') || 'true'] as const;
    })
);
const scaleName = args.get('scale') ?? 'small';
const size = sizes[scaleName] ?? sizes.small;
const iterations = Number(args.get('iterations') ?? (scaleName === 'stress' ? 100 : 200));
const jsonPath = args.get('json');
const seed = 20260820;
const gcExposed = typeof (globalThis as { readonly gc?: unknown }).gc === 'function';

const makeInitial = (input: Size) => {
  const itemIds = Array.from({ length: input.items }, (_, index) => `item-${index}`);
  const groupIds = Array.from({ length: input.groups }, (_, index) => `group-${index}`);
  const linkIds = Array.from({ length: input.links }, (_, index) => `link-${index}`);
  const groupNodes = Object.fromEntries(
    groupIds.map((id, index) => [
      id,
      {
        ...(index ? { parentId: groupIds[Math.floor((index - 1) / 8)] } : {}),
        children: [] as string[],
        value: { label: id },
      },
    ])
  );
  for (let index = 1; index < groupIds.length; index += 1)
    groupNodes[groupIds[Math.floor((index - 1) / 8)]].children.push(groupIds[index]);
  return {
    items: {
      ids: itemIds,
      byId: Object.fromEntries(
        itemIds.map((id, index) => [id, { group: groupIds[index % groupIds.length], value: index }])
      ),
    },
    links: {
      ids: linkIds,
      byId: Object.fromEntries(
        linkIds.map((id, index) => [
          id,
          {
            from: itemIds[index % itemIds.length],
            to: itemIds[(index * 17 + 13) % itemIds.length],
          },
        ])
      ),
    },
    groups: {
      rootId: groupIds[0],
      nodes: groupNodes,
    },
    metadata: { value: 0, note: 'profile' },
  };
};

const createPipeline = (runtime: DocumentRuntime<typeof documentSchema>) => {
  const projection = createProjectionRuntime({
    onError: error => {
      throw error;
    },
  });
  const document = projection.document(runtime);
  const itemIndex = projection.map(
    document.collection(path => path.items),
    (_id, entry) => ({ group: entry.group.get(), value: entry.value.get() }),
    { isEqual: (a, b) => a.group === b.group && a.value === b.value }
  );
  const linkIndex = projection.map(
    document.collection(path => path.links),
    (_id, entry) => ({ from: entry.from.get(), to: entry.to.get() }),
    { isEqual: (a, b) => a.from === b.from && a.to === b.to }
  );
  const groupIndex = projection.collection<number>()({
    sources: { itemIndex },
    build: ({ sources, writer }) => {
      const groups = new Map<string, number>();
      const relations = new Map<string, string>();
      for (const id of sources.itemIndex.ids()) {
        const group = sources.itemIndex.get(id)!.group;
        relations.set(id, group);
        groups.set(group, (groups.get(group) ?? 0) + 1);
      }
      groups.forEach((count, group) => writer.set(group, count));
      return {
        update: ({ sources, writer }) => {
          const change = sources.itemIndex.change;
          if (!change) return;
          if (change.kind === 'reset') return { kind: 'rebuild' };
          const touched = new Set<string>();
          for (const id of [...change.removed, ...change.updated, ...change.added]) {
            const before = relations.get(id);
            const after = sources.itemIndex.get(id)?.group;
            if (before === after) continue;
            if (before !== undefined) {
              groups.set(before, groups.get(before)! - 1);
              touched.add(before);
            }
            if (after !== undefined) {
              groups.set(after, (groups.get(after) ?? 0) + 1);
              relations.set(id, after);
              touched.add(after);
            } else relations.delete(id);
          }
          touched.forEach(group => {
            const count = groups.get(group)!;
            if (count) writer.set(group, count);
            else {
              groups.delete(group);
              writer.remove(group);
            }
          });
        },
      };
    },
  });
  const summary = projection.value(
    {
      sources: { groupIndex, linkIndex, itemIndex },
      build: sources => ({
        value: {
          groups: sources.groupIndex.ids().length,
          links: sources.linkIndex.ids().length,
          items: sources.itemIndex.ids().length,
        },
        update: sources => ({
          kind: 'changed',
          value: {
            groups: sources.groupIndex.ids().length,
            links: sources.linkIndex.ids().length,
            items: sources.itemIndex.ids().length,
          },
        }),
      }),
    },
    {
      isEqual: (a, b) => a.groups === b.groups && a.links === b.links && a.items === b.items,
    }
  );
  return { projection, itemIndex, groupIndex, linkIndex, summary };
};

type Pipeline = ReturnType<typeof createPipeline>;
const validatePipeline = (
  runtime: DocumentRuntime<typeof documentSchema>,
  views: Pipeline,
  label = 'oracle'
): void => {
  const current = runtime.snapshot();
  const summary = views.summary.current();
  if (
    summary.items !== current.items.ids.length ||
    summary.links !== current.links.ids.length ||
    views.itemIndex.ids.current().length !== current.items.ids.length
  )
    throw new Error('Pipeline count mismatch: ' + label);
  for (const id of current.items.ids) {
    const item = views.itemIndex.item(id).current();
    if (
      item?.group !== current.items.byId[id].group ||
      item?.value !== current.items.byId[id].value
    )
      throw new Error('Pipeline item mismatch: ' + id);
  }
  const expectedGroups = new Map<string, number>();
  for (const item of Object.values(current.items.byId))
    expectedGroups.set(item.group, (expectedGroups.get(item.group) ?? 0) + 1);
  if (views.groupIndex.ids.current().length !== expectedGroups.size)
    throw new Error('Pipeline group count mismatch');
  expectedGroups.forEach((count, group) => {
    if (views.groupIndex.item(group).current() !== count)
      throw new Error('Pipeline membership mismatch: ' + group);
  });
};

const operationsFor = (
  scenario: string,
  index: number,
  input: Size
): readonly DocumentOperation[] => {
  if (scenario === 'hot scalar update')
    return [{ type: 'field.set', at: ['metadata', 'value'], value: index }];
  if (scenario === 'unrelated metadata')
    return [{ type: 'field.set', at: ['metadata', 'note'], value: `note-${index}` }];
  if (scenario === 'update 50 items')
    return Array.from({ length: Math.min(50, input.items) }, (_, offset) => ({
      type: 'field.set' as const,
      at: ['items', `item-${(index * 50 + offset) % input.items}`, 'value'],
      value: index + offset,
    }));
  if (scenario === 'create 100 items')
    return [
      {
        type: 'entity.create',
        at: ['items'],
        entries: Array.from({ length: Math.min(100, input.items) }, (_, offset) => ({
          id: `created-${index}-${offset}`,
          value: {
            group: `group-${(index + offset) % input.groups}`,
            value: offset,
          },
        })),
      },
    ];
  if (scenario === 'remove 100 items')
    return [
      {
        type: 'entity.remove',
        at: ['items'],
        ids: Array.from(
          { length: Math.min(100, input.items) },
          (_, offset) => `item-${(index * 100 + offset) % input.items}`
        ),
      },
    ];
  if (scenario === 'link churn')
    return [
      {
        type: 'field.set',
        at: ['links', `link-${index % input.links}`, 'to'],
        value: `item-${(index * 31 + 7) % input.items}`,
      },
    ];
  if (scenario === 'group move')
    return [
      {
        type: 'field.set',
        at: ['items', `item-${index % input.items}`, 'group'],
        value: `group-${(index * 3 + 1) % input.groups}`,
      },
    ];
  return [
    {
      type: 'entity.remove',
      at: ['items'],
      ids: Array.from(
        { length: Math.min(100, input.items) },
        (_, offset) => `item-${(index * 100 + offset) % input.items}`
      ),
    },
  ];
};

const applyScenario = (
  runtime: DocumentRuntime<typeof documentSchema>,
  scenario: string,
  index: number
) => {
  const operations =
    scenario === 'remove 100 items' || scenario === 'delete + undo'
      ? [
          {
            type: 'entity.remove' as const,
            at: ['items'],
            ids: (
              (runtime.address.read(['items']) as { readonly ids?: readonly string[] } | undefined)
                ?.ids ?? []
            ).slice(0, Math.min(100, size.items)),
          },
        ]
      : operationsFor(scenario, index, size);
  const result = runtime.apply(operations);
  if (result.status === 'rejected')
    throw new Error(`${scenario} rejected: ${result.issues[0]?.message}`);
  return result;
};

const restoreRemovedItems = (
  runtime: DocumentRuntime<typeof documentSchema>,
  scenario: string,
  result: ReturnType<DocumentRuntime<typeof documentSchema>['apply']>
): void => {
  if (scenario !== 'remove 100 items' || result.status !== 'committed') return;
  const restored = runtime.apply(result.commit.inverse, { source: 'system', history: false });
  if (restored.status === 'rejected')
    throw new Error(`remove 100 items restore rejected: ${restored.issues[0]?.message}`);
};

const runScenario = (scenario: string, pipeline: boolean): Row => {
  const runtime = createDocument({
    schema: documentSchema,
    initial: makeInitial(size),
    history: scenario === 'delete + undo' ? { capacity: 8 } : false,
  });
  const views = pipeline ? createPipeline(runtime) : undefined;
  for (let index = 0; index < Math.min(10, iterations); index += 1) {
    const result = applyScenario(runtime, scenario, index);
    restoreRemovedItems(runtime, scenario, result);
  }
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const actionStarted = performance.now();
    const result = applyScenario(runtime, scenario, index + 10);
    if (scenario === 'delete + undo') {
      const undo = runtime.history.undo();
      if (undo.status === 'rejected') throw new Error('undo rejected');
    }
    samples.push(performance.now() - actionStarted);
    restoreRemovedItems(runtime, scenario, result);
  }
  const totalMs = samples.reduce((total, sample) => total + sample, 0);
  const sorted = [...samples].sort((a, b) => a - b);
  const profileIterations = scenario === 'remove 100 items' ? 1 : Math.min(iterations, 20);
  const measured = measureProfile(() => {
    let result: ReturnType<DocumentRuntime<typeof documentSchema>['apply']> | undefined;
    for (let index = 0; index < profileIterations; index += 1) {
      result = applyScenario(runtime, scenario, index + iterations + 20);
      if (scenario === 'delete + undo') runtime.history.undo();
    }
    return result;
  });
  if (scenario === 'remove 100 items' && measured.value)
    restoreRemovedItems(runtime, scenario, measured.value);
  const heapBefore = Math.round(process.memoryUsage().heapUsed / 1024);
  const oracleStarted = performance.now();
  const oracleRuntime = createDocument({
    schema: documentSchema,
    initial: makeInitial(size),
    history: scenario === 'delete + undo' ? { capacity: 8 } : false,
  });
  const oracleViews = pipeline ? createPipeline(oracleRuntime) : undefined;
  for (let index = 0; index < iterations; index += 1) {
    const result = applyScenario(oracleRuntime, scenario, index + 10);
    if (scenario === 'delete + undo') oracleRuntime.history.undo();
    if (oracleViews && ((index + 1) % 100 === 0 || index === iterations - 1))
      validatePipeline(oracleRuntime, oracleViews, `${scenario} @ ${index}`);
    restoreRemovedItems(oracleRuntime, scenario, result);
  }
  oracleViews?.projection.dispose();
  oracleRuntime.dispose();
  const oracleMs = performance.now() - oracleStarted;
  views?.projection.dispose();
  runtime.dispose();
  const gcStarted = performance.now();
  if (gcExposed) (globalThis as unknown as { gc: () => void }).gc();
  const gcMs = performance.now() - gcStarted;
  const heapAfter = Math.round(process.memoryUsage().heapUsed / 1024);
  return {
    scenario,
    scale: scaleName,
    pipeline,
    iterations,
    commits: iterations * (scenario === 'delete + undo' ? 2 : 1),
    averageUs: Number(((totalMs * 1000) / iterations).toFixed(2)),
    p50Us: Number((sorted[Math.floor(sorted.length * 0.5)] * 1000).toFixed(2)),
    maxUs: Number((sorted[sorted.length - 1] * 1000).toFixed(2)),
    p95Us: Number(
      (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 1000).toFixed(2)
    ),
    oracleMs: Number(oracleMs.toFixed(3)),
    heapBefore,
    heapAfter,
    gcMs: Number(gcMs.toFixed(3)),
    profile: measured.profile,
  };
};

const scenarios = [
  'hot scalar update',
  'unrelated metadata',
  'update 50 items',
  'create 100 items',
  'remove 100 items',
  'link churn',
  'group move',
  'delete + undo',
];

const rows = scenarios.flatMap(scenario => [
  runScenario(scenario, false),
  runScenario(scenario, true),
]);
console.log(`Document workload profile: ${scaleName}`);
console.table([
  {
    node: process.version,
    platform: process.platform,
    seed,
    gcExposed,
    items: size.items,
    links: size.links,
    groups: size.groups,
  },
]);
console.table(
  rows.map(row => ({
    scenario: row.scenario,
    pipeline: row.pipeline,
    iterations: row.iterations,
    averageUs: row.averageUs,
    p50Us: row.p50Us,
    maxUs: row.maxUs,
    p95Us: row.p95Us,
    oracleMs: row.oracleMs,
    operations: row.profile.mutation.executed,
    journalSubjects: row.profile.journal.subjects,
    orderSnapshots: row.profile.journal.orderSnapshots,
    orderItems: row.profile.journal.orderItems,
    materializedUpdated: row.profile.materialized.updated,
    materializedSkipped: row.profile.materialized.skipped,
    materializedRebuilt: row.profile.materialized.rebuilt,
    touchedKeys: row.profile.projection.touchedKeys,
    changedKeys: row.profile.projection.changedKeys,
    processedNodes: row.profile.projection.processedNodes,
    heapBeforeKb: row.heapBefore,
    heapAfterKb: row.heapAfter,
    gcMs: row.gcMs,
  }))
);
if (jsonPath)
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ node: process.version, platform: process.platform, seed, gcExposed, scale: scaleName, size, iterations, rows }, null, 2)}\n`,
    'utf8'
  );
