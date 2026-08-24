import { object } from '../schema';
import type {
  DictNode,
  DocumentAddress,
  DocumentNode,
  DocumentSchema,
  DocumentValueOfNode,
  ImpactTarget,
  ListNode,
  MapNode,
  ObjectNode,
  ReadonlyDocument,
  SingleNode,
  TableNode,
  TreeNode,
  VariantNode,
} from '../schema';
import { read as readAddress } from '../address';
import { cloneValue, isRecord } from '../value/ownership';
import { profile } from '../profile';
import type { DependencyTracker } from './dependency';

export type FieldReader<T> = { readonly get: () => T };
export type CollectionReader<TId, TEntry> = {
  readonly ids: () => readonly TId[];
  readonly has: (id: TId) => boolean;
  readonly get: (id: TId) => EntityReader<TEntry> | undefined;
};
export type ListReader<T> = {
  readonly values: () => readonly T[];
  readonly length: () => number;
  readonly at: (index: number) => T | undefined;
};
export type TreeReader<T> = {
  readonly rootId: () => string | undefined;
  readonly has: (id: string) => boolean;
  readonly value: (id: string) => T | undefined;
  readonly parent: (id: string) => string | undefined;
  readonly children: (id: string) => readonly string[];
};

export type EntityReader<T> = T extends object
  ? { readonly [K in keyof T]: ReaderValue<T[K]> }
  : FieldReader<T>;
export type ReaderValue<T> = T extends readonly (infer TItem)[]
  ? ListReader<TItem>
  : T extends object
    ? EntityReader<T>
    : FieldReader<T>;
export type ReaderOfNode<TNode extends DocumentNode> = TNode extends {
  kind: 'field';
}
  ? FieldReader<DocumentValueOfNode<TNode>>
  : TNode extends ObjectNode<infer TShape>
    ? { readonly [K in keyof TShape]: ReaderOfNode<TShape[K]> }
    : TNode extends VariantNode<string, infer TVariants>
      ? { readonly [K in keyof TVariants]: ReaderOfNode<TVariants[K]> }
      : TNode extends SingleNode<infer TValue>
        ? ReaderOfNode<TValue>
        : TNode extends TableNode<infer TValue>
          ? CollectionReader<string, DocumentValueOfNode<TValue>>
          : TNode extends MapNode<infer TValue>
            ? CollectionReader<string, DocumentValueOfNode<TValue>>
            : TNode extends DictNode<infer TKey, infer TValue>
              ? FieldReader<Readonly<Partial<Record<TKey, TValue>>>>
              : TNode extends ListNode<infer TItem>
                ? ListReader<TItem>
                : TNode extends TreeNode<infer TValue>
                  ? TreeReader<TValue>
                  : FieldReader<DocumentValueOfNode<TNode>>;
export type DocumentReader<TSchema extends DocumentSchema> = ReaderOfNode<
  ObjectNode<TSchema['shape']>
>;

export type ReaderContext = {
  readonly root: () => unknown;
  readonly active: () => boolean;
  readonly dependencies?: DependencyTracker;
};

const schemaRoot = (schema: DocumentSchema): DocumentNode => object(schema.shape);

const assertActive = (context: ReaderContext): void => {
  if (!context.active()) throw new Error('Document reader is no longer active.');
};

const readAt = (context: ReaderContext, address: DocumentAddress): unknown => {
  assertActive(context);
  profile.reader.lookup();
  return readAddress(context.root(), address);
};

const collectValue = (context: ReaderContext, address: DocumentAddress): void => {
  context.dependencies?.record({ kind: 'value', at: address });
};

const collectCollection = (context: ReaderContext, address: DocumentAddress, id?: string): void => {
  const target: ImpactTarget<unknown> = {
    kind: 'collection',
    at: address,
    ...(id === undefined ? {} : { id }),
  };
  context.dependencies?.record(target);
};

export const readerFor = (
  node: DocumentNode,
  context: ReaderContext,
  address: DocumentAddress = []
): unknown => {
  if (node.kind === 'field')
    return {
      get: () => {
        collectValue(context, address);
        return readAt(context, address);
      },
    };
  if (node.kind === 'dict' || node.kind === 'record')
    return {
      get: () => {
        collectValue(context, address);
        profile.reader.structuralSnapshot();
        return cloneValue(readAt(context, address), 'reader');
      },
    };
  if (node.kind === 'list')
    return {
      values: () => {
        collectValue(context, address);
        const value = readAt(context, address);
        profile.reader.structuralSnapshot();
        return cloneValue(Array.isArray(value) ? value : [], 'reader');
      },
      length: () => {
        collectValue(context, address);
        const value = readAt(context, address);
        return Array.isArray(value) ? value.length : 0;
      },
      at: (index: number) => {
        collectValue(context, address);
        const value = readAt(context, address);
        profile.reader.structuralSnapshot();
        return cloneValue(Array.isArray(value) ? value[index] : undefined, 'reader');
      },
    };
  if (node.kind === 'tree')
    return {
      rootId: () => {
        collectValue(context, address);
        const value = readAt(context, address);
        return isRecord(value) && typeof value.rootId === 'string' ? value.rootId : undefined;
      },
      has: (id: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        return (
          isRecord(value) &&
          isRecord(value.nodes) &&
          Object.prototype.hasOwnProperty.call(value.nodes, id)
        );
      },
      value: (id: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        profile.reader.structuralSnapshot();
        return cloneValue(
          isRecord(value) && isRecord(value.nodes) && isRecord(value.nodes[id])
            ? value.nodes[id].value
            : undefined,
          'reader'
        );
      },
      parent: (id: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        const entry = isRecord(value) && isRecord(value.nodes) ? value.nodes[id] : undefined;
        return isRecord(entry) && typeof entry.parentId === 'string' ? entry.parentId : undefined;
      },
      children: (id: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        const entry = isRecord(value) && isRecord(value.nodes) ? value.nodes[id] : undefined;
        return isRecord(entry) && Array.isArray(entry.children) ? [...entry.children] : [];
      },
    };
  if (node.kind === 'table' || node.kind === 'map') {
    let items: Map<string, unknown> | undefined;
    return {
      ids: () => {
        collectCollection(context, address);
        const value = readAt(context, address);
        const ids =
          node.kind === 'table' && isRecord(value) && Array.isArray(value.ids)
            ? [...value.ids]
            : isRecord(value)
              ? Object.keys(value)
              : [];
        profile.reader.collectionIds(ids.length);
        return ids;
      },
      has: (id: string) => {
        collectCollection(context, address, id);
        const value = readAt(context, address);
        const byId =
          node.kind === 'table' && isRecord(value) && isRecord(value.byId) ? value.byId : value;
        return isRecord(byId) && Object.prototype.hasOwnProperty.call(byId, id);
      },
      get: (id: string) => {
        collectCollection(context, address, id);
        const value = readAt(context, address);
        const byId =
          node.kind === 'table' && isRecord(value) && isRecord(value.byId) ? value.byId : value;
        if (!isRecord(byId) || !Object.prototype.hasOwnProperty.call(byId, id)) return undefined;
        const cached = items?.get(id);
        if (cached) return cached as EntityReader<unknown>;
        const reader = readerFor(node.value, context, [...address, id]);
        (items ??= new Map()).set(id, reader);
        return reader;
      },
    };
  }
  if (node.kind === 'single') return readerFor(node.value, context, address);
  if (node.kind === 'variant')
    return new Proxy(
      {},
      {
        get: (_target, property: string | symbol) => {
          if (typeof property === 'symbol') return undefined;
          const value = readAt(context, address);
          const tag =
            isRecord(value) && typeof value[node.tag] === 'string'
              ? String(value[node.tag])
              : undefined;
          const branch = tag ? node.variants[tag] : undefined;
          const child = branch?.shape[property];
          return child ? readerFor(child, context, [...address, property]) : undefined;
        },
      }
    );

  let children: Map<string, unknown> | undefined;
  return new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        if (typeof property === 'symbol') return undefined;
        const child = node.shape[property];
        if (!child) return undefined;
        const cached = children?.get(property);
        if (cached) return cached;
        const reader = readerFor(child, context, [...address, property]);
        (children ??= new Map()).set(property, reader);
        return reader;
      },
    }
  );
};

export const documentReader = <TSchema extends DocumentSchema>(
  schema: TSchema,
  root: () => ReadonlyDocument<TSchema>,
  active: () => boolean,
  dependencies?: DependencyTracker
): DocumentReader<TSchema> => {
  profile.reader.session();
  return readerFor(schemaRoot(schema), {
    root,
    active,
    dependencies,
  }) as DocumentReader<TSchema>;
};
