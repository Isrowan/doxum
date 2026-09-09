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
  resolveChild,
  resolveLocated,
  compiledShape,
  type FixedMember,
  type ResolvedContainer,
  type ResolvedTreeContainer,
} from '../address';
import { copyValue } from '../schema-value';
import type { DependencyTracker } from './dependency';
import type { CanonicalState } from '../mutation/state';
import type { MutationSession } from '../mutation/session';
import * as mapOperations from '../mutation/operations/map';
import * as tableOperations from '../mutation/operations/table';
import * as listOperations from '../mutation/operations/list';
import * as treeOperations from '../mutation/operations/tree';
import * as orderOperations from '../mutation/operations/order';
import * as tree from '../mutation/tree';
import * as anchor from '../mutation/anchor';
import { profile } from '../profile';

declare const scopeValue: unique symbol;
type Scoped<N extends DocumentNode, W extends boolean, V = Infer<N>> = {
  readonly [scopeValue]?: readonly [node: N, writable: W, value: V];
};
type ShapeAccess<S extends ObjectShape, W extends boolean> = W extends true
  ? { -readonly [K in keyof S]: Access<S[K], W> }
  : { readonly [K in keyof S]: Access<S[K], W> };
type MapAccess<K extends string, N extends ValueSchemaNode, W extends boolean> = {
  get(id: K): Access<N, W> | undefined;
  has(id: K): boolean;
  ids(): readonly K[];
} & (W extends true
  ? {
      put(id: K, value: Infer<N>): void;
      remove(id: K): void;
      replace(value: Readonly<Record<K, Infer<N>>>): void;
    }
  : {});
type TableAccess<K extends string, N extends ValueSchemaNode, W extends boolean> = {
  get(id: K): Access<N, W> | undefined;
  has(id: K): boolean;
  ids(): readonly K[];
} & (W extends true
  ? {
      create(id: K, value: Infer<N>, anchor?: DocumentAnchor<K>): void;
      create(
        entries: readonly { readonly id: K; readonly value: Infer<N> }[],
        anchor?: DocumentAnchor<K>
      ): void;
      remove(ids: K | readonly K[]): void;
      move(id: K, anchor?: DocumentAnchor<K>): void;
      replace(value: {
        readonly ids: readonly K[];
        readonly byId: Readonly<Record<K, Infer<N>>>;
      }): void;
      replace(id: K, value: Infer<N>): void;
    }
  : {});
type ListAccess<T, W extends boolean> = {
  get(key: string): ReadonlyValue<T> | undefined;
  has(key: string): boolean;
  ids(): readonly string[];
} & (W extends true
  ? {
      insert(value: ReadonlyValue<T>, anchor?: DocumentAnchor): void;
      remove(key: string): void;
      move(key: string, anchor?: DocumentAnchor): void;
      replace(value: readonly ReadonlyValue<T>[]): void;
      replace(key: string, value: ReadonlyValue<T>): void;
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
      move(id: string, position?: tree.TreePosition): void;
      remove(id: string): void;
      replace(value: DocumentTreeValue<T>): void;
      replace(id: string, value: ReadonlyValue<T>): void;
    }
  : {});
type NodeAccess<N extends DocumentNode, W extends boolean> =
  N extends FieldNode<infer T, boolean>
    ? ReadonlyValue<T>
    : N extends ObjectNode<infer S>
      ? ShapeAccess<S, W> & Scoped<N, W>
      : N extends VariantNode<infer Tag, infer V>
        ? {
            [K in keyof V & string]: ShapeAccess<V[K]['shape'], W> & {
              readonly [P in Tag]: K;
            } & Scoped<N, W, Extract<Infer<N>, Record<Tag, K>>>;
          }[keyof V & string]
        : N extends MapNode<infer V, infer K>
          ? MapAccess<K, V, W> & Scoped<N, W>
          : N extends TableNode<infer V, infer K>
            ? TableAccess<K, V, W> & Scoped<N, W>
            : N extends ListNode<infer T>
              ? ListAccess<T, W> & Scoped<N, W>
              : N extends TreeNode<infer T>
                ? TreeAccess<T, W> & Scoped<N, W>
                : never;
type Access<N extends DocumentNode, W extends boolean> = N extends { readonly optional: true }
  ? NodeAccess<N, W> | undefined
  : NodeAccess<N, W>;
export type Read<N extends DocumentNode> = Access<N, false>;
export type Draft<N extends DocumentNode> = Access<N, true>;
type Snapshot<T> = T extends {
  readonly [scopeValue]?: readonly [DocumentNode, boolean, infer V];
}
  ? V
  : ReadonlyValue<T>;
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
  container?: ResolvedContainer | ResolvedTreeContainer;
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
  readonly state: CanonicalState;
  /** Omitted for borrowed synchronous Draft and readers that must not escape. */
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
  const resolved = resolve(context, location.target);
  if (!resolved.node) throw new Error('The selected schema address no longer exists.');
  return copyValue(resolved.node, resolved.value) as Snapshot<T>;
};
/** Replace a member with its plain Infer value through the owning draft session. */
type ReplaceParentAccess = {
  readonly [scopeValue]?: readonly [
    Extract<DocumentNode, { readonly kind: 'object' | 'variant' }>,
    true,
    unknown,
  ];
};
export const replace = <T extends object & ReplaceParentAccess, K extends keyof Snapshot<T>>(
  container: T,
  key: K,
  value: NoInfer<Snapshot<T>[K]>
): void => {
  const location = locationOf(container);
  if (!location) throw new TypeError('replace requires scoped document access.');
  if (typeof key !== 'string') throw new TypeError('Document keys must be strings.');
  Reflect.set(container, key, value);
};
/** Projection collection contexts use the same scoped access, with explicit collection tools. */
export type CollectionAccess<K extends string, N extends ValueSchemaNode> = TableAccess<
  K,
  N,
  false
>;
const resolve = (context: AccessContext, target: Target): Target => {
  assertActive(context);
  const generation = context.session?.generation ?? 0;
  if (target.generation !== generation) {
    profile.access('resolutions');
    if (!target.parent && !target.at!.length) {
      target.node = context.state.schema;
      target.value = context.state.document;
    } else {
      const parent = target.parent && resolve(context, target.parent);
      const location = parent
        ? resolveChild(parent.node, parent.value, target.key)
        : resolveLocated(context.state.schema, context.state.document, target.at!);
      target.node =
        location?.node ?? nodeAt(context.state.schema, addressOf(target), context.state.document);
      target.value =
        location && Object.hasOwn(location.parent, location.key)
          ? (location.parent as Record<string | number, unknown>)[location.key]
          : undefined;
    }
    target.generation = generation;
  }
  return target;
};

export const createAccess = (context: AccessContext, initial: DocumentAddress = []): unknown => {
  profile.access('scopes');
  const mutable = (): MutationSession => {
    assertActive(context);
    if (!context.session) throw new TypeError('Cannot modify read-only document access.');
    return context.session;
  };
  const writableContainer = (target: Target, session: MutationSession): ResolvedContainer => {
    if (target.container?.generation === session.generation && 'layout' in target.container)
      return target.container;
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
    const current = resolve(context, target);
    if (current.node !== node || current.value === undefined)
      throw new TypeError('The collection method belongs to a replaced schema branch.');
    return current.value;
  };
  const writableCollection = (target: Target, node: DocumentNode): ResolvedContainer => {
    const session = mutable();
    collectionValue(target, node);
    return writableContainer(target, session);
  };
  const writableTree = (target: Target, node: DocumentNode): ResolvedTreeContainer => {
    const session = mutable();
    collectionValue(target, node);
    if (target.container?.generation === session.generation && !('layout' in target.container))
      return target.container;
    return (target.container = session.bindTree(addressOf(target), target.node, target.value));
  };
  const replaceCollection = (target: Target, node: DocumentNode, value: unknown) => {
    const session = mutable();
    collectionValue(target, node);
    session.replace(addressOf(target), value);
  };
  const mapMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'map' }>
  ): unknown => {
    if (property === 'ids')
      return () => {
        const current = collectionValue(target, node) as Record<string, unknown>;
        if (context.dependencies) collect(context, addressOf(target), 'collection');
        return Object.keys(current);
      };
    if (property === 'has')
      return (id: string) => {
        const current = collectionValue(target, node) as Record<string, unknown>;
        if (context.dependencies) collect(context, addressOf(target), 'collection', id);
        return Object.hasOwn(current, id);
      };
    if (property === 'get')
      return (id: string) => {
        const current = collectionValue(target, node) as Record<string, unknown>;
        if (context.dependencies) collect(context, addressOf(target), 'collection', id);
        if (!Object.hasOwn(current, id)) return undefined;
        if (node.value.kind === 'field') {
          if (context.dependencies) collect(context, childAt(target, id));
          return current[id];
        }
        return childAccess(target, id, node.value, current[id]);
      };
    if (property === 'put')
      return (id: string, value: unknown) => {
        const writable = writableCollection(target, node);
        mapOperations.put(context.session!, writable, id, value);
      };
    if (property === 'remove')
      return (id: string) => {
        const writable = writableCollection(target, node);
        mapOperations.remove(context.session!, writable, id);
      };
    if (property === 'replace') return (value: unknown) => replaceCollection(target, node, value);
    return undefined;
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
        orderOperations.move(context.session!, writable, id, position);
      };
    return undefined;
  };
  const tableMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'table' }>
  ): unknown => {
    if (property === 'create')
      return (
        input: string | readonly { id: string; value: unknown }[],
        valueOrPosition?: unknown,
        position?: DocumentAnchor
      ) => {
        const writable = writableCollection(target, node);
        tableOperations.create(
          context.session!,
          writable,
          Array.isArray(input) ? input : [{ id: input as string, value: valueOrPosition }],
          Array.isArray(input) ? (valueOrPosition as DocumentAnchor | undefined) : position
        );
      };
    if (property === 'remove')
      return (ids: string | readonly string[]) => {
        const writable = writableCollection(target, node);
        tableOperations.remove(context.session!, writable, typeof ids === 'string' ? [ids] : ids);
      };
    if (property === 'replace')
      return (...args: [unknown, unknown?]) => {
        const [valueOrId, value] = args;
        if (args.length === 1) return replaceCollection(target, node, valueOrId);
        const writable = writableCollection(target, node);
        tableOperations.replace(context.session!, writable, valueOrId as string, value);
      };
    return orderedMethod(target, property, node);
  };
  const listMethod = (
    target: Target,
    property: string,
    node: Extract<DocumentNode, { kind: 'list' }>
  ): unknown => {
    if (property === 'insert')
      return (value: unknown, position?: DocumentAnchor) => {
        const writable = writableCollection(target, node);
        listOperations.insert(context.session!, writable, value, position);
      };
    if (property === 'remove')
      return (id: string) => {
        const writable = writableCollection(target, node);
        listOperations.remove(context.session!, writable, id);
      };
    if (property === 'replace')
      return (...args: [unknown, unknown?]) => {
        const [valueOrId, value] = args;
        if (args.length === 1) return replaceCollection(target, node, valueOrId);
        const writable = writableCollection(target, node);
        listOperations.replace(context.session!, writable, valueOrId as string, value);
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
        const writable = writableTree(target, node);
        treeOperations.insert(context.session!, writable, id, value, position);
      };
    if (property === 'remove')
      return (id: string) => {
        const writable = writableTree(target, node);
        treeOperations.remove(context.session!, writable, id);
      };
    if (property === 'move')
      return (id: string, position?: tree.TreePosition) => {
        const writable = writableTree(target, node);
        treeOperations.move(context.session!, writable, id, position);
      };
    if (property === 'replace')
      return (...args: [unknown, unknown?]) => {
        const [valueOrId, value] = args;
        if (args.length === 1) return replaceCollection(target, node, valueOrId);
        const writable = writableTree(target, node);
        treeOperations.replace(context.session!, writable, valueOrId as string, value);
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
      const { node, value } = resolve(context, target);
      if (!node || value === undefined) return undefined;
      if (typeof property !== 'string') return undefined;
      if (node.kind === 'map') return mapMethod(target, property, node);
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
        { node } = resolve(context, target);
      if (
        typeof property !== 'string' ||
        !node ||
        (node.kind !== 'object' && node.kind !== 'variant')
      )
        throw new TypeError('Invalid structural assignment.');
      if (node.kind === 'variant' && node.tag === property)
        throw new TypeError('Variant discriminants are read-only.');
      session.assignMember(writableContainer(target, session), property, value);
      return true;
    },
    deleteProperty: (target, property) => {
      const session = mutable(),
        { node } = resolve(context, target);
      if (
        typeof property !== 'string' ||
        node?.kind === 'map' ||
        (node?.kind === 'variant' && node.tag === property)
      )
        throw new TypeError('Invalid structural deletion.');
      session.removeMember(writableContainer(target, session), property);
      return true;
    },
    has: (target, property) => {
      const { node, value } = resolve(context, target);
      if (typeof property !== 'string') return false;
      if (node?.kind === 'map') return false;
      collect(context, addressOf(target));
      return value !== undefined && Object.hasOwn(value as object, property);
    },
    ownKeys: target => {
      const { node, value } = resolve(context, target);
      if (node?.kind === 'map') return [];
      if (context.dependencies) collect(context, addressOf(target));
      return value && typeof value === 'object' ? Object.keys(value) : [];
    },
    getOwnPropertyDescriptor: (target, property) => {
      const { node, value } = resolve(context, target);
      if (node?.kind === 'map') return undefined;
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
  const root = resolve(context, createTarget(initial, undefined, ''));
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
  return value as CollectionAccess<string, ValueSchemaNode>;
};
