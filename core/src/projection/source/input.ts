import { mapRead } from '../collection/view';
import type { CollectionInputDraft, SourceDefinition } from '../definition';
import { assertScope, assertSynchronous, type Scheduler } from '../graph/scheduler';
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
  if (source.kind === 'value-input') {
    let latest = source.initial;
    const boundary = createValueBoundary(
      scheduler,
      'projection input',
      source.initial,
      source.equality,
      () => latest,
      () => undefined
    );
    return {
      ...boundary,
      write: {
        kind: 'value',
        set(value) {
          scheduler.assertIdle();
          latest = value;
          boundary.mark();
          scheduler.run();
        },
      },
    };
  }
  if (source.kind !== 'collection-input') throw new Error('Invalid projection input source.');

  const values = new Map(source.initial);
  const boundary = createCollectionBoundary(
    scheduler,
    'projection collection input',
    () => mapRead(values),
    definition.output.equality,
    () => undefined
  );
  return {
    ...boundary,
    write: {
      kind: 'collection',
      update(run) {
        scheduler.assertIdle();
        const staged = new Map<
          string,
          { readonly present: true; readonly value: unknown } | { readonly present: false }
        >();
        const operations: (
          | { readonly kind: 'set'; readonly key: string; readonly value: unknown }
          | { readonly kind: 'remove'; readonly key: string }
        )[] = [];
        let structural = false;
        let active = true;
        const draft: CollectionInputDraft<string, unknown> = Object.freeze({
          get: key => {
            assertScope(() => active);
            const entry = staged.get(key);
            return entry ? (entry.present ? entry.value : undefined) : values.get(key);
          },
          has: key => {
            assertScope(() => active);
            const entry = staged.get(key);
            return entry ? entry.present : values.has(key);
          },
          set: (key, value) => {
            assertScope(() => active);
            if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
            const previous = staged.get(key);
            structural ||= previous ? !previous.present : !values.has(key);
            staged.set(key, { present: true, value });
            operations.push({ kind: 'set', key, value });
          },
          remove: key => {
            assertScope(() => active);
            if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
            const previous = staged.get(key);
            const present = previous ? previous.present : values.has(key);
            structural ||= present;
            staged.set(key, { present: false });
            if (present) operations.push({ kind: 'remove', key });
          },
        });
        try {
          assertSynchronous(run(draft));
        } finally {
          active = false;
        }

        if (!operations.length) return;

        const candidates = new Set<string>();
        const retained = new Map<string, unknown>();
        for (const [key, entry] of staged) {
          const existed = values.has(key);
          if (entry.present) {
            if (!existed) {
              candidates.add(key);
              continue;
            }
            const previous = values.get(key);
            if (source.equality(previous, entry.value)) retained.set(key, previous);
            else candidates.add(key);
          } else if (existed) candidates.add(key);
        }
        if (!candidates.size && !structural) return;

        for (const operation of operations) {
          if (operation.kind === 'set') values.set(operation.key, operation.value);
          else values.delete(operation.key);
        }
        for (const [key, value] of retained) if (values.has(key)) values.set(key, value);
        boundary.mark({ candidates, orderMayChange: structural });
        scheduler.run();
      },
    },
  };
};
