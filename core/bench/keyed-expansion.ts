import { createProjectionRuntime, derive, input } from 'doxum';

type Child = { readonly id: string; readonly value: number };

/** Same workload for native expansion and the public scalar-composition alternative. */
export const createExpansionWorkload = (
  mode: 'flatMap' | 'scalar',
  parents = 10000,
  children = 3
) => {
  const initial = new Map(
    Array.from({ length: parents }, (_, i) => [
      String(i),
      Array.from({ length: children }, (_, j): Child => ({
        id: `${i}:${j}`,
        value: 0,
      })) as readonly Child[],
    ])
  );
  const source = input.collection(initial);
  let selectors = 0;
  let reorderKey = false;
  const expanded =
    mode === 'flatMap'
      ? derive.keyed.flatMap(source, items => {
          selectors++;
          return items.map(item => [item.id, item] as const);
        })
      : derive.keyed.from(
          derive({ values: derive.keyed.values(source) }, ({ values }) =>
            values.flatMap(items => {
              selectors++;
              return items;
            })
          ),
          item => item.id
        );
  const runtime = createProjectionRuntime();
  runtime.read(expanded);
  return {
    runtime,
    source,
    resetSelectors: () => {
      selectors = 0;
    },
    selectors: () => selectors,
    update: () =>
      runtime.batch(read => {
        const previous = read(source).get('0')!;
        runtime.update(source, d =>
          d.set(
            '0',
            previous.map((item, i) => (i === 0 ? { ...item, value: item.value + 1 } : item))
          )
        );
      }),
    reorder: () =>
      runtime.update(source, d => {
        const key = (reorderKey = !reorderKey) ? '0' : '1';
        const value = d.get(key)!;
        d.remove(key);
        d.set(key, value);
      }),
    transfer: () =>
      runtime.update(source, d => {
        const a = d.get('0')!;
        const b = d.get('1')!;
        d.set('0', b);
        d.set('1', a);
      }),
  };
};
