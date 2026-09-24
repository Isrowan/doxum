import { collectionView } from '@/projection/collection/view';
import { createCollectionState, type CollectionEntry } from '@/projection/collection/state';
import type { CollectionRead } from '@/projection/contract';
import { ProjectionDisposedError } from '@/projection/contract';
import type { CollectionInputDraft, SourceDefinition } from '@/projection/definition';
import { assertScope, assertSynchronous, type Scheduler } from '@/projection/graph/scheduler';
import { sameArray } from '@/value/array';
import {
  createCollectionBoundary,
  createValueBoundary,
  type SourceMaterialization,
} from './boundary';

export const materializeInputSource = (
  scheduler: Scheduler,
  definition: SourceDefinition
): SourceMaterialization => {
  const source = definition.source;
  if (source.kind !== 'value-input' && source.kind !== 'collection-input')
    throw new Error('Invalid projection input source.');
  const equal = (previous: unknown, next: unknown): boolean => {
    const result = source.equality(previous, next);
    assertSynchronous(result);
    return result;
  };

  if (source.kind === 'value-input') {
    let latest = source.initial;
    const boundary = createValueBoundary(
      scheduler,
      'projection input',
      source.initial,
      Object.is,
      () => latest,
      () => undefined
    );
    boundary.detach(() => {
      latest = undefined;
    });
    return {
      ...boundary,
      input: {
        kind: 'value',
        read: () => latest,
        set(value) {
          const next = scheduler.acceptInput(() => {
            if (equal(latest, value)) return latest;
            if (source.equality === Object.is) return value;
            const published = boundary.output.current();
            return !Object.is(latest, published) && equal(published, value) ? published : value;
          });
          if (Object.is(latest, next)) return;
          latest = next;
          boundary.mark();
          scheduler.run();
        },
      },
    };
  }

  const values = createCollectionState(source.initial);
  let view: ReadonlyMap<string, unknown> | undefined;
  // This live reader is internal and synchronous; public reads capture a storage version.
  const latest: CollectionRead<string, unknown> = {
    get: values.get,
    has: values.has,
    ids: values.ids,
  };
  const boundary = createCollectionBoundary(
    scheduler,
    'projection collection input',
    () => latest,
    Object.is,
    () => undefined
  );
  boundary.detach(() => {
    values.release();
    view = undefined;
  });
  const check = (): void => {
    scheduler.assertActive();
    if (boundary.producer.disposed) throw new ProjectionDisposedError();
  };
  return {
    ...boundary,
    input: {
      kind: 'collection',
      read: () => (view ??= collectionView(values.read(check))),
      update(run) {
        const accepted = scheduler.acceptInput(() => {
          const staged = new Map<string, CollectionEntry<unknown>>();
          // New and removed/re-added keys have their final insertion position here.
          const appended = new Set<string>();
          let structural = false;
          let active = true;
          const has = (key: string): boolean => {
            const entry = staged.get(key);
            return entry ? entry.present : values.has(key);
          };
          const draft: CollectionInputDraft<string, unknown> = Object.freeze({
            get: key => {
              assertScope(() => active);
              const entry = staged.get(key);
              return entry ? (entry.present ? entry.value : undefined) : values.get(key);
            },
            has: key => {
              assertScope(() => active);
              return has(key);
            },
            set: (key, value) => {
              assertScope(() => active);
              if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
              if (!has(key)) {
                appended.add(key);
                structural = true;
              }
              staged.set(key, { present: true, value });
            },
            remove: key => {
              assertScope(() => active);
              if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
              if (!has(key)) return;
              appended.delete(key);
              structural = true;
              staged.set(key, { present: false });
            },
          });
          try {
            assertSynchronous(run(draft));
          } finally {
            active = false;
          }

          const published =
            source.equality === Object.is
              ? undefined
              : (boundary.output.current() as CollectionRead<string, unknown>);
          for (const [key, entry] of staged) {
            const existed = values.has(key);
            if (!entry.present) {
              if (!existed) staged.delete(key);
              continue;
            }
            const previous = values.get(key);
            let next = entry.value;
            if (existed && equal(previous, next)) next = previous;
            else if (published?.has(key)) {
              const before = published.get(key);
              if ((!existed || !Object.is(previous, before)) && equal(before, next)) next = before;
            }
            if (existed && Object.is(previous, next)) staged.delete(key);
            else if (!Object.is(entry.value, next)) staged.set(key, { present: true, value: next });
          }

          const beforeOrder = values.ids();
          let order = beforeOrder;
          if (structural) {
            const next: string[] = [];
            for (const key of beforeOrder) if (has(key) && !appended.has(key)) next.push(key);
            for (const key of appended) next.push(key);
            if (!sameArray(beforeOrder, next)) order = Object.freeze(next);
          }
          return { staged, order, structural: order !== beforeOrder };
        });
        if (!accepted.staged.size && !accepted.structural) return;
        values.install(accepted.staged, accepted.order, false);
        view = undefined;
        boundary.mark({ candidates: accepted.staged.keys(), orderMayChange: accepted.structural });
        scheduler.run();
      },
    },
  };
};
