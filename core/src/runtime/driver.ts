import type { CommitSource, DocumentRuntime } from './contract';
import type { DocumentSchema } from '../schema';

export type RuntimeWriteIntent =
  | { readonly kind: 'update'; readonly source: Extract<CommitSource, 'local' | 'system'> }
  | { readonly kind: 'prepare' }
  | { readonly kind: 'apply'; readonly source: CommitSource }
  | { readonly kind: 'replace'; readonly source: Extract<CommitSource, 'system' | 'remote'> };

export type RuntimeWriteDriver = {
  readonly assertWritable: (intent: RuntimeWriteIntent) => void;
};

export type RuntimeWriteDriverLease = {
  readonly run: <TResult>(run: () => TResult) => TResult;
  readonly dispose: () => void;
};

type RuntimeDriverState = {
  driver: RuntimeWriteDriver | undefined;
  bypassDepth: number;
};

const states = new WeakMap<object, RuntimeDriverState>();

const stateOf = (runtime: object): RuntimeDriverState => {
  const state = states.get(runtime);
  if (!state) throw new Error('Unknown Doxum runtime.');
  return state;
};

export const bindRuntimeDriver = (runtime: object): void => {
  states.set(runtime, { driver: undefined, bypassDepth: 0 });
};

export const assertRuntimeWritable = (runtime: object, intent: RuntimeWriteIntent): void => {
  const state = stateOf(runtime);
  if (state.bypassDepth === 0) state.driver?.assertWritable(intent);
};

export const installRuntimeWriteDriver = <TSchema extends DocumentSchema>(
  runtime: DocumentRuntime<TSchema>,
  driver: RuntimeWriteDriver
): RuntimeWriteDriverLease => {
  const state = stateOf(runtime);
  if (state.driver) throw new Error('Doxum runtime already has a write driver.');
  state.driver = driver;
  let active = true;
  return Object.freeze({
    run: <TResult>(run: () => TResult): TResult => {
      if (!active) throw new Error('Doxum runtime write driver is no longer active.');
      state.bypassDepth += 1;
      try {
        return run();
      } finally {
        state.bypassDepth -= 1;
      }
    },
    dispose: (): void => {
      if (!active) return;
      active = false;
      if (state.driver === driver) state.driver = undefined;
    },
  });
};

export const disposeRuntimeDriver = (runtime: object): void => {
  states.delete(runtime);
};
