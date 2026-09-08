import type {
  DocumentAddress,
  DocumentAnchor,
  DocumentNode,
  DocumentTreeValue,
  FieldNode,
  Infer,
  ListNode,
  MapNode,
  ObjectNode,
  ObjectShape,
  TableNode,
  TreeNode,
  ValueSchemaNode,
  VariantNode,
} from '../schema';
import { nodeAt, read as readAddress } from '../address';
import { snapshotValue, detached } from '../schema-value';
import type { DependencyTracker } from './dependency';
import type { MutationSession } from '../mutation/session';
import * as tree from '../mutation/tree';
import { profile } from '../profile';

export type ReadonlyValue<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<ReadonlyValue<K>, ReadonlyValue<V>>
    : T extends Set<infer V>
      ? ReadonlySet<ReadonlyValue<V>>
      : T extends Date
        ? Omit<Date, `set${string}`>
        : T extends object
          ? { readonly [K in keyof T]: ReadonlyValue<T[K]> }
          : T;
declare const scopeValue: unique symbol;
type Scoped<N extends DocumentNode> = { readonly [scopeValue]?: Infer<N> };
type ShapeAccess<S extends ObjectShape, W extends boolean> = W extends true
  ? { -readonly [K in keyof S]: Access<S[K], W> }
  : { readonly [K in keyof S]: Access<S[K], W> };
type TableAccess<K extends string, N extends ValueSchemaNode, W extends boolean> = {
  get(id: K): Access<N, W> | undefined;
  has(id: K): boolean;
  ids(): readonly K[];
} & (W extends true
  ? {
      create(
        entries:
          | { readonly id: K; readonly value: Infer<N> }
          | readonly { readonly id: K; readonly value: Infer<N> }[],
        anchor?: DocumentAnchor<K>
      ): void;
      remove(ids: K | readonly K[]): void;
      move(id: K, anchor?: DocumentAnchor<K>): void;
    }
  : {});
type ListAccess<T, W extends boolean> = {
  get(key: string): ReadonlyValue<T> | undefined;
  has(key: string): boolean;
  ids(): readonly string[];
} & (W extends true
  ? {
      insert(value: T, anchor?: DocumentAnchor): void;
      set(key: string, value: T): void;
      remove(key: string): void;
      move(key: string, anchor?: DocumentAnchor): void;
      replace(value: readonly T[]): void;
    }
  : {});
type TreeAccess<T, W extends boolean> = {
  rootId(): string | undefined;
  get(id: string): ReadonlyValue<T> | undefined;
  has(id: string): boolean;
  parent(id: string): string | undefined;
  children(id: string): readonly string[] | undefined;
} & (W extends true
  ? {
      insert(id: string, value: T, position?: tree.TreePosition): void;
      set(id: string, value: T): void;
      move(id: string, position?: tree.TreePosition): void;
      remove(id: string): void;
      replace(value: DocumentTreeValue<T>): void;
    }
  : {});
type NodeAccess<N extends DocumentNode, W extends boolean> =
  N extends FieldNode<infer T, boolean>
    ? ReadonlyValue<T>
    : N extends ObjectNode<infer S>
      ? ShapeAccess<S, W> & Scoped<N>
      : N extends VariantNode<infer Tag, infer V>
        ? {
            [K in keyof V & string]: ShapeAccess<V[K]['shape'], W> & {
              readonly [P in Tag]: K;
            } & Scoped<N>;
          }[keyof V & string]
        : N extends MapNode<infer V, infer K>
          ? (W extends true
              ? { [P in K]: Access<V, W> | undefined }
              : { readonly [P in K]: Access<V, W> | undefined }) &
              Scoped<N>
          : N extends TableNode<infer V, infer K>
            ? TableAccess<K, V, W> & Scoped<N>
            : N extends ListNode<infer T>
              ? ListAccess<T, W> & Scoped<N>
              : N extends TreeNode<infer T>
                ? TreeAccess<T, W> & Scoped<N>
                : never;
type Access<N extends DocumentNode, W extends boolean> = N extends { readonly optional: true }
  ? NodeAccess<N, W> | undefined
  : NodeAccess<N, W>;
export type Read<N extends DocumentNode> = Access<N, false>;
export type Draft<N extends DocumentNode> = Access<N, true>;
type Snapshot<T> = T extends { readonly [scopeValue]?: infer V } ? V : T;
type Location = { readonly context: AccessContext; readonly at: DocumentAddress };
const locationKey = Symbol('doxum.access');
const accesses = new WeakSet<object>();
const locationOf = (value: object): Location | undefined =>
  accesses.has(value) ? (Reflect.get(value, locationKey) as Location) : undefined;
export type AccessContext = {
  readonly schema: ObjectNode;
  readonly root: () => unknown;
  readonly active: () => boolean;
  readonly dependencies?: DependencyTracker;
  readonly session?: MutationSession;
};
const assertActive = (context: AccessContext) => {
  if (!context.active()) throw new Error('Document access scope has expired.');
};
const collect = (
  context: AccessContext,
  at: DocumentAddress,
  kind: 'value' | 'collection' = 'value',
  id?: string
) => {
  assertActive(context);
  context.dependencies?.record(
    kind === 'value' ? { kind, at } : { kind, at, ...(id === undefined ? {} : { id }) }
  );
};
export const snapshot = <T>(value: T): Snapshot<T> => {
  const location = value && typeof value === 'object' ? locationOf(value) : undefined;
  if (!location) return detached(value) as Snapshot<T>;
  const { context, at } = location;
  profile.access('snapshots');
  collect(context, at);
  const node = nodeAt(context.schema, at, context.root());
  if (!node) throw new Error('The selected schema address no longer exists.');
  return snapshotValue(node, readAddress(context.root(), at, context.schema)) as Snapshot<T>;
};
/** TypeScript cannot express asymmetric index signatures for nested collection tools. */
export const assign = <T extends object, K extends keyof Snapshot<T>>(
  container: T,
  key: K,
  value: NoInfer<Snapshot<T>[K]>
): void => {
  const location = locationOf(container);
  if (!location) throw new TypeError('assign requires scoped document access.');
  const { context, at } = location;
  assertActive(context);
  if (!context.session) throw new TypeError('Cannot modify read-only document access.');
  if (typeof key !== 'string') throw new TypeError('Document keys must be strings.');
  const parent = nodeAt(context.schema, at, context.root());
  if (parent?.kind === 'variant' && parent.tag === key)
    throw new TypeError('Variant discriminants are read-only.');
  context.session.set([...at, key], value);
};
/** Projection collection contexts use the same scoped access, with explicit collection tools. */
export type CollectionAccess<K extends string, N extends ValueSchemaNode> = TableAccess<
  K,
  N,
  false
>;
export const createAccess = (context: AccessContext, initial: DocumentAddress = []): unknown => {
  profile.access('scopes');
  const resolutions = new Map<
    DocumentAddress,
    { node: DocumentNode | undefined; value: unknown; generation: number; proxy?: object }
  >();
  const resolve = (at: DocumentAddress) => {
    assertActive(context);
    const generation = context.session?.generation ?? 0;
    const cached = resolutions.get(at);
    if (cached?.generation === generation) return cached;
    const root = context.root();
    const result = {
      node: nodeAt(context.schema, at, root),
      value: readAddress(root, at, context.schema),
      generation,
      proxy: cached?.proxy,
    };
    resolutions.set(at, result);
    return result;
  };
  const mutable = (): MutationSession => {
    assertActive(context);
    if (!context.session) throw new TypeError('Cannot modify read-only document access.');
    return context.session;
  };
  type Target = { at: DocumentAddress; children?: Map<string, DocumentAddress> };
  const childAt = (target: Target, key: string): DocumentAddress => {
    const children = (target.children ??= new Map());
    let child = children.get(key);
    if (!child) children.set(key, (child = [...target.at, key]));
    return child;
  };
  const access = (at: DocumentAddress, childNode?: DocumentNode, childValue?: unknown): unknown => {
    if (childNode) {
      const generation = context.session?.generation ?? 0;
      const cached = resolutions.get(at);
      if (cached?.generation !== generation)
        resolutions.set(at, {
          node: childNode,
          value: childValue,
          generation,
          proxy: cached?.proxy,
        });
    }
    const resolved = resolve(at);
    const { node, value } = resolved;
    if (!node || value === undefined || node.kind === 'field') {
      collect(context, at);
      return value;
    }
    if (resolved.proxy) return resolved.proxy;
    const proxy = new Proxy({ at }, handler);
    profile.access('proxies');
    accesses.add(proxy);
    resolved.proxy = proxy;
    return proxy;
  };
  const handler: ProxyHandler<Target> = {
    get: (target, property) => {
      const { at } = target;
      if (property === locationKey) return { context, at };
      const { node, value } = resolve(at);
      if (!node || value === undefined) return undefined;
      if (typeof property !== 'string') return undefined;
      if (node.kind === 'map') {
        collect(context, at, 'collection', property);
        if (!Object.hasOwn(value as object, property)) return undefined;
        if (node.value.kind === 'field') {
          collect(context, childAt(target, property));
          return (value as Record<string, unknown>)[property];
        }
        return access(
          childAt(target, property),
          node.value,
          (value as Record<string, unknown>)[property]
        );
      }
      if (node.kind === 'table' || node.kind === 'list') {
        const currentValue = () => {
          const current = resolve(at);
          if (current.node !== node || current.value === undefined)
            throw new TypeError('The collection method belongs to a replaced schema branch.');
          return current.value;
        };
        const ids = () => {
          const current = currentValue();
          collect(context, at, 'collection');
          return node.kind === 'table'
            ? [...(current as { ids: string[] }).ids]
            : (current as unknown[]).map(node.keyOf);
        };
        const has = (id: string) => {
          const current = currentValue();
          collect(context, at, 'collection', id);
          return node.kind === 'table'
            ? Object.hasOwn((current as { byId: object }).byId, id)
            : (current as unknown[]).some(item => node.keyOf(item) === id);
        };
        if (property === 'ids') return ids;
        if (property === 'has') return has;
        if (property === 'get')
          return (id: string) => (has(id) ? access(childAt(target, id)) : undefined);
        if (property === 'move')
          return (id: string, position?: DocumentAnchor) => mutable().move(at, id, position);
        if (node.kind === 'table') {
          if (property === 'create')
            return (
              input: { id: string; value: unknown } | readonly { id: string; value: unknown }[],
              position?: DocumentAnchor
            ) =>
              mutable().tableCreate(
                at,
                Array.isArray(input) ? input : [input as { id: string; value: unknown }],
                position
              );
          if (property === 'remove')
            return (ids: string | readonly string[]) =>
              mutable().tableRemove(at, typeof ids === 'string' ? [ids] : ids);
        } else {
          if (property === 'insert')
            return (value: unknown, position?: DocumentAnchor) =>
              mutable().listInsert(at, value, position);
          if (property === 'remove') return (id: string) => mutable().listRemove(at, id);
          if (property === 'set')
            return (id: string, value: unknown) => mutable().listSet(at, id, value);
          if (property === 'replace')
            return (value: unknown) => mutable().set(at, value, true, true);
        }
        return undefined;
      }
      if (node.kind === 'tree') {
        const current = () => {
          collect(context, at);
          return resolve(at).value as tree.MutableTree;
        };
        if (property === 'rootId') return () => current().rootId;
        if (property === 'get')
          return (id: string) => {
            const value = current();
            return tree.contains(value, id) ? value.nodes[id].value : undefined;
          };
        if (property === 'has') return (id: string) => tree.contains(current(), id);
        if (property === 'parent') return (id: string) => tree.parent(current(), id);
        if (property === 'children')
          return (id: string) => {
            const children = tree.children(current(), id);
            return children ? [...children] : undefined;
          };
        if (property === 'insert')
          return (id: string, value: unknown, position?: tree.TreePosition) =>
            mutable().treeInsert(at, id, value, position);
        if (property === 'set')
          return (id: string, value: unknown) => mutable().treeSet(at, id, value);
        if (property === 'remove')
          return (id: string) =>
            mutable().treeEdit(at, (value, capture) => tree.remove(value, id, capture, at));
        if (property === 'move')
          return (id: string, position?: tree.TreePosition) =>
            mutable().treeEdit(at, (value, capture) => tree.move(value, id, position, capture, at));
        if (property === 'replace') return (value: unknown) => mutable().set(at, value, true, true);
        return undefined;
      }
      if (node.kind === 'variant' && property === node.tag) {
        collect(context, childAt(target, property));
        return (value as Record<string, unknown>)[property];
      }
      const shape =
        node.kind === 'object'
          ? node.shape
          : node.kind === 'variant'
            ? node.variants[String((value as Record<string, unknown>)[node.tag])]?.shape
            : undefined;
      if (!shape || !Object.hasOwn(shape, property)) return undefined;
      if (shape[property].kind === 'field') {
        if (context.dependencies) collect(context, childAt(target, property));
        return (value as Record<string, unknown>)[property];
      }
      return access(
        childAt(target, property),
        shape[property],
        (value as Record<string, unknown>)[property]
      );
    },
    set: (target, property, value) => {
      const { at } = target;
      const session = mutable(),
        node = resolve(at).node;
      if (
        typeof property !== 'string' ||
        !node ||
        (node.kind !== 'object' && node.kind !== 'variant' && node.kind !== 'map')
      )
        throw new TypeError('Invalid structural assignment.');
      if (node.kind === 'variant' && node.tag === property)
        throw new TypeError('Variant discriminants are read-only.');
      session.set(childAt(target, property), value);
      return true;
    },
    deleteProperty: (target, property) => {
      const { at } = target;
      const session = mutable(),
        node = resolve(at).node;
      if (typeof property !== 'string' || (node?.kind === 'variant' && node.tag === property))
        throw new TypeError('Invalid structural deletion.');
      session.set(childAt(target, property), undefined, false, true);
      return true;
    },
    has: ({ at }, property) => {
      const { node, value } = resolve(at);
      if (typeof property !== 'string') return false;
      collect(
        context,
        at,
        node?.kind === 'map' ? 'collection' : 'value',
        node?.kind === 'map' ? property : undefined
      );
      return value !== undefined && Object.hasOwn(value as object, property);
    },
    ownKeys: ({ at }) => {
      const { value } = resolve(at);
      collect(context, at, 'collection');
      return value && typeof value === 'object' ? Object.keys(value) : [];
    },
    getOwnPropertyDescriptor: ({ at }, property) => {
      const { value } = resolve(at);
      return value && Object.hasOwn(value as object, property)
        ? { enumerable: true, configurable: true }
        : undefined;
    },
    defineProperty: () => {
      assertActive(context);
      throw new TypeError('Use schema assignments.');
    },
    setPrototypeOf: () => {
      assertActive(context);
      throw new TypeError('Document prototypes are immutable.');
    },
    preventExtensions: () => {
      assertActive(context);
      throw new TypeError('Document access cannot be frozen.');
    },
  };
  return access(initial);
};
export const collectionAccess = (
  context: AccessContext,
  at: DocumentAddress
): CollectionAccess<string, ValueSchemaNode> => {
  const value = createAccess(context, at);
  if (value === undefined)
    return {
      get: () => {
        assertActive(context);
        return undefined;
      },
      has: () => {
        assertActive(context);
        return false;
      },
      ids: () => {
        assertActive(context);
        return [];
      },
    };
  const node = nodeAt(context.schema, at, context.root());
  if (node?.kind === 'table') return value as CollectionAccess<string, ValueSchemaNode>;
  const map = value as Record<string, Read<ValueSchemaNode>>;
  return { get: id => map[id], has: id => id in map, ids: () => Object.keys(map) };
};
