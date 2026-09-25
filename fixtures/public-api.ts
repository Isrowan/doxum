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
  type ProjectionItems,
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
const rowMetadata = input.collection<string, { readonly note: string }>();
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
const sameKeyNotes = derive.keyed(
  rows,
  { metadata: { source: rowMetadata } },
  (_row, _rowId, dependencies) => dependencies.metadata?.note
);

declare const rowIdBrand: unique symbol;
declare const entityIdBrand: unique symbol;
type RowId = string & { readonly [rowIdBrand]: true };
type EntityId = string & { readonly [entityIdBrand]: true };
const brandedRows = input.collection<RowId, number>();
const broadMetadata = input.collection<string, number>();
const exactMetadata = input.collection<RowId, number>();
const incompatibleMetadata = input.collection<EntityId, number>();
derive.keyed(brandedRows, { broad: { source: broadMetadata } }, value => value);
derive.keyed(brandedRows, { exact: { source: exactMetadata } }, value => value);
// @ts-expect-error same-key dependency requires DriverKey to be assignable to SourceKey
derive.keyed(brandedRows, { incompatible: { source: incompatibleMetadata } }, value => value);
const broadRows = input.collection<string, number>();
// @ts-expect-error a broad driver key cannot safely index a narrower branded source
derive.keyed(broadRows, { metadata: { source: exactMetadata } }, value => value);
const rowKeys = derive.keyed.keys(rows);
const rowValues = derive.keyed.values(rows);
const rowEntries = derive.keyed.entries(rows);
const rowsFromValues = derive.keyed.from(rowValues, row => row.entityId);
const syntheticRows = derive.keyed.from([{ value: 0, entityId: 'synthetic' }], row => row.entityId);
const mergedRows = derive.keyed.merge([syntheticRows, rows], { conflict: 'last' });
const resolvedRows = derive.keyed.merge([syntheticRows, rows], {
  conflict: 'resolve',
  resolve: contributions => contributions[contributions.length - 1].value,
});
// @ts-expect-error merge requires an explicit conflict policy
derive.keyed.merge([syntheticRows, rows], {});
// @ts-expect-error resolver is only valid for conflict: 'resolve'
derive.keyed.merge([syntheticRows, rows], { conflict: 'last', resolve: () => initial.rows.a });
const activeRowId = input<string | undefined>('a');
const activeRow = derive.keyed.get(rows, activeRowId);
const positiveRows = derive.keyed.filter(rows, row => row.value > 0);
const selectedRows = derive.keyed.subset(rows, rowKeys);
const optionalLabels = derive.keyed.compact(rows, row =>
  row.value > 0 ? row.entityId : undefined
);
const rowsByEntity = derive.keyed.groupBy(rows, row => row.entityId);
const optionalRow = input<{ readonly id: string; readonly value: number } | undefined>(undefined);
const singletonRow = derive.keyed.singleton(optionalRow, row => row.id);
const pluralLabels = derive.keyed(
  rows,
  {
    entities: {
      source: entities,
      keys: (row: { readonly entityId: string }) => [row.entityId],
    },
  },
  (row, _rowId, dependencies) => dependencies.entities.get(row.entityId)?.label
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
const statefulRows = incremental.keyed(
  rows,
  {
    entities: {
      source: entities,
      keys: (row: { readonly entityId: string }) => [row.entityId],
    },
  },
  {
    state: () => ({ runs: 0 }),
    process: ({ value, dependencies, state }) => {
      state.runs++;
      return `${state.runs}:${dependencies.entities.get(value.entityId)?.label ?? ''}`;
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
runtime.read(sameKeyNotes);
runtime.read(rowKeys);
runtime.read(rowValues);
runtime.read(rowEntries);
runtime.read(rowsFromValues);
runtime.read(mergedRows);
runtime.read(resolvedRows);
runtime.read(activeRow);
runtime.read(positiveRows);
runtime.read(selectedRows);
runtime.read(optionalLabels);
runtime.read(rowsByEntity);
runtime.read(singletonRow);
runtime.read(pluralLabels);
runtime.read(statefulRows);
runtime.read(group.count);
const rowItems: ProjectionItems<string, { readonly value: number; readonly entityId: string }> =
  runtime.items(rows);
void rowItems.keys.current();
void rowItems.get('a').current();
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
void scope.items(rows).get('a').current();
// @ts-expect-error scopes own definitions but do not copy derive factories
scope.derive({ count }, ({ count }: { count: number }) => count);
// Current reads preserve projection types; batch commands remain synchronous.
const batchCount = input(0);
const batchRows = input.collection<string, number>();
const batchResult: number = runtime.batch(() => {
  const current: number = runtime.read(batchCount);
  const currentRows: ReadonlyMap<string, number> = runtime.read(batchRows);
  runtime.update(batchCount, current + currentRows.size);
  runtime.read(count);
  runtime.read(rows);
  return runtime.read(batchCount);
});
const scopedBatchResult: number = scope.batch(() => scope.read(batchCount));
// @ts-expect-error batch no longer lends a source-only reader
runtime.batch((read: (source: typeof batchCount) => number) => read(batchCount));
// @ts-expect-error batch commands must be synchronous
runtime.batch(async () => runtime.read(batchCount));
// @ts-expect-error scope commands must be synchronous
scope.batch(async () => runtime.read(batchCount));
// @ts-expect-error union Promise returns must not weaken the synchronous contract
runtime.batch(() => (Math.random() > 0.5 ? 1 : Promise.resolve(1)));
// @ts-expect-error collection editors must be synchronous
runtime.update(batchRows, async draft => draft.set('a', 1));
// @ts-expect-error scope collection editors must be synchronous
scope.update(batchRows, async draft => draft.set('a', 1));
// @ts-expect-error union Promise editor results are rejected
runtime.update(batchRows, () => (Math.random() > 0.5 ? undefined : Promise.resolve()));
// @ts-expect-error scalar updates do not widen the declared value type
runtime.update(batchCount, 'wrong');
const batchFunction = input<(value: number) => number>(value => value);
runtime.batch(() => {
  const previous = runtime.read(batchFunction);
  runtime.update(batchFunction, value => previous(value) + 1);
});
const [, editHookRows] = useInput(batchRows);
// @ts-expect-error React editors preserve the core synchronous contract
editHookRows(async draft => draft.set('a', 1));

const flatChildren: KeyedProjection<string, number> = derive.keyed.flatMap(rows, row => [
  ['child', row.value],
]);
const flatDependencies: KeyedProjection<string, string> = derive.keyed.flatMap(
  rows,
  { entity: { source: entities, key: row => row.entityId } },
  (row, key, dependencies) => [[key, `${row.value}:${dependencies.entity?.label}`]]
);
const flatUndefined: KeyedProjection<string, undefined> = derive.keyed.flatMap(
  rows,
  (_row, key) => [[key, undefined]]
);
const flatEmpty = derive.keyed.flatMap(rows, () => []);
const childKey = 'child' as RowId;
const flatBranded: KeyedProjection<RowId, number> = derive.keyed.flatMap(rows, row => [
  [childKey, row.value],
]);
// @ts-expect-error flatMap must return ordered keyed tuples
derive.keyed.flatMap(rows, row => [row.value]);
// @ts-expect-error flatMap selectors must be synchronous
derive.keyed.flatMap(rows, async row => [['child', row.value] as const]);
// @ts-expect-error output keys must be strings
derive.keyed.flatMap(rows, row => [[1, row.value]]);
const unionDriver = input.collection<'a' | 'b', number>();
const narrowLookup = input.collection<'a', number>();
// @ts-expect-error same-key lookup must cover every driver key
derive.keyed.flatMap(unionDriver, { item: { source: narrowLookup } }, (_value, key) => [[key, 1]]);
// @ts-expect-error the shared same-key protocol rejects partially overlapping key unions
derive.keyed(unionDriver, { item: { source: narrowLookup } }, value => value);
void batchResult;
void scopedBatchResult;
void flatChildren;
void flatDependencies;
void flatUndefined;
void flatEmpty;
void flatBranded;
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
void sameKeyNotes;
void keyedGroupValues;
void rowEntries;
void rowsFromValues;
void mergedRows;
void resolvedRows;
void activeRow;
void rowsByEntity;
void singletonRow;
void pluralLabels;
void statefulRows;
void rowItems;
void portableGroupResult;
void ProjectionProvider;
void useDocumentSelector;
void useHistory;
void useInput;
void useProjection;
void useReadable;

const entryProjection: KeyedProjection<string, number | undefined> = derive.keyed.fromEntries(
  { mode, rows, activeRow },
  ({ mode, rows, activeRow }) =>
    mode === 'compact'
      ? [['active', activeRow?.value]]
      : [...rows].map(([key, row]) => [key, row.value])
);
const entryValue: number | undefined = runtime.items(entryProjection).get('active').current();
const inferredEntryProjection = derive.keyed.fromEntries(
  { mode },
  ({ mode }) => [['a', { mode }]],
  (left, right) => left.mode === right.mode
);
const inferredEntryValue: 'compact' | 'full' | undefined = runtime
  .read(inferredEntryProjection)
  .get('a')?.mode;
const brandedEntries: KeyedProjection<RowId, number> = derive.keyed.fromEntries(
  { brandedRows },
  ({ brandedRows }) => [...brandedRows]
);
// @ts-expect-error a single projection is not a named dependency object
derive.keyed.fromEntries(mode, value => []);
// @ts-expect-error dependency entries must be projections
derive.keyed.fromEntries({ mode: 'compact' }, () => []);
// @ts-expect-error dynamic keyed specs are not the pure named projection protocol
derive.keyed.fromEntries({ rows: { source: rows } }, () => []);
// @ts-expect-error compute must be synchronous
derive.keyed.fromEntries({ mode }, async () => [['a', 1]]);
derive.keyed.fromEntries({ mode }, () =>
  // @ts-expect-error optional async branches remain forbidden
  Math.random() ? ([['a', 1]] as const) : Promise.resolve([])
);
// @ts-expect-error keyed entry keys must be strings
derive.keyed.fromEntries({}, () => [[1, 'value']]);
// @ts-expect-error entries must contain exactly key and value
derive.keyed.fromEntries({}, () => [['a']]);
const incompatibleEntryEquality = (a: string, b: string) => a === b;
// @ts-expect-error compute and equality must accept the same value type
derive.keyed.fromEntries({}, () => [['a', 1]], incompatibleEntryEquality);
const readonlyEntries = derive.keyed.fromEntries({ mode }, values => {
  // @ts-expect-error named values are readonly
  values.mode = 'full';
  return [['a', values.mode]] as const;
});
void [entryValue, inferredEntryValue, brandedEntries, readonlyEntries];

// Inference is checked after construction: output annotations must not hide a regression.
type PreviewValue =
  | { readonly kind: 'cell'; readonly cellId: string }
  | { readonly kind: 'range'; readonly ids: readonly string[] };
const previewInput = input<PreviewValue | undefined>(undefined);
const equalPreview = (left: PreviewValue, right: PreviewValue) => left.kind === right.kind;
const inferredPreview = derive.keyed.fromEntries(
  { preview: previewInput },
  ({ preview }) => (preview ? [['preview', preview]] : []),
  equalPreview
);
const inferredSelection = derive.keyed.fromEntries(
  { mode },
  ({ mode }) => {
    if (mode === 'compact') return [];
    if (Math.random()) return [['preview', { kind: 'cell' as const, cellId: 'a' }]];
    return [['preview', { kind: 'range' as const, ids: ['a', 'b'] }]];
  },
  equalPreview
);
const previewValue: PreviewValue | undefined = runtime.read(inferredPreview).get('preview');
const selectionValue: PreviewValue | undefined = runtime.read(inferredSelection).get('preview');
const previewItem = runtime.items(inferredPreview).get('preview').current();
if (previewItem?.kind === 'cell') {
  const cellId: string = previewItem.cellId;
  // @ts-expect-error the inferred union must not degrade to any
  previewItem.ids;
  void cellId;
}
const brandedPreview = derive.keyed.fromEntries(
  { id: input<RowId | undefined>(undefined), preview: previewInput },
  ({ id, preview }) => {
    if (!id || !preview) return [];
    return [[id, preview]];
  },
  equalPreview
);
const brandedPreviewCheck: KeyedProjection<RowId, PreviewValue> = brandedPreview;
const optionalPreview = derive.keyed.fromEntries(
  { mode, preview: previewInput },
  ({ mode, preview }) => (mode === 'compact' ? [] : [['preview', preview]]),
  (left: PreviewValue | undefined, right: PreviewValue | undefined) => left?.kind === right?.kind
);
const optionalPreviewCheck: KeyedProjection<string, PreviewValue | undefined> = optionalPreview;

const broadEntryEquality = (left: unknown, right: unknown) => Object.is(left, right);
const broadEqualityResult = derive.keyed.fromEntries(
  { mode },
  ({ mode }) => (mode === 'compact' ? [] : [['count', 1]]),
  broadEntryEquality
);
const objectIsResult = derive.keyed.fromEntries(
  { mode },
  ({ mode }) => (mode === 'compact' ? [] : [['count', 1]]),
  Object.is
);
const broadEntryValue: number | undefined = runtime.read(broadEqualityResult).get('count');
const objectIsEntryValue: number | undefined = runtime.read(objectIsResult).get('count');
// @ts-expect-error Object.is must not widen the inferred value to any
const invalidObjectIsValue: string = runtime.read(objectIsResult).get('count');

const equalCell = (
  left: Extract<PreviewValue, { kind: 'cell' }>,
  right: Extract<PreviewValue, { kind: 'cell' }>
) => left.cellId === right.cellId;
derive.keyed.fromEntries(
  { preview: previewInput },
  // @ts-expect-error equality must support every value variant compute can emit
  ({ preview }) => (preview ? [['preview', preview]] : []),
  equalCell
);
const annotatedPreview: KeyedProjection<string, PreviewValue> = derive.keyed.fromEntries(
  { preview: previewInput },
  ({ preview }) => (preview ? [['preview', preview]] : []),
  equalPreview
);
void [
  previewValue,
  selectionValue,
  brandedPreviewCheck,
  optionalPreviewCheck,
  broadEntryValue,
  objectIsEntryValue,
  invalidObjectIsValue,
  annotatedPreview,
];

const singletonPreview = derive.keyed.singleton(
  { preview: previewInput },
  ({ preview }) => (preview === undefined ? undefined : ['preview', preview]),
  equalPreview
);
const singletonSelection = derive.keyed.singleton(
  { mode },
  ({ mode }) => {
    if (mode === 'compact') return undefined;
    if (Math.random()) return ['preview', { kind: 'cell' as const, cellId: 'a' }];
    return ['preview', { kind: 'range' as const, ids: ['a'] }];
  },
  equalPreview
);
const singletonPreviewValue: PreviewValue | undefined = runtime
  .read(singletonPreview)
  .get('preview');
const singletonSelectionValue: PreviewValue | undefined = runtime
  .read(singletonSelection)
  .get('preview');
const singletonItem = runtime.items(singletonPreview).get('preview').current();
if (singletonItem?.kind === 'cell') {
  const id: string = singletonItem.cellId;
  // @ts-expect-error inferred union must not degrade to any
  singletonItem.ids;
  void id;
}
const brandedSingleton = derive.keyed.singleton(
  { id: input<RowId | undefined>(undefined), preview: previewInput },
  ({ id, preview }) => (id === undefined || preview === undefined ? undefined : [id, preview]),
  equalPreview
);
const brandedSingletonCheck: KeyedProjection<RowId, PreviewValue> = brandedSingleton;
const optionalSingleton = derive.keyed.singleton(
  { mode, preview: previewInput },
  ({ mode, preview }) => (mode === 'compact' ? undefined : ['preview', preview]),
  (left: PreviewValue | undefined, right: PreviewValue | undefined) => left?.kind === right?.kind
);
const optionalSingletonCheck: KeyedProjection<string, PreviewValue | undefined> = optionalSingleton;
const inlineSingleton = derive.keyed.singleton(
  { mode },
  ({ mode }) => (mode === 'compact' ? undefined : ['value', { n: 1 }]),
  (left, right) => left.n === right.n
);
const inlineSingletonValue: number | undefined = runtime.read(inlineSingleton).get('value')?.n;
const objectIsSingleton = derive.keyed.singleton(
  { mode },
  ({ mode }) => (mode === 'compact' ? undefined : ['count', 1]),
  Object.is
);
const unknownEqualitySingleton = derive.keyed.singleton(
  { mode },
  ({ mode }) => (mode === 'compact' ? undefined : ['count', 1]),
  broadEntryEquality
);
const singletonNumber: number | undefined = runtime.read(objectIsSingleton).get('count');
const unknownEqualityNumber: number | undefined = runtime
  .read(unknownEqualitySingleton)
  .get('count');
// @ts-expect-error Object.is must not widen output to any
const invalidSingletonValue: string = runtime.read(objectIsSingleton).get('count');
const emptySingleton = derive.keyed.singleton({}, () => undefined);
const undefinedSingleton = derive.keyed.singleton({}, () => ['present', undefined]);
const undefinedSingletonCheck: KeyedProjection<'present', undefined> = undefinedSingleton;
const scalarConstantSingleton = derive.keyed.singleton(optionalRow, () => 'only');
const scalarConstantCheck: KeyedProjection<
  'only',
  { readonly id: string; readonly value: number }
> = scalarConstantSingleton;
const readonlySingleton = derive.keyed.singleton({ mode }, values => {
  // @ts-expect-error named dependency values are readonly
  values.mode = 'full';
  return ['mode', values.mode] as const;
});
// @ts-expect-error callback must be synchronous
derive.keyed.singleton({ mode }, async () => ['a', 1] as const);
// @ts-expect-error callback cannot return a promise in one branch
derive.keyed.singleton({ mode }, ({ mode }) =>
  mode === 'compact' ? undefined : Promise.resolve(['a', 1] as const)
);
// @ts-expect-error scalar form still requires a key selector, not an entry computation
derive.keyed.singleton(mode, value => ['a', value]);
// @ts-expect-error scalar key selectors must also be synchronous
derive.keyed.singleton(mode, async () => 'a');
// @ts-expect-error named form requires an entry, not a key selector
derive.keyed.singleton({ mode }, () => 'a');
// @ts-expect-error dependencies must be projections
derive.keyed.singleton({ mode: 'compact' }, () => ['a', 1]);
// @ts-expect-error driver-relative dependency specs are not supported
derive.keyed.singleton({ rows: { source: rows } }, () => ['a', 1]);
// @ts-expect-error empty membership is undefined, not an empty tuple
derive.keyed.singleton({}, () => []);
// @ts-expect-error entry must have exactly two fields
derive.keyed.singleton({}, () => ['a', 1, 2]);
// @ts-expect-error key must be a string
derive.keyed.singleton({}, () => [1, 'value']);
// @ts-expect-error equality must support all emitted variants
derive.keyed.singleton(
  { preview: previewInput },
  ({ preview }) => (preview ? ['a', preview] : undefined),
  equalCell
);
// @ts-expect-error incompatible equality is rejected
derive.keyed.singleton({}, () => ['a', 1], incompatibleEntryEquality);
void [
  singletonPreviewValue,
  singletonSelectionValue,
  brandedSingletonCheck,
  optionalSingletonCheck,
  inlineSingletonValue,
  singletonNumber,
  unknownEqualityNumber,
  invalidSingletonValue,
  emptySingleton,
  undefinedSingletonCheck,
  scalarConstantCheck,
  readonlySingleton,
];

// The queried source owns both key and value domains for every selection form.
const selectionRequest = input<{
  readonly ids: readonly RowId[];
  readonly active: RowId | undefined;
}>({ ids: [], active: undefined });
const computedSubset = derive.keyed.subset(
  brandedRows,
  { selection: selectionRequest, mode },
  ({ selection, mode }) => (mode === 'compact' ? [] : selection.ids)
);
const computedGet = derive.keyed.get(
  brandedRows,
  { selection: selectionRequest, mode },
  ({ selection, mode }) => (mode === 'compact' ? undefined : selection.active),
  (a, b) => a === b
);
const selectedSubsetCheck: KeyedProjection<RowId, number> = computedSubset;
const selectedGetCheck: number | undefined = runtime.read(computedGet);
const fixedGet = derive.keyed.get(brandedRows, childKey);
const emptyGet = derive.keyed.get(brandedRows, undefined);
const fixedSubset = derive.keyed.subset(brandedRows, {}, () => [childKey]);
const optionalGet = derive.keyed.get(brandedRows, {}, () => (Math.random() ? childKey : undefined));
const selectedItem: number | undefined = runtime.items(computedSubset).get(childKey).current();
const broadGet = derive.keyed.get(
  brandedRows,
  { selection: selectionRequest },
  ({ selection }) => selection.active,
  Object.is
);
// @ts-expect-error a broad comparator must not erase the source value type
const wrongGetValue: string = runtime.read(broadGet);
const readonlySelection = derive.keyed.subset(
  brandedRows,
  { selection: selectionRequest },
  values => {
    // @ts-expect-error named values are readonly
    values.selection = { ids: [], active: undefined };
    // @ts-expect-error input key arrays remain readonly
    values.selection.ids.push(childKey);
    return values.selection.ids;
  }
);
// @ts-expect-error source key domain cannot widen to unbranded strings
derive.keyed.subset(brandedRows, ['wrong']);
// @ts-expect-error scalar key arrays must agree with the source domain
derive.keyed.subset(brandedRows, input<readonly string[]>([]));
// @ts-expect-error computed keys must agree with the source domain
derive.keyed.subset(brandedRows, {}, () => ['wrong']);
// @ts-expect-error static get cannot widen the source key domain
derive.keyed.get(brandedRows, 'wrong');
// @ts-expect-error computed get cannot widen the source key domain
derive.keyed.get(brandedRows, {}, () => 'wrong');
// @ts-expect-error existing key projections remain constrained by the source
derive.keyed.get(brandedRows, input<string | undefined>(undefined));
// @ts-expect-error unrelated branded key domains are rejected
derive.keyed.subset(brandedRows, {}, () => ['other' as EntityId]);
// @ts-expect-error subset callback must be synchronous
derive.keyed.subset(brandedRows, {}, async () => [childKey]);
// @ts-expect-error get callback must be synchronous
derive.keyed.get(brandedRows, {}, async () => childKey);
// @ts-expect-error subset has no value equality option
derive.keyed.subset(brandedRows, {}, () => [childKey], Object.is);
// @ts-expect-error subset requires an array, not optional membership
derive.keyed.subset(brandedRows, {}, () => undefined);
// @ts-expect-error get requires a string key, not a key array
derive.keyed.get(brandedRows, {}, () => [childKey]);
// @ts-expect-error named dependencies must contain projections
derive.keyed.get(brandedRows, { id: childKey }, ({ id }) => id);
// @ts-expect-error driver-relative dependency specs do not belong to selection
derive.keyed.subset(brandedRows, { rows: { source: brandedRows } }, () => [childKey]);
// @ts-expect-error equality cannot change the source value domain
derive.keyed.get(brandedRows, childKey, (a: string, b: string) => a === b);
derive.keyed.get(
  brandedRows,
  {},
  () => childKey,
  // @ts-expect-error named get equality cannot change the source value domain
  (a: string, b: string) => a === b
);
void [
  selectedSubsetCheck,
  selectedGetCheck,
  fixedGet,
  emptyGet,
  fixedSubset,
  optionalGet,
  selectedItem,
  wrongGetValue,
  readonlySelection,
];
