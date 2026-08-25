import type { DocumentSchema, ImpactTarget } from '../schema';
import type { DocumentReader } from '../access/reader';
import { documentReader } from '../access/reader';
import { createDependencyTracker } from '../access/dependency';
import type { DocumentImpact } from '../impact';
import type { CommitSource, DocumentCommit, DocumentReadable } from '../runtime/contract';
import { documentOf, schemaOf } from '../runtime/access';
import { registerProcessor } from '../runtime/notification';
import { profile } from '../profile';
import type { Readable } from './readable';

export type MaterializedSource<TValue, TChange> = {
  readonly value: TValue;
  readonly change: TChange | undefined;
};
export type MaterializedSources = Readonly<Record<string, MaterializedView<unknown, unknown>>>;
export type MaterializedSourceValues<TSources extends MaterializedSources> = {
  readonly [K in keyof TSources]: TSources[K] extends MaterializedView<infer TValue, infer TChange>
    ? MaterializedSource<TValue, TChange>
    : never;
};
export type MaterializedUpdateResult<TValue, TChange> =
  | {
      readonly kind: 'changed';
      readonly value: TValue;
      readonly change: TChange;
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'rebuild' };
export type MaterializedViewUpdate<
  TSchema extends DocumentSchema,
  TSources extends MaterializedSources,
> = {
  readonly read: DocumentReader<TSchema>;
  readonly revision: number;
  readonly source: CommitSource;
  readonly impact: DocumentImpact<TSchema>;
  readonly sources: MaterializedSourceValues<TSources>;
};
export type MaterializedViewSpec<
  TSchema extends DocumentSchema,
  TValue,
  TChange,
  TSources extends MaterializedSources,
> = {
  readonly sources?: TSources;
  readonly build: (input: {
    readonly read: DocumentReader<TSchema>;
    readonly sources: MaterializedSourceValues<TSources>;
  }) => {
    readonly value: TValue;
    readonly update: (
      update: MaterializedViewUpdate<TSchema, TSources>
    ) => MaterializedUpdateResult<TValue, TChange>;
  };
};
export type MaterializedView<TValue, TChange = void> = Readable<TValue> & {
  readonly __change?: TChange;
  rebuild(): void;
  dispose(): void;
};

const materializedMeta = new WeakMap<
  object,
  {
    runtime: object;
    value: unknown;
    change: unknown;
    revision: number;
    changedRevision: number;
  }
>();

export const createMaterializedView = <
  TSchema extends DocumentSchema,
  TValue,
  TChange = void,
  TSources extends MaterializedSources = {},
>(
  runtime: DocumentReadable<TSchema>,
  spec: MaterializedViewSpec<TSchema, TValue, TChange, TSources>
): MaterializedView<TValue, TChange> => {
  const listeners = new Set<() => void>();
  let disposed = false;
  let fault: unknown;
  let revision = runtime.revision();
  let instance!: ReturnType<MaterializedViewSpec<TSchema, TValue, TChange, TSources>['build']>;
  let currentValue!: TValue;
  let pendingEmit = false;
  const dependencies = createDependencyTracker();
  const sources = (spec.sources ?? {}) as TSources;
  const sourceEntries = Object.keys(sources).map(
    key => [key, sources[key as keyof TSources]] as const
  );
  sourceEntries.forEach(([, source]) => {
    const meta = materializedMeta.get(source as object);
    if (!meta || meta.runtime !== (runtime as object))
      throw new Error('Materialized sources must belong to the same runtime and be created first.');
  });
  const sourceValuesRecord: Record<string, { value: unknown; change: unknown }> = {};
  let sourceChanged = false;
  for (const [key] of sourceEntries)
    sourceValuesRecord[key] = { value: undefined, change: undefined };
  const sourceValues = (commitRevision?: number): MaterializedSourceValues<TSources> => {
    sourceChanged = false;
    for (const [key, source] of sourceEntries) {
      const meta = materializedMeta.get(source as object);
      const entry = sourceValuesRecord[key];
      entry.value = meta?.value ?? source.current();
      entry.change = meta?.change;
      if (commitRevision !== undefined && meta?.changedRevision === commitRevision) {
        sourceChanged = true;
        profile.materialized.sourceChanged();
      }
    }
    return sourceValuesRecord as MaterializedSourceValues<TSources>;
  };

  let activeImpact: DocumentImpact<TSchema> | undefined;
  const assertImpact = (): DocumentImpact<TSchema> => {
    if (!activeImpact) throw new Error('Materialized impact is no longer active.');
    return activeImpact;
  };
  const trackedImpact: DocumentImpact<TSchema> = {
    get kind() {
      return assertImpact().kind;
    },
    affects: target => {
      dependencies.record(target);
      return assertImpact().affects(target);
    },
    collection: selector => {
      dependencies.record(selector);
      return assertImpact().collection(selector);
    },
    get operations() {
      dependencies.record({ kind: 'value', at: [] });
      return assertImpact().operations;
    },
  };

  let view!: MaterializedView<TValue, TChange>;
  const writeMeta = (
    change: unknown,
    value: unknown,
    nextRevision: number,
    changed: boolean
  ): void => {
    const meta = materializedMeta.get(view as object);
    if (meta) {
      meta.value = value;
      meta.change = change;
      meta.revision = nextRevision;
      if (changed) meta.changedRevision = nextRevision;
    } else {
      materializedMeta.set(view as object, {
        runtime: runtime as object,
        value,
        change,
        revision: nextRevision,
        changedRevision: changed ? nextRevision : -1,
      });
    }
  };
  const build = (): void => {
    profile.materialized.rebuilt();
    dependencies.clear();
    let active = true;
    try {
      instance = spec.build({
        read: documentReader(
          schemaOf(runtime),
          () => documentOf(runtime),
          () => active
        ),
        sources: sourceValues(),
      });
      currentValue = instance.value;
      fault = undefined;
      revision = runtime.revision();
    } finally {
      active = false;
    }
  };
  build();

  const emit = (): void => {
    profile.materialized.notification();
    Array.from(listeners).forEach(listener => listener());
  };
  const process = (commit: DocumentCommit<TSchema>): void => {
    if (disposed) return;
    try {
      if (commit.kind === 'replace' || fault) {
        build();
        writeMeta(undefined, currentValue, commit.revision, true);
        pendingEmit = true;
        return;
      }
      const sourceSnapshot = sourceValues(commit.revision);
      if (!sourceChanged && dependencies.size() > 0 && !dependencies.some(commit.impact.affects)) {
        profile.materialized.skipped();
        revision = commit.revision;
        writeMeta(undefined, currentValue, commit.revision, false);
        return;
      }
      dependencies.clear();
      profile.materialized.updated();
      let active = true;
      let result: MaterializedUpdateResult<TValue, TChange>;
      try {
        activeImpact = commit.impact;
        result = instance.update({
          read: documentReader(
            schemaOf(runtime),
            () => documentOf(runtime),
            () => active
          ),
          revision: commit.revision,
          source: commit.source,
          impact: trackedImpact,
          sources: sourceSnapshot,
        });
      } finally {
        activeImpact = undefined;
        active = false;
      }
      if (result.kind === 'rebuild') {
        build();
        writeMeta(undefined, currentValue, commit.revision, true);
        pendingEmit = true;
      } else if (result.kind === 'changed') {
        currentValue = result.value;
        revision = commit.revision;
        writeMeta(result.change, currentValue, commit.revision, true);
        pendingEmit = true;
      } else {
        revision = commit.revision;
        writeMeta(undefined, currentValue, commit.revision, false);
      }
    } catch (error) {
      try {
        build();
        writeMeta(undefined, currentValue, commit.revision, true);
        pendingEmit = true;
      } catch (rebuildError) {
        fault = rebuildError;
        throw rebuildError;
      }
      throw error;
    }
  };

  view = {
    current: () => {
      if (fault) throw fault;
      return currentValue;
    },
    revision: () => revision,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rebuild: () => {
      build();
      writeMeta(undefined, currentValue, runtime.revision(), true);
      emit();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unregister();
      listeners.clear();
      materializedMeta.delete(view as object);
    },
  };
  materializedMeta.set(view as object, {
    runtime: runtime as object,
    value: currentValue,
    change: undefined,
    revision,
    changedRevision: -1,
  });
  // Runtime notification processes the complete source graph first, then
  // flushes external listeners so downstream views see upstream state/change
  // from the same commit without observing an intermediate pipeline state.
  const unregister = registerProcessor(runtime, {
    process,
    flush: () => {
      if (!pendingEmit) return;
      pendingEmit = false;
      emit();
    },
  });
  return view;
};
