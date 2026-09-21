import type { CommitSource, DocumentRuntime } from './contract';
import type { ObjectSchema } from '@/schema/model';
import { contextOf } from './context';

export type RuntimeWriteIntent =
  | { readonly kind: 'update'; readonly source: Extract<CommitSource, 'local' | 'system'> }
  | { readonly kind: 'apply'; readonly source: CommitSource }
  | { readonly kind: 'replace'; readonly source: Extract<CommitSource, 'system' | 'remote'> };

export type RuntimeWriteDriver = {
  readonly assertWritable: (intent: RuntimeWriteIntent) => void;
};

export type RuntimeWriteDriverLease = {
  readonly run: <TResult>(run: () => TResult) => TResult;
  readonly dispose: () => void;
};

export const assertRuntimeWritable = (runtime: object, intent: RuntimeWriteIntent): void => {
  const context = contextOf(runtime);
  if (context.bypassDepth === 0) context.driver?.assertWritable(intent);
};

export const installRuntimeWriteDriver = <TSchema extends ObjectSchema<object>>(
  runtime: DocumentRuntime<TSchema>,
  driver: RuntimeWriteDriver
): RuntimeWriteDriverLease => {
  const context = contextOf(runtime);
  if (context.driver) throw new Error('Doxum runtime already has a write driver.');
  context.driver = driver;
  let active = true;
  return Object.freeze({
    run: <TResult>(run: () => TResult): TResult => {
      if (!active) throw new Error('Doxum runtime write driver is no longer active.');
      context.bypassDepth += 1;
      try {
        return run();
      } finally {
        context.bypassDepth -= 1;
      }
    },
    dispose: (): void => {
      if (!active) return;
      active = false;
      if (context.driver === driver) context.driver = undefined;
    },
  });
};
