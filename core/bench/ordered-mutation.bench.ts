import { afterAll, bench, describe } from 'vitest';
import { createDocument, field, list, object } from '../src';

const count = 10_000;
const movedCount = 1_000;
const ids = Array.from({ length: count }, (_, index) => String(index));
const selected = ids.slice(0, movedCount);
const key = (id: string) => `node\0${id}`;
const selectedKeys = selected.map(key);
const forward = ids.map(key);
const reverse = [...forward].reverse();

const schema = object({
  items: list(field<{ id: string }>(), { keyOf: value => key(value.id) }),
});

const createRuntime = () =>
  createDocument({
    schema,
    initial: { items: ids.map(id => ({ id })) },
    history: false,
  });

describe('ordered list mutations', () => {
  const single = createRuntime();
  let singleAtStart = true;
  afterAll(() => single.dispose());
  bench(
    'single move in 10k',
    () => {
      const result = single.update(draft => {
        draft.items.move(key('0'), singleAtStart ? undefined : { at: 'start' });
      });
      singleAtStart = !singleAtStart;
      if (result.status !== 'committed') throw new Error('Single move benchmark failed.');
    },
    { time: 100, iterations: 5 }
  );

  const sequential = createRuntime();
  let sequentialAtStart = true;
  afterAll(() => sequential.dispose());
  bench(
    '1000 sequential single moves in 10k',
    () => {
      const result = sequential.update(draft => {
        if (sequentialAtStart) {
          for (const id of selectedKeys) draft.items.move(id);
        } else {
          for (let index = selectedKeys.length - 1; index >= 0; index--)
            draft.items.move(selectedKeys[index], { at: 'start' });
        }
      });
      sequentialAtStart = !sequentialAtStart;
      if (result.status !== 'committed') throw new Error('Sequential move benchmark failed.');
    },
    { time: 100, iterations: 3 }
  );

  const bulk = createRuntime();
  let bulkAtStart = true;
  afterAll(() => bulk.dispose());
  bench(
    'bulk move 1000 in 10k',
    () => {
      const result = bulk.update(draft => {
        draft.items.move(selectedKeys, bulkAtStart ? undefined : { at: 'start' });
      });
      bulkAtStart = !bulkAtStart;
      if (result.status !== 'committed') throw new Error('Bulk move benchmark failed.');
    },
    { time: 100, iterations: 5 }
  );

  const reordered = createRuntime();
  let reversed = false;
  afterAll(() => reordered.dispose());
  bench(
    'exact reorder 10k',
    () => {
      const result = reordered.update(draft => {
        draft.items.reorder(reversed ? forward : reverse);
      });
      reversed = !reversed;
      if (result.status !== 'committed') throw new Error('Reorder benchmark failed.');
    },
    { time: 100, iterations: 5 }
  );
});
