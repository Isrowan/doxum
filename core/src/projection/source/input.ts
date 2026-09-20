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
            staged.set(key, { present: true, value });
            operations.push({ kind: 'set', key, value });
          },
          remove: key => {
            assertScope(() => active);
            if (typeof key !== 'string') throw new TypeError('Projection keys must be strings.');
            staged.set(key, { present: false });
            operations.push({ kind: 'remove', key });
          },
        });
        try {
          assertSynchronous(run(draft));
        } finally {
          active = false;
        }

        const candidates = new Set<string>();
        let structural = false;
        const accepted: typeof operations = [];
        const overlay = new Map<
          string,
          { readonly present: true; readonly value: unknown } | { readonly present: false }
        >();
        for (const operation of operations) {
          const overlayValue = overlay.get(operation.key);
          const present = overlayValue ? overlayValue.present : values.has(operation.key);
          if (operation.kind === 'set') {
            const previous = overlayValue
              ? overlayValue.present
                ? overlayValue.value
                : undefined
              : values.get(operation.key);
            if (present && source.equality(previous, operation.value)) continue;
            structural ||= !present;
            overlay.set(operation.key, { present: true, value: operation.value });
          } else {
            if (!present) continue;
            structural = true;
            overlay.set(operation.key, { present: false });
          }
          accepted.push(operation);
          candidates.add(operation.key);
        }
        if (!accepted.length) return;
        for (const operation of accepted) {
          if (operation.kind === 'set') values.set(operation.key, operation.value);
          else values.delete(operation.key);
        }
        boundary.mark({ candidates, orderMayChange: structural });
        scheduler.run();
      },
    },
  };
};
