import { addListener } from '@/subscription';
import { createDependencyTracker } from '@/access/dependency';
import type { Read } from '@/access/scope';
import * as target from '@/impact/target';
import type { Readable, Unsubscribe } from '@/readable';
import type { ObjectSchema } from '@/schema/model';
import type { ImpactTarget } from '@/schema/path';
import { readWith } from './access';
import { DocumentDisposedError, type ReadonlyDocument } from './contract';
import { contextOf } from './context';

export type DocumentSelector<TSchema extends ObjectSchema<object>, TResult> = (
  read: Read<TSchema>
) => TResult;

export const read = <TSchema extends ObjectSchema<object>, TResult>(
  document: ReadonlyDocument<TSchema>,
  selector: DocumentSelector<TSchema, TResult>
): TResult => readWith(document, selector);

const sameDependencySet = (
  left: readonly ImpactTarget<unknown>[],
  right: readonly ImpactTarget<unknown>[]
): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!target.same(left[index], right[index])) return false;
  return true;
};

export const select = <TSchema extends ObjectSchema<object>, TResult>(
  document: ReadonlyDocument<TSchema>,
  selector: DocumentSelector<TSchema, TResult>,
  equality: (previous: TResult, next: TResult) => boolean = Object.is
): Readable<TResult> => {
  const context = contextOf<TSchema>(document);
  let initialized = false;
  let value!: TResult;
  let selectedRevision = 0;
  let documentRevision = -1;
  let dependencies: readonly ImpactTarget<unknown>[] = Object.freeze([]);
  let unsubscribeDocument: Unsubscribe | undefined;
  const listeners = new Set<() => void>();

  const evaluate = (): { readonly changed: boolean; readonly rebound: boolean } => {
    const tracker = createDependencyTracker();
    const next = readWith(document, selector, tracker);
    const nextDependencies = tracker.snapshot();
    const changed = !initialized || !equality(value, next);
    const rebound = !sameDependencySet(dependencies, nextDependencies);
    if (changed) {
      if (initialized) selectedRevision += 1;
      value = next;
    }
    dependencies = nextDependencies;
    initialized = true;
    documentRevision = document.revision();
    return { changed, rebound };
  };

  const installSubscription = (): void => {
    const stop = unsubscribeDocument;
    unsubscribeDocument = undefined;
    stop?.();
    unsubscribeDocument =
      dependencies.length > 0
        ? context.notifications.subscribeTargets(dependencies, () => {
            const result = evaluate();
            if (result.rebound) installSubscription();
            if (result.changed) for (const listener of [...listeners]) listener();
          })
        : undefined;
  };

  const ensureCurrent = (): TResult => {
    if (context.state.disposed) throw new DocumentDisposedError();
    if (!initialized || (!unsubscribeDocument && documentRevision !== document.revision()))
      evaluate();
    return value;
  };

  return Object.freeze({
    current: ensureCurrent,
    revision: () => {
      ensureCurrent();
      return selectedRevision;
    },
    subscribe: (listener: () => void) => {
      ensureCurrent();
      const unsubscribe = addListener(listeners, listener, () => {
        if (!listeners.size) {
          const stop = unsubscribeDocument;
          unsubscribeDocument = undefined;
          stop?.();
        }
      });
      try {
        if (listeners.size === 1) installSubscription();
      } catch (error) {
        try {
          unsubscribe();
        } catch {
          /* Preserve subscription failure. */
        }
        throw error;
      }
      return unsubscribe;
    },
  });
};
