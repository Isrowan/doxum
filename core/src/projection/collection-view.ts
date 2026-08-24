import type { CollectionSelector, DocumentSchema } from '../schema';
import type { EntityReader } from '../access/reader';
import { readerFor } from '../access/reader';
import type { DocumentRuntime } from '../runtime/contract';
import { documentOf, schemaOf } from '../runtime/access';
import { nodeAt, read } from '../address';
import { profile } from '../profile';
import type { Readable } from './readable';

type CollectionState<TId extends string, TValue> = {
  ids: readonly TId[];
  values: Map<TId, TValue>;
  all: readonly TValue[] | undefined;
  allDirty: boolean;
};

export type CollectionView<TId extends string, TValue> = {
  readonly ids: Readable<readonly TId[]>;
  readonly all: Readable<readonly TValue[]>;
  readonly item: (id: TId) => Readable<TValue | undefined>;
  revision(): number;
  dispose(): void;
};

export const createCollectionView = <
  TSchema extends DocumentSchema,
  TId extends string,
  TEntry,
  TValue,
>(input: {
  readonly runtime: DocumentRuntime<TSchema>;
  readonly source: CollectionSelector<TId, TEntry>;
  readonly map: (id: TId, entry: EntityReader<TEntry>) => TValue;
  readonly isEqual?: (previous: TValue, next: TValue) => boolean;
}): CollectionView<TId, TValue> => {
  if (schemaOf(input.runtime) !== input.source.schema)
    throw new Error('Collection selector belongs to another schema.');
  const idsListeners = new Set<() => void>();
  const allListeners = new Set<() => void>();
  const itemListeners = new Map<TId, Set<() => void>>();
  const itemReadables = new Map<TId, Readable<TValue | undefined>>();
  let disposed = false;
  const sourceNode = nodeAt(input.source.schema, input.source.address);
  const entryNode =
    sourceNode?.kind === 'table' || sourceNode?.kind === 'map'
      ? sourceNode.value
      : { kind: 'object' as const, shape: {} };

  const mapEntry = (document: unknown, id: TId): TValue => {
    profile.collectionView.mapped();
    const address = [...input.source.address, String(id)];
    let active = true;
    try {
      return input.map(
        id,
        readerFor(
          entryNode,
          { root: () => document, active: () => active },
          address
        ) as EntityReader<TEntry>
      );
    } finally {
      active = false;
    }
  };

  const build = (
    previous?: CollectionState<TId, TValue>,
    changed?: Set<TId>
  ): CollectionState<TId, TValue> => {
    const document = documentOf(input.runtime);
    const collection = read(document, input.source.address) as
      | {
          readonly ids?: readonly TId[];
          readonly byId?: Readonly<Record<string, unknown>>;
        }
      | Readonly<Record<string, unknown>>
      | undefined;
    const ids =
      collection &&
      typeof collection === 'object' &&
      'ids' in collection &&
      Array.isArray(collection.ids)
        ? [...collection.ids]
        : (Object.keys(collection ?? {}) as TId[]);
    profile.collectionView.idsScanned(ids.length);
    const values = previous && changed ? previous.values : new Map<TId, TValue>();
    if (previous && changed) {
      const nextIds = new Set(ids);
      for (const id of previous.ids) if (!nextIds.has(id)) values.delete(id);
    }
    for (const id of ids) {
      if (previous && changed && previous.values.has(id) && !changed.has(id)) continue;
      const next = mapEntry(document, id);
      if (previous && changed && previous.values.has(id)) {
        const before = previous.values.get(id) as TValue;
        const equal = input.isEqual ? input.isEqual(before, next) : Object.is(before, next);
        if (equal) {
          changed.delete(id);
          continue;
        }
      }
      values.set(id, next);
    }
    const stableIds = Object.freeze(ids) as readonly TId[];
    return {
      ids: stableIds,
      values,
      all: undefined,
      allDirty: true,
    };
  };

  let state = build();
  const ensureAll = (): readonly TValue[] => {
    if (!state.allDirty && state.all) return state.all;
    profile.collectionView.arrayCopied();
    const all = new Array<TValue>(state.ids.length);
    for (let index = 0; index < state.ids.length; index += 1)
      all[index] = state.values.get(state.ids[index]) as TValue;
    const stable = Object.freeze(all) as readonly TValue[];
    state.all = stable;
    state.allDirty = false;
    return stable;
  };
  const emit = (listeners: Set<() => void>): void => {
    Array.from(listeners).forEach(listener => listener());
  };

  const unsubscribe = input.runtime.subscribe(input.source, commit => {
    if (disposed) return;
    const impact = commit.impact.collection(input.source);
    if (
      impact.kind === 'incremental' &&
      impact.added.size === 0 &&
      impact.removed.size === 0 &&
      !impact.orderChanged
    ) {
      const previous = state;
      const changes: Array<readonly [TId, TValue]> = [];
      const document = documentOf(input.runtime);
      impact.updated.forEach(id => {
        if (!previous.values.has(id)) return;
        const before = previous.values.get(id) as TValue;
        const after = mapEntry(document, id);
        if (input.isEqual ? input.isEqual(before, after) : Object.is(before, after)) return;
        changes.push([id, after]);
      });
      if (changes.length === 0) return;
      // Updated-only commits preserve ids and the values Map. The
      // aggregate array remains lazy until a consumer reads `all` again.
      for (const [id, value] of changes) previous.values.set(id, value);
      previous.all = undefined;
      previous.allDirty = true;
      emit(allListeners);
      for (const [id] of changes) {
        const listeners = itemListeners.get(id);
        if (listeners) emit(listeners);
      }
      return;
    }

    const changed =
      impact.kind === 'reset' ? undefined : new Set<TId>([...impact.added, ...impact.updated]);
    const previous = state;
    const next = build(previous, changed);
    const changedIds = new Set<TId>();
    if (changed) {
      changed.forEach(id => changedIds.add(id));
      previous.ids.forEach(id => {
        if (!next.values.has(id)) changedIds.add(id);
      });
      next.ids.forEach(id => {
        if (!previous.values.has(id)) changedIds.add(id);
      });
    } else {
      previous.ids.forEach(id => {
        if (!next.values.has(id)) changedIds.add(id);
        else {
          const equal = input.isEqual
            ? input.isEqual(previous.values.get(id) as TValue, next.values.get(id) as TValue)
            : Object.is(previous.values.get(id), next.values.get(id));
          if (!equal) changedIds.add(id);
        }
      });
      next.ids.forEach(id => {
        if (!previous.values.has(id)) changedIds.add(id);
      });
    }
    const idsChanged =
      impact.kind === 'incremental'
        ? impact.added.size > 0 || impact.removed.size > 0 || impact.orderChanged
        : previous.ids.length !== next.ids.length ||
          previous.ids.some((id, index) => next.ids[index] !== id);
    state = idsChanged || changedIds.size ? next : previous;
    if (idsChanged) emit(idsListeners);
    if (idsChanged || changedIds.size) emit(allListeners);
    changedIds.forEach(id => {
      const listeners = itemListeners.get(id);
      if (listeners) emit(listeners);
    });
  });

  return {
    ids: {
      current: () => state.ids,
      revision: () => input.runtime.revision(),
      subscribe: listener => {
        if (disposed) return () => undefined;
        idsListeners.add(listener);
        return () => idsListeners.delete(listener);
      },
    },
    all: {
      current: ensureAll,
      revision: () => input.runtime.revision(),
      subscribe: listener => {
        if (disposed) return () => undefined;
        allListeners.add(listener);
        return () => allListeners.delete(listener);
      },
    },
    item: id => {
      const cached = itemReadables.get(id);
      if (cached) return cached;
      const readable: Readable<TValue | undefined> = {
        current: () => state.values.get(id),
        revision: () => input.runtime.revision(),
        subscribe: listener => {
          if (disposed) return () => undefined;
          const listeners = itemListeners.get(id) ?? new Set<() => void>();
          itemListeners.set(id, listeners);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) itemListeners.delete(id);
          };
        },
      };
      itemReadables.set(id, readable);
      return readable;
    },
    revision: () => input.runtime.revision(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      idsListeners.clear();
      allListeners.clear();
      itemListeners.clear();
      itemReadables.clear();
      state.values.clear();
      state = {
        ids: Object.freeze([]),
        values: new Map(),
        all: Object.freeze([]),
        allDirty: false,
      };
    },
  };
};
