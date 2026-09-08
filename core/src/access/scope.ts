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
  ReadonlyValue,
  TableNode,
  TreeNode,
  ValueSchemaNode,
  VariantNode,
} from '../schema';
import {
  nodeAt,
  resolveValue,
  resolveChild,
  resolveLocated,
  compiledShape,
  type FixedMember,
  type ResolvedContainer,
} from '../address';
import { copyValue } from '../schema-value';
import type { DependencyTracker } from './dependency';
import type { MutationSession } from '../mutation/session';
import * as tableOperations from '../mutation/operations/table';
import * as listOperations from '../mutation/operations/list';
import * as treeOperations from '../mutation/operations/tree';
import * as orderOperations from '../mutation/operations/order';
import * as tree from '../mutation/tree';
import * as anchor from '../mutation/anchor';
import { profile } from '../profile';

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
      insert(value: ReadonlyValue<T>, anchor?: DocumentAnchor): void;
      set(key: string, value: ReadonlyValue<T>): void;
      remove(key: string): void;
      move(key: string, anchor?: DocumentAnchor): void;
      replace(value: readonly ReadonlyValue<T>[]): void;
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
      insert(id: string, value: ReadonlyValue<T>, position?: tree.TreePosition): void;
      set(id: string, value: ReadonlyValue<T>): void;
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
type Snapshot<T> = T extends { readonly [scopeValue]?: infer V } ? V : ReadonlyValue<T>;
type Target = {
  at?: DocumentAddress;
  parent?: Target;
  key: string;
  node: DocumentNode | undefined;
  value: unknown;
  generation: number;
  children:
    | { kind: 'fixed'; schema: DocumentNode; slots: (Target | undefined)[] }
    | { kind: 'dynamic'; keys: Map<string, Target> }
    | undefined;
  proxy: object | undefined;
  container?: ResolvedContainer;
};
type Location = { readonly context: AccessContext; readonly target: Target };
const locations = new WeakMap<object, Location>();
const locationOf = (value: object): Location | undefined => locations.get(value);
const addressOf = (target: Target): DocumentAddress => {
  if (target.at) return target.at;
  profile.access('addresses');
  return (target.at = addressOf(target.parent!).concat(target.key));
};
export type AccessContext = {
  readonly schema: ObjectNode;
  readonly root: () => unknown;
  /** Omitted only for trusted synchronous readers whose proxies must not escape. */
  readonly active?: () => boolean;
  readonly dependencies?: DependencyTracker;
  readonly session?: MutationSession;
};
const assertActive = (context: AccessContext) => {
  if (context.active && !context.active()) throw new Error('Document access scope has expired.');
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
  if (!location) return value as Snapshot<T>;
  const { context } = location;
  const at = addressOf(location.target);
  profile.access('snapshots');
  collect(context, at);
  const resolved = resolveValue(context.schema, context.root(), at);
  if (resolved) return copyValue(resolved.node, resolved.value) as Snapshot<T>;
  if (!nodeAt(context.schema, at, context.root()))
    throw new Error('The selected schema address no longer exists.');
  return undefined as Snapshot<T>;
};
/** TypeScript cannot express asymmetric index signatures for nested collection tools. */
export const assign = <T extends object, K extends keyof Snapshot<T>>(
  container: T,
  key: K,
  value: NoInfer<Snapshot<T>[K]>
): void => {
  const location = locationOf(container);
  if (!location) throw new TypeError('assign requires scoped document access.');
  const { context } = location;
  assertActive(context);
  if (!context.session) throw new TypeError('Cannot modify read-only document access.');
  if (typeof key !== 'string') throw new TypeError('Document keys must be strings.');
  Reflect.set(container, key, value);
};
/** Projection collection contexts use the same scoped access, with explicit collection tools. */
export type CollectionAccess<K extends string, N extends ValueSchemaNode> = TableAccess<
  K,
  N,
  false
>;
export const createAccess = (context: AccessContext, initial: DocumentAddress = []): unknown => {
  profile.access('scopes');
  const resolve = (target: Target) => {
    assertActive(context);
    const generation = context.session?.generation ?? 0;
    if (target.generation !== generation) {
      profile.access('resolutions');
      if (!target.parent && !initial.length) {
        target.node = context.schema;
        target.value = context.root();
      } else {
        const parent = target.parent && resolve(target.parent);
        const location = parent
          ? resolveChild(parent.node, parent.value, target.key)
          : resolveLocated(context.schema, context.root(), initial);
        target.node = location?.node ?? nodeAt(context.schema, addressOf(target), context.root());
        target.value =
          location && Object.hasOwn(location.parent, location.key)
            ? (location.parent as Record<string | number, unknown>)[location.key]
            : undefined;
      }
      target.generation = generation;
    }
    return target;
  };
  const mutable = (): MutationSession => {
    assertActive(context);
    if (!context.session) throw new TypeError('Cannot modify read-only document access.');
    return context.session;
  };
  const writableContainer = (target: Target, session: MutationSession): ResolvedContainer => {
    if (target.container?.generation === session.generation) return target.container;
    return (target.container = session.bind(addressOf(target), target.node, target.value));
  };
  const childAt = (target: Target, key: string): DocumentAddress => {
    profile.access('addresses');
    return addressOf(target).concat(key);
  };
  const access = (target: Target): unknown => {
    if (target.proxy) return target.proxy;
    const proxy = new Proxy(target, handler);
    profile.access('proxies');
    locations.set(proxy, { context, target });
    target.proxy = proxy;
    return proxy;
  };
  const createTarget = (
    at: DocumentAddress | undefined,
    parent: Target | undefined,
    key: string
  ): Target => ({
    at,
    parent,
    key,
    node: undefined,
    value: undefined,
    generation: -1,
    children: undefined,
    proxy: undefined,
  });
  const childAccess = (
    target: Target,
    member: string | FixedMember,
    node: DocumentNode,
    value: unknown
  ) => {
    const key = typeof member === 'string' ? member : member.key;
    if (node.kind === 'field' || value === undefined) {
      if (context.dependencies) collect(context, childAt(target, key));
      return value;
    }
    let children = target.children;
    let child: Target;
    if (typeof member !== 'string') {
      if (children?.kind !== 'fixed' || children.schema !== target.node)
        children = {
          kind: 'fixed',
          schema: target.node!,
          slots: new Array(compiledShape(target.node!, target.value)!.members.size),
        };
      child = children.slots[member.slot] ??= createTarget(undefined, target, key);
    } else {
      if (children?.kind !== 'dynamic') children = { kind: 'dynamic', keys: new Map() };
      const retained = children.keys.get(key);
      child = retained ?? createTarget(undefined, target, key);
      if (!retained) children.keys.set(key, child);
    }
    target.children = children;
    if (child.generation === target.generation) return child.proxy;
    child.node = node;
    child.value = value;
    child.generation = target.generation;
    return access(child);
  };
  const collectionValue = (target: Target, node: DocumentNode) => {
    const current = resolve(target);
    if (current.node !== node || current.value === undefined)
      throw new TypeError('The collection method belongs to a replaced schema branch.');
    return current.value;
  };
  const writableCollection = (
    target: Target,
    node: DocumentNode
  ): { session: MutationSession; container: ResolvedContainer } => {
    const session = mutable();
    collectionValue(target, node);
    return { session, container: writableContainer(target, session) };
  };
  const orderedMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'table' | 'list' }>
  ): unknown => {
    const at = addressOf(target);
    if (property === 'ids')
      return () => {
        const current = collectionValue(target, node);
        collect(context, at, 'collection');
        return node.kind === 'table'
          ? [...(current as { ids: string[] }).ids]
          : (current as unknown[]).map(node.keyOf);
      };
    if (property === 'has')
      return (id: string) => {
        const current = collectionValue(target, node);
        collect(context, at, 'collection', id);
        return node.kind === 'table'
          ? Object.hasOwn((current as { byId: object }).byId, id)
          : anchor.indexedKeys(current as unknown[], node.keyOf).index(id) >= 0;
      };
    if (property === 'get')
      return (id: string) => {
        const current = collectionValue(target, node);
        collect(context, at, 'collection', id);
        const location = resolveChild(node, current, id);
        if (!location || !Object.hasOwn(location.parent, location.key)) return undefined;
        return childAccess(
          target,
          id,
          location.node,
          (location.parent as Record<string | number, unknown>)[location.key]
        );
      };
    if (property === 'move')
      return (id: string, position?: DocumentAnchor) => {
        const writable = writableCollection(target, node);
        orderOperations.move(writable.session, writable.container, at, id, position);
      };
    return undefined;
  };
  const tableMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'table' }>
  ): unknown => {
    const at = addressOf(target);
    if (property === 'create')
      return (
        input: { id: string; value: unknown } | readonly { id: string; value: unknown }[],
        position?: DocumentAnchor
      ) => {
        const writable = writableCollection(target, node);
        tableOperations.create(
          writable.session,
          writable.container,
          at,
          Array.isArray(input) ? input : [input as { id: string; value: unknown }],
          position
        );
      };
    if (property === 'remove')
      return (ids: string | readonly string[]) => {
        const writable = writableCollection(target, node);
        tableOperations.remove(
          writable.session,
          writable.container,
          at,
          typeof ids === 'string' ? [ids] : ids
        );
      };
    return orderedMethod(target, property, node);
  };
  const listMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'list' }>
  ): unknown => {
    const at = addressOf(target);
    if (property === 'insert')
      return (value: unknown, position?: DocumentAnchor) => {
        const writable = writableCollection(target, node);
        listOperations.insert(writable.session, writable.container, at, value, position);
      };
    if (property === 'remove')
      return (id: string) => {
        const writable = writableCollection(target, node);
        listOperations.remove(writable.session, writable.container, at, id);
      };
    if (property === 'set')
      return (id: string, value: unknown) => {
        const writable = writableCollection(target, node);
        listOperations.set(writable.session, writable.container, at, id, value);
      };
    if (property === 'replace')
      return (value: unknown) => {
        const writable = writableCollection(target, node);
        writable.session.replace(at, value);
      };
    return orderedMethod(target, property, node);
  };
  const treeMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'tree' }>
  ): unknown => {
    const at = addressOf(target);
    if (property === 'insert')
      return (id: string, value: unknown, position?: tree.TreePosition) => {
        const writable = writableCollection(target, node);
        treeOperations.insert(writable.session, writable.container, at, id, value, position);
      };
    if (property === 'set')
      return (id: string, value: unknown) => {
        const writable = writableCollection(target, node);
        treeOperations.set(writable.session, writable.container, at, id, value);
      };
    if (property === 'remove')
      return (id: string) => {
        const writable = writableCollection(target, node);
        treeOperations.remove(writable.session, writable.container, at, id);
      };
    if (property === 'move')
      return (id: string, position?: tree.TreePosition) => {
        const writable = writableCollection(target, node);
        treeOperations.move(writable.session, writable.container, at, id, position);
      };
    if (property === 'replace')
      return (value: unknown) => {
        const writable = writableCollection(target, node);
        writable.session.replace(at, value);
      };
    const current = () => {
      collect(context, at);
      return collectionValue(target, node) as tree.MutableTree;
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
    return undefined;
  };
  const handler: ProxyHandler<Target> = {
    get: (target, property) => {
      const { node, value } = resolve(target);
      if (!node || value === undefined) return undefined;
      if (typeof property !== 'string') return undefined;
      if (node.kind === 'map') {
        if (context.dependencies) collect(context, addressOf(target), 'collection', property);
        if (!Object.hasOwn(value as object, property)) return undefined;
        if (node.value.kind === 'field') {
          if (context.dependencies) collect(context, childAt(target, property));
          return (value as Record<string, unknown>)[property];
        }
        return childAccess(
          target,
          property,
          node.value,
          (value as Record<string, unknown>)[property]
        );
      }
      if (node.kind === 'table') return tableMethod(target, property, node);
      if (node.kind === 'list') return listMethod(target, property, node);
      if (node.kind === 'tree') return treeMethod(target, property, node);
      if (node.kind === 'variant' && property === node.tag) {
        collect(context, childAt(target, property));
        return (value as Record<string, unknown>)[property];
      }
      const member = compiledShape(node, value)?.members.get(property);
      if (!member) return undefined;
      if (member.field) {
        if (context.dependencies) collect(context, childAt(target, property));
        return (value as Record<string, unknown>)[property];
      }
      return childAccess(
        target,
        node.kind === 'object' ? member : property,
        member.node,
        (value as Record<string, unknown>)[property]
      );
    },
    set: (target, property, value) => {
      const session = mutable(),
        { node } = resolve(target);
      if (
        typeof property !== 'string' ||
        !node ||
        (node.kind !== 'object' && node.kind !== 'variant' && node.kind !== 'map')
      )
        throw new TypeError('Invalid structural assignment.');
      if (node.kind === 'variant' && node.tag === property)
        throw new TypeError('Variant discriminants are read-only.');
      session.assignMember(writableContainer(target, session), property, value);
      return true;
    },
    deleteProperty: (target, property) => {
      const session = mutable(),
        { node } = resolve(target);
      if (typeof property !== 'string' || (node?.kind === 'variant' && node.tag === property))
        throw new TypeError('Invalid structural deletion.');
      session.removeMember(writableContainer(target, session), property);
      return true;
    },
    has: (target, property) => {
      const { node, value } = resolve(target);
      if (typeof property !== 'string') return false;
      collect(
        context,
        addressOf(target),
        node?.kind === 'map' ? 'collection' : 'value',
        node?.kind === 'map' ? property : undefined
      );
      return value !== undefined && Object.hasOwn(value as object, property);
    },
    ownKeys: target => {
      const { value } = resolve(target);
      if (context.dependencies) collect(context, addressOf(target), 'collection');
      return value && typeof value === 'object' ? Object.keys(value) : [];
    },
    getOwnPropertyDescriptor: (target, property) => {
      const { value } = resolve(target);
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
  const root = resolve(createTarget(initial, undefined, ''));
  if (!root.node || root.node.kind === 'field' || root.value === undefined) {
    if (context.dependencies) collect(context, initial);
    return root.value;
  }
  return access(root);
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
