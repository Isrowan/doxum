import { schemaRoot } from '../schema';
import type {
  DictNode,
  DocumentAddress,
  DocumentNode,
  DocumentSchema,
  Infer,
  EntitySchemaNode,
  ImpactTarget,
  ListNode,
  MapNode,
  ObjectNode,
  TableNode,
  TreeNode,
  VariantNode,
} from '../schema';
import { read as readAddress } from '../address';
import { cloneValue, isRecord } from '../value/ownership';
import { profile } from '../profile';
import type { DependencyTracker } from './dependency';
import * as anchor from '../mutation/anchor';
import { snapshotValue } from '../schema-value';

declare const snapshotType: unique symbol;
export type SnapshotReader<T> = { readonly [snapshotType]: T };
const readerLocation = Symbol('reader-location');
const readerNode = Symbol('reader-node');
const readerContext = Symbol('reader-context');
const readerAddress = Symbol('reader-address');
class ReaderLocation {
  readonly [readerNode]: DocumentNode;
  readonly [readerContext]: ReaderContext;
  readonly [readerAddress]: DocumentAddress;
  constructor(node: DocumentNode, context: ReaderContext, address: DocumentAddress) {
    this[readerNode] = node;
    this[readerContext] = context;
    this[readerAddress] = address;
  }
  get [readerLocation](): ReaderLocation {
    return this;
  }
}
class FieldAccess extends ReaderLocation {
  readonly get = (): unknown => {
    collectValue(this[readerContext], this[readerAddress]);
    return readAt(this[readerContext], this[readerAddress]);
  };
}

/** Capture a detached value now, using the reader's current transaction or selection scope. */
export const snapshot = <T>(reader: SnapshotReader<T>): T => {
  const location = (reader as SnapshotReader<T> & { [readerLocation]?: ReaderLocation })[
    readerLocation
  ];
  if (!(location instanceof ReaderLocation))
    throw new TypeError('snapshot requires a Doxum reader.');
  const node = location[readerNode],
    context = location[readerContext],
    address = location[readerAddress];
  collectValue(context, address);
  profile.reader.structuralSnapshot();
  return snapshotValue(node, readAt(context, address)) as T;
};

export type FieldReader<T> = { readonly get: () => T };
export type DictionaryReader<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  keys(): readonly K[];
  values(): Readonly<Partial<Record<K, V>>>;
};
export type CollectionReader<TId, TNode extends EntitySchemaNode> = {
  readonly ids: () => readonly TId[];
  readonly has: (id: TId) => boolean;
  readonly get: (id: TId) => ReaderOfNode<TNode> | undefined;
};
export type ListReader<T> = {
  readonly get: (key: string) => T | undefined;
  readonly has: (key: string) => boolean;
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

export type ReaderOfNode<TNode extends DocumentNode> = ReaderAccess<TNode> &
  SnapshotReader<Infer<TNode>>;
type ReaderAccess<TNode extends DocumentNode> = TNode extends {
  kind: 'field';
}
  ? FieldReader<Infer<TNode>>
  : TNode extends ObjectNode<infer TShape>
    ? { readonly [K in keyof TShape]: ReaderOfNode<TShape[K]> }
    : TNode extends VariantNode<string, infer _TVariants>
      ? FieldReader<Infer<TNode>>
      : TNode extends TableNode<infer TValue, infer K>
        ? CollectionReader<K, TValue>
        : TNode extends MapNode<infer TValue, infer K>
          ? CollectionReader<K, TValue>
          : TNode extends DictNode<infer TKey, infer TValue>
            ? DictionaryReader<TKey, TValue>
            : TNode extends ListNode<infer TItem>
              ? ListReader<TItem>
              : TNode extends TreeNode<infer TValue>
                ? TreeReader<TValue>
                : FieldReader<Infer<TNode>>;
export type DocumentReader<TSchema extends DocumentSchema> = ReaderOfNode<
  ObjectNode<TSchema['shape']>
>;

export type ReaderContext = {
  readonly root: () => unknown;
  readonly active: () => boolean;
  readonly dependencies?: DependencyTracker;
};

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
  return createReader(node, context, address);
};

const createReader = (
  node: DocumentNode,
  context: ReaderContext,
  address: DocumentAddress
): object => {
  if (node.kind === 'field') return new FieldAccess(node, context, address);
  if (node.kind === 'object') {
    let Access = objectReaders.get(node);
    if (!Access) {
      Access = class extends ReaderLocation {};
      for (const key of Object.keys(node.shape))
        Object.defineProperty(Access.prototype, key, {
          configurable: true,
          get(this: ReaderLocation) {
            const reader = readerFor(node.shape[key], this[readerContext], [
              ...this[readerAddress],
              key,
            ]);
            Object.defineProperty(this, key, { value: reader, enumerable: true });
            return reader;
          },
        });
      objectReaders.set(node, Access);
    }
    return new Access(node, context, address);
  }
  const location = new ReaderLocation(node, context, address);
  if (node.kind === 'dict')
    return Object.assign(location, {
      get: (key: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        return cloneValue(
          isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
            ? value[key]
            : undefined,
          'reader'
        );
      },
      has: (key: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
      },
      keys: () => {
        collectValue(context, address);
        const value = readAt(context, address);
        return isRecord(value) ? Object.keys(value) : [];
      },
      values: () => {
        collectValue(context, address);
        profile.reader.structuralSnapshot();
        return cloneValue(readAt(context, address) ?? {}, 'reader');
      },
    });
  if (node.kind === 'list')
    return Object.assign(location, {
      get: (key: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        if (!Array.isArray(value)) return undefined;
        return cloneValue(value[anchor.keys(value, node.keyOf).index(key)], 'reader');
      },
      has: (key: string) => {
        collectValue(context, address);
        const value = readAt(context, address);
        return Array.isArray(value) && anchor.keys(value, node.keyOf).index(key) >= 0;
      },
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
    });
  if (node.kind === 'tree')
    return Object.assign(location, {
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
    });
  if (node.kind === 'table' || node.kind === 'map') {
    let items: Map<string, unknown> | undefined;
    return Object.assign(location, {
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
        if (cached) return cached as ReaderOfNode<typeof node.value>;
        const reader = readerFor(node.value, context, [...address, id]);
        (items ??= new Map()).set(id, reader);
        return reader;
      },
    });
  }
  if (node.kind === 'variant')
    return Object.assign(location, {
      get: () => {
        collectValue(context, address);
        return cloneValue(readAt(context, address), 'reader');
      },
    });

  throw new Error('Unknown reader schema node.');
};

const objectReaders = new WeakMap<object, typeof ReaderLocation>();

export const documentReader = <TSchema extends DocumentSchema>(
  schema: TSchema,
  root: () => Infer<TSchema>,
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
