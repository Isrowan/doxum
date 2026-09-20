import {
  createDocument,
  createProjectionRuntime,
  derive,
  field,
  input,
  map,
  object,
  observe,
  read,
  replace,
  snapshot,
  type Infer,
  type KeyedProjection,
  type Projection,
} from 'doxum';
// @ts-expect-error processor-facing CollectionChange is intentionally not a root export
import type { CollectionChange as RootCollectionChange } from 'doxum';
import {
  collectionChange,
  incremental,
  type CollectionChange,
  type IncrementalGroupOutput,
  type IncrementalGroupResult,
} from 'doxum/advanced';
import {
  LocalSyncError,
  attachLocalSync,
  defaultJsonChangeLimits,
  type AttachLocalSyncOptions,
} from 'doxum/local-sync';
import {
  ProjectionProvider,
  useDocumentSelector,
  useHistory,
  useInput,
  useProjection,
  useReadable,
} from 'doxum/react';

const schema = object({
  title: field<string>(),
  rows: map(object({ value: field<number>(), entityId: field<string>() })),
});
type Model = Infer<typeof schema>;
const initial: Model = { title: 'demo', rows: { a: { value: 1, entityId: 'e1' } } };
const document = createDocument({ schema, initial });
document.update(draft => {
  draft.title = 'updated';
  draft.rows.put('b', { value: 2, entityId: 'e2' });
  replace(draft, 'title', 'replaced');
});
document.replace(initial);
snapshot(read(document, value => value.rows));
// @ts-expect-error remote replay invalidates local history and has no history option
document.apply({} as never, {
  expectedRevision: document.revision(),
  source: 'remote',
  history: false,
});

const rows = observe(document, path => path.rows);
const entities = input.collection(
  new Map([
    ['e1', { label: 'One' }],
    ['e2', { label: 'Two' }],
  ])
);
const mode = input<'compact' | 'full'>('compact');
const labels = derive.keyed(
  rows,
  {
    entity: {
      source: entities,
      key: (row: { readonly value: number; readonly entityId: string }) => row.entityId,
    },
    mode,
  },
  (row, _rowId, dependencies) =>
    dependencies.mode === 'compact'
      ? dependencies.entity?.label
      : `${dependencies.entity?.label ?? ''}:${row.value}`
);
const rowKeys = derive.keyed.keys(rows);
const rowValues = derive.keyed.values(rows);
const positiveRows = derive.keyed.filter(rows, row => row.value > 0);
const selectedRows = derive.keyed.subset(rows, rowKeys);
const optionalLabels = derive.keyed.compact(rows, row =>
  row.value > 0 ? row.entityId : undefined
);
const count = derive({ rows }, ({ rows }) => rows.size);
const group = incremental.group(
  { rows },
  {
    output: define => ({
      values: define.collection<string, number>(),
      count: define.value<number>(),
    }),
    process: ({ values, output }) => {
      output.count.set(values.rows.size);
      for (const [key, row] of values.rows) output.values.set(key, row.value);
      output.values.order([...values.rows.keys()]);
    },
  }
);
const keyedRows: KeyedProjection<string, { readonly value: number; readonly entityId: string }> =
  rows;
const keyedLabels: KeyedProjection<string, string | undefined> = labels;
const keyedGroupValues: KeyedProjection<string, number> = group.values;
type PortableGroupShape = {
  readonly values: IncrementalGroupOutput<KeyedProjection<string, number>>;
  readonly count: IncrementalGroupOutput<Projection<number>>;
};
const portableGroupResult: IncrementalGroupResult<PortableGroupShape> = group;

const runtime = createProjectionRuntime();
runtime.read(count);
runtime.read(labels);
runtime.read(rowKeys);
runtime.read(rowValues);
runtime.read(positiveRows);
runtime.read(selectedRows);
runtime.read(optionalLabels);
runtime.read(group.count);
runtime.update(mode, 'full');
runtime.update(entities, draft => draft.set('e3', { label: 'Three' }));
runtime.batch(() => runtime.update(mode, 'compact'), { cause: 'fixture' });
// @ts-expect-error batch is callback-first
runtime.batch({ cause: 'fixture' }, () => undefined);
// @ts-expect-error ProjectionRuntime has no legacy get API
runtime.get(count);
const scope = runtime.scope();
const scoped = scope.own(derive({ count }, ({ count }) => count + 1));
scope.read(scoped);
// @ts-expect-error scopes own definitions but do not copy derive factories
scope.derive({ count }, ({ count }: { count: number }) => count);
scope.dispose();
runtime.dispose();

const syncOptions = {} as AttachLocalSyncOptions<typeof schema>;
void attachLocalSync;
void syncOptions;
void LocalSyncError;
void defaultJsonChangeLimits;
void (undefined as unknown as CollectionChange<string, number>);
const incrementalChange = undefined as unknown as Extract<
  CollectionChange<string, number>,
  { kind: 'incremental' }
>;
void collectionChange.keys(incrementalChange);
void (undefined as unknown as RootCollectionChange<string, number>);
void keyedRows;
void keyedLabels;
void keyedGroupValues;
void portableGroupResult;
void ProjectionProvider;
void useDocumentSelector;
void useHistory;
void useInput;
void useProjection;
void useReadable;
