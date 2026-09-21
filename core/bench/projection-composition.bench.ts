import { afterAll, bench, describe } from 'vitest';
import { createProjectionRuntime, derive, input } from 'doxum';

const size = 10_000;
const target = `key-${size >> 1}`;
const ids = Array.from({ length: size }, (_, index) => `key-${index}`);
const values = ids.map((id, index) => Object.freeze({ id, value: index }));

const createFromFixture = () => {
  const source = input<readonly { readonly id: string; readonly value: number }[]>(values);
  const projection = derive.keyed.from(source, value => value.id);
  const runtime = createProjectionRuntime();
  runtime.read(projection);
  return { source, projection, runtime };
};

const fromValue = createFromFixture();
const fromReorder = createFromFixture();
const fromNoop = createFromFixture();
let fromValueRevision = size;
let fromValueCurrent = values as readonly { readonly id: string; readonly value: number }[];
let fromReorderCurrent = values as readonly { readonly id: string; readonly value: number }[];
let fromNoopCurrent = values as readonly { readonly id: string; readonly value: number }[];

const staticFrom = derive.keyed.from(values, value => value.id);

describe('derive.keyed.from', () => {
  bench(
    'initial materialization of 10000 static values',
    () => {
      const runtime = createProjectionRuntime();
      runtime.read(staticFrom);
      runtime.dispose();
    },
    { iterations: 5, time: 100 }
  );

  bench(
    'one value change in 10000 scalar values',
    () => {
      const next = [...fromValueCurrent];
      next[size >> 1] = { id: target, value: ++fromValueRevision };
      fromValueCurrent = next;
      fromValue.runtime.update(fromValue.source, next);
      fromValue.runtime.read(fromValue.projection).get(target);
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'reorder two values in 10000 scalar values',
    () => {
      const next = [...fromReorderCurrent];
      [next[0], next[1]] = [next[1], next[0]];
      fromReorderCurrent = next;
      fromReorder.runtime.update(fromReorder.source, next);
      fromReorder.runtime.read(fromReorder.projection).keys();
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'new outer array with identical 10000 member identities',
    () => {
      const next = [...fromNoopCurrent];
      fromNoopCurrent = next;
      fromNoop.runtime.update(fromNoop.source, next);
      fromNoop.runtime.read(fromNoop.projection).get(target);
    },
    { iterations: 10, time: 100 }
  );
});

const entries = ids.map((id, index) => [id, index] as const);

const createMergeFixture = (conflict: 'first' | 'last') => {
  const first = input.collection(new Map(entries));
  const second = input.collection(new Map([[target, -1]]));
  const projection = derive.keyed.merge([first, second], { conflict });
  const runtime = createProjectionRuntime();
  runtime.read(projection);
  return { first, second, projection, runtime };
};

const winningMerge = createMergeFixture('last');
const shadowedMerge = createMergeFixture('first');
let winningRevision = 0;
let shadowedRevision = 0;

const structuralBase = input.collection(new Map(entries));
const structuralExtra = input.collection<string, number>();
const structuralMerge = derive.keyed.merge([structuralBase, structuralExtra], { conflict: 'last' });
const structuralRuntime = createProjectionRuntime();
structuralRuntime.read(structuralMerge);
let extraPresent = false;

const orderSource = input.collection(new Map(entries));
const orderInput = input<readonly string[]>(ids);
const orderedSource = derive.keyed.subset(orderSource, orderInput);
const orderMerge = derive.keyed.merge([orderedSource], { conflict: 'error' });
const orderRuntime = createProjectionRuntime();
orderRuntime.read(orderMerge);
let orderCurrent = ids as readonly string[];

const lowConflictSources = [
  input.collection(
    new Map([...ids.map((id, index) => [`a-${id}`, index] as const), ['shared', 1] as const])
  ),
  input.collection(
    new Map([...ids.map((id, index) => [`b-${id}`, index] as const), ['shared', 2] as const])
  ),
  input.collection(new Map(ids.map((id, index) => [`c-${id}`, index] as const))),
] as const;
const lowConflictMerge = derive.keyed.merge(lowConflictSources, {
  conflict: 'resolve',
  resolve: contributions => contributions.reduce((sum, entry) => sum + entry.value, 0),
});

const highConflictSources = [
  input.collection(new Map(entries)),
  input.collection(new Map(entries.map(([key, value]) => [key, value + 1] as const))),
  input.collection(new Map(entries.map(([key, value]) => [key, value + 2] as const))),
] as const;
const highConflictMerge = derive.keyed.merge(highConflictSources, {
  conflict: 'resolve',
  resolve: contributions => contributions.reduce((sum, entry) => sum + entry.value, 0),
});

describe('derive.keyed.merge', () => {
  bench(
    'winning value update across 2 x 10000 sources',
    () => {
      winningMerge.runtime.update(winningMerge.second, draft =>
        draft.set(target, ++winningRevision)
      );
      winningMerge.runtime.read(winningMerge.projection).get(target);
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'shadowed value update across 2 x 10000 sources',
    () => {
      shadowedMerge.runtime.update(shadowedMerge.second, draft =>
        draft.set(target, ++shadowedRevision)
      );
      shadowedMerge.runtime.read(shadowedMerge.projection).get(target);
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'one add or remove with merged order rebuild over 10000 members',
    () => {
      structuralRuntime.update(structuralExtra, draft => {
        if (extraPresent) draft.remove('extra');
        else draft.set('extra', 1);
      });
      extraPresent = !extraPresent;
      structuralRuntime.read(structuralMerge).keys();
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'source order-only change over 10000 merged members',
    () => {
      const next = [...orderCurrent];
      [next[0], next[1]] = [next[1], next[0]];
      orderCurrent = next;
      orderRuntime.update(orderInput, next);
      orderRuntime.read(orderMerge).keys();
    },
    { iterations: 10, time: 100 }
  );

  bench(
    'resolver initial materialization with one conflict across 3 x 10000 sources',
    () => {
      const runtime = createProjectionRuntime();
      runtime.read(lowConflictMerge);
      runtime.dispose();
    },
    { iterations: 2, time: 100 }
  );

  bench(
    'resolver initial materialization with 10000 conflicts across 3 sources',
    () => {
      const runtime = createProjectionRuntime();
      runtime.read(highConflictMerge);
      runtime.dispose();
    },
    { iterations: 2, time: 100 }
  );
});

afterAll(() => {
  fromValue.runtime.dispose();
  fromReorder.runtime.dispose();
  fromNoop.runtime.dispose();
  winningMerge.runtime.dispose();
  shadowedMerge.runtime.dispose();
  structuralRuntime.dispose();
  orderRuntime.dispose();
});
