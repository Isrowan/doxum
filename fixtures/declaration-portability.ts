import { derive, field, input, list, map, object, optional, table, tree, variant } from 'doxum';
import { incremental } from 'doxum/advanced';

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

export const portableIncrementalCollection = incremental.collection(
  { rows: portableRows },
  {
    process: ({ values, output }) => {
      for (const [key, row] of values.rows) output.set(key, row.value);
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
