import { createDependencyTracker } from '../access/dependency';
import type { Read } from '../access/scope';
import * as target from '../impact/target';
import type { Readable, Unsubscribe } from '../readable';
import type { ImpactTarget, ObjectNode } from '../schema';
import { readWith } from './access';
import { DocumentDisposedError, type DocumentReadable } from './contract';
import { contextOf } from './context';

export type DocumentSelector<TSchema extends ObjectNode, TResult> = (
  read: Read<TSchema>
) => TResult;

export const read = <TSchema extends ObjectNode, TResult>(
  document: DocumentReadable<TSchema>,
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

export const select = <TSchema extends ObjectNode, TResult>(
  document: DocumentReadable<TSchema>,
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
    unsubscribeDocument?.();
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
      listeners.add(listener);
      if (listeners.size === 1) installSubscription();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribeDocument?.();
          unsubscribeDocument = undefined;
        }
      };
    },
  });
};
