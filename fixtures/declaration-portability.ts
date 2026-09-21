import { derive, field, input, list, map, object, optional, table, tree, variant } from 'doxum';
import { collectionChange, incremental } from 'doxum/advanced';

const entity = object({
  label: field<string>(),
  score: field<number>(),
});
const choice = variant('kind', {
  text: object({ value: field<string>() }),
  count: object({ value: field<number>() }),
});

export const portableSchema = object({
  title: field<string>(),
  subtitle: optional(field<string>()),
  entities: map(entity),
  orderedEntities: table(entity),
  tags: list(field<{ readonly id: string; readonly label: string }>(), {
    keyOf: value => value.id,
  }),
  hierarchy: tree(field<{ readonly label: string }>()),
  optionalHierarchy: optional(tree(optional(field<{ readonly label: string }>()))),
  choice,
  optionalChoice: optional(choice),
});

export const portableRows = input.collection<
  string,
  { readonly value: number; readonly entityId: string }
>();
export const portableEntities = input.collection<string, { readonly label: string }>();

export const portableSelected = derive.keyed(portableRows, row => row.value);
export const portableKeys = derive.keyed.keys(portableRows);
export const portableValues = derive.keyed.values(portableRows);
export const portableEntries = derive.keyed.entries(portableRows);
export const portableFrom = derive.keyed.from(portableValues, row => row.entityId);
export const portableMerged = derive.keyed.merge([portableFrom, portableRows], {
  conflict: 'last',
});
export const portableResolvedMerge = derive.keyed.merge([portableFrom, portableRows], {
  conflict: 'resolve',
  resolve: contributions => contributions[contributions.length - 1].value,
});
export const portableActiveKey = input<string | undefined>('row-a');
export const portableActiveRow = derive.keyed.get(portableRows, portableActiveKey);
export const portableSubset = derive.keyed.subset(portableRows, ['row-a', 'row-b'] as const);
export const portableFiltered = derive.keyed.filter(portableRows, row => row.value > 0);
export const portableFilteredWithDependency = derive.keyed.filter(
  portableRows,
  {
    entity: {
      source: portableEntities,
      key: (row: { readonly entityId: string }) => row.entityId,
    },
  },
  (row, _rowId, dependencies) => row.value > 0 && dependencies.entity !== undefined
);
export const portableFilteredValue = derive.keyed(portableFilteredWithDependency, row => row.value);
export const portableCompacted = derive.keyed.compact(portableRows, row =>
  row.value > 0 ? row.value : undefined
);
export const portableJoined = derive.keyed(
  portableRows,
  {
    entity: {
      source: portableEntities,
      key: (row: { readonly value: number; readonly entityId: string }) => row.entityId,
    },
  },
  (row, _rowId, dependencies) => `${dependencies.entity?.label ?? ''}:${row.value}`
);
export const portablePluralJoined = derive.keyed(
  portableRows,
  {
    entities: {
      source: portableEntities,
      keys: (row: { readonly entityId: string }) => [row.entityId],
    },
  },
  (row, _rowId, dependencies) => dependencies.entities.get(row.entityId)?.label
);
export const portableGrouped = derive.keyed.groupBy(portableRows, row => row.entityId);
export const portableOptional = input<{ readonly id: string; readonly value: number } | undefined>(
  undefined
);
export const portableSingleton = derive.keyed.singleton(portableOptional, value => value.id);

export const portableIncrementalCollection = incremental.collection(
  { rows: portableRows },
  {
    process: ({ values, output }) => {
      for (const [key, row] of values.rows) output.set(key, row.value);
    },
  }
);
export const portableIncrementalKeyed = incremental.keyed(
  portableRows,
  {
    entity: {
      source: portableEntities,
      key: (row: { readonly entityId: string }) => row.entityId,
    },
  },
  {
    state: () => ({ runs: 0 }),
    process: ({ value, dependencies, state }) => {
      state.runs++;
      return `${state.runs}:${dependencies.entity?.label ?? ''}:${value.value}`;
    },
  }
);

export const portableGroup = incremental.group(
  { rows: portableRows },
  {
    output: define => ({
      values: define.collection<string, number>(),
      summary: {
        count: define.value<number>(),
      },
    }),
    process: ({ values, output }) => {
      for (const [key, row] of values.rows) output.values.set(key, row.value);
      output.summary.count.set(values.rows.size);
    },
  }
);

export const portableGroupValues = portableGroup.values;
export const portableGroupCount = portableGroup.summary.count;
export const portableChangeKeys = collectionChange.keys;
