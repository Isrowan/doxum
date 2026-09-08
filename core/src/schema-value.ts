import type { DocumentAddress, DocumentNode, Infer } from './schema';
import { isPlainObject, isRecord, cloneValue, deepEqual } from './value/ownership';
import { validate as validTree } from './mutation/tree';
import * as anchor from './mutation/anchor';

/** A synchronous assertion/parser, or a Standard Schema v1 validator. Transformations are rejected. */
export type Validator<T> =
  | ((value: unknown) => T)
  | {
      readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: { readonly input: unknown; readonly output: T };
        validate(value: unknown):
          | { readonly value: T; readonly issues?: undefined }
          | {
              readonly issues: readonly {
                readonly message: string;
                readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
              }[];
            }
          | PromiseLike<unknown>;
      };
    };

export type ParseIssue = {
  readonly address: DocumentAddress;
  readonly code: 'invalid-value' | 'invalid-key' | 'missing-validator' | 'invalid-tree';
  readonly message: string;
};
export class ParseError extends TypeError {
  readonly issues: readonly ParseIssue[];
  constructor(issue: ParseIssue) {
    super(`${issue.message} at ${JSON.stringify(issue.address)}`);
    this.name = 'ParseError';
    this.issues = Object.freeze([
      Object.freeze({ ...issue, address: Object.freeze([...issue.address]) }),
    ]);
  }
}

const issue = (
  address: DocumentAddress,
  message: string,
  code: ParseIssue['code'] = 'invalid-value'
): ParseIssue => ({ address, message, code });

const sameParsedValue = (left: unknown, right: unknown, seen?: Map<object, object>): boolean => {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
  )
    return false;
  seen ??= new Map();
  if (seen.has(left)) return seen.get(left) === right;
  seen.set(left, right);
  if (left instanceof Date && right instanceof Date)
    return Object.is(left.getTime(), right.getTime());
  if (left instanceof RegExp && right instanceof RegExp)
    return (
      left.source === right.source &&
      left.flags === right.flags &&
      left.lastIndex === right.lastIndex
    );
  if (left instanceof Map && right instanceof Map)
    return sameParsedValue([...left], [...right], seen);
  if (left instanceof Set && right instanceof Set)
    return sameParsedValue([...left], [...right], seen);
  if (left instanceof ArrayBuffer && right instanceof ArrayBuffer)
    return sameParsedValue(new Uint8Array(left), new Uint8Array(right), seen);
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  const keys = Reflect.ownKeys(left);
  if (
    keys.length !== Reflect.ownKeys(right).length ||
    (Array.isArray(left) && left.length !== (right as unknown[]).length)
  )
    return false;
  return keys.every(
    key =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameParsedValue(
        (left as Record<PropertyKey, unknown>)[key],
        (right as Record<PropertyKey, unknown>)[key],
        seen
      )
  );
};

export const checkScalar = (
  validator: Validator<unknown> | undefined,
  value: unknown,
  address: DocumentAddress,
  strict: boolean,
  copy?: (value: unknown) => unknown
): ParseIssue | undefined => {
  if (!validator)
    return strict
      ? issue(address, 'A validator is required to parse an opaque value.', 'missing-validator')
      : undefined;
  try {
    const input = copy ? copy(value) : detached(value);
    const result =
      typeof validator === 'function' ? validator(input) : validator['~standard'].validate(input);
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    )
      return issue(address, 'Validators must be synchronous.');
    let output = result;
    if (typeof validator !== 'function') {
      if (!isRecord(result)) return issue(address, 'Malformed validator result.');
      if (Array.isArray(result.issues)) {
        const first = result.issues[0];
        return issue(
          [
            ...address,
            ...(first?.path ?? []).map((part: PropertyKey | { key: PropertyKey }) =>
              String(typeof part === 'object' ? part.key : part)
            ),
          ],
          first?.message ?? 'Value validation failed.'
        );
      }
      output = result.value;
    }
    if (!sameParsedValue(input, output) || !sameParsedValue(value, input))
      return issue(
        address,
        'Validators must preserve values; perform transformations before parsing.'
      );
    return undefined;
  } catch (error) {
    return issue(address, error instanceof Error ? error.message : 'Value validation failed.');
  }
};

export const checkKey = (
  validator: Validator<string> | undefined,
  value: unknown,
  address: DocumentAddress
): ParseIssue | undefined => {
  if (typeof value !== 'string')
    return issue(address, 'Collection keys must be strings.', 'invalid-key');
  const failure = checkScalar(validator, value, address, false);
  return failure ? { ...failure, code: 'invalid-key' } : undefined;
};

export const checkValue = (
  node: DocumentNode,
  value: unknown,
  address: DocumentAddress = [],
  strict = false
): ParseIssue | undefined => {
  if (node.optional && value === undefined) return undefined;
  if (node.kind === 'field')
    return checkScalar(node.validator, value, address, strict, node.snapshot);
  if (node.kind === 'object') {
    if (!isPlainObject(value)) return issue(address, 'Expected an object.');
    for (const key of Object.keys(node.shape)) {
      const child = node.shape[key];
      if (!Object.prototype.hasOwnProperty.call(value, key) && !child.optional)
        return issue([...address, key], 'Required property is missing.');
      const failure = checkValue(child, value[key], [...address, key], strict);
      if (failure) return failure;
    }
    return undefined;
  }
  if (node.kind === 'variant') {
    if (!isPlainObject(value)) return issue(address, 'Expected a variant object.');
    const tag = value[node.tag];
    if (typeof tag !== 'string' || !Object.prototype.hasOwnProperty.call(node.variants, tag))
      return issue([...address, node.tag], 'Unknown variant tag.');
    return checkValue(node.variants[tag], value, address, strict);
  }
  if (node.kind === 'table' || node.kind === 'map') {
    if (!isPlainObject(value)) return issue(address, 'Expected a collection object.');
    const entries = node.kind === 'table' ? value.byId : value;
    if (!isPlainObject(entries)) return issue(address, 'Expected a byId object.');
    if (node.kind === 'table') {
      if (!Array.isArray(value.ids) || value.ids.length !== Object.keys(entries).length)
        return issue(address, 'Table ids and entries must agree.');
      const seen = new Set<string>();
      for (const id of value.ids) {
        const failure = checkKey(node.key, id, address);
        if (failure) return failure;
        if (seen.has(id) || !Object.prototype.hasOwnProperty.call(entries, id))
          return issue(address, 'Table ids must be unique and reference existing entries.');
        seen.add(id);
      }
    }
    for (const id of Object.keys(entries)) {
      const failure =
        checkKey(node.key, id, [...address, id]) ??
        checkValue(node.value, entries[id], [...address, id], strict);
      if (failure) return failure;
    }
    return undefined;
  }
  if (node.kind === 'list') {
    if (!Array.isArray(value)) return issue(address, 'Expected a list.');
    const seen = new Set<string>();
    const order = anchor.keys(value, node.keyOf);
    for (let i = 0; i < value.length; i++) {
      const failure = checkValue(node.value, value[i], [...address, String(i)], strict);
      if (failure) return failure;
      let key: unknown;
      try {
        key = order.at(i);
      } catch {
        return issue(address, 'List keyOf failed.');
      }
      if (typeof key !== 'string' || seen.has(key))
        return issue(address, 'List keys must be unique strings.', 'invalid-key');
      seen.add(key);
    }
    return undefined;
  }
  if (!validTree(value)) return issue(address, 'Invalid tree structure.', 'invalid-tree');
  if (isRecord(value) && isRecord(value.nodes)) {
    for (const id of Object.keys(value.nodes)) {
      const entry = value.nodes[id];
      if (isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'value')) {
        const failure = checkValue(node.value, entry.value, [...address, id], strict);
        if (failure) return failure;
      }
    }
  }
  return undefined;
};

/** Detached values support plain structures and structured-clone builtins; opaque objects need a field copier. */
export const detached = <T>(value: T, seen?: Map<object, unknown>): T => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (typeof value === 'function')
    throw new TypeError('A snapshot copier is required for functions.');
  seen ??= new Map();
  if (seen.has(value)) return seen.get(value) as T;
  if (Array.isArray(value) || isPlainObject(value)) {
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? new Array(value.length)
      : Object.create(Object.getPrototypeOf(value));
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      Object.defineProperty(result, key, {
        value: detached((value as Record<PropertyKey, unknown>)[key], seen),
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
        writable: true,
        configurable: true,
      });
    }
    return result as T;
  }
  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    value.forEach((entry, key) => result.set(detached(key, seen), detached(entry, seen)));
    return result as T;
  }
  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    value.forEach(entry => result.add(detached(entry, seen)));
    return result as T;
  }
  if (value instanceof RegExp) {
    const result = new RegExp(value.source, value.flags);
    result.lastIndex = value.lastIndex;
    return result as T;
  }
  if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return structuredClone(value);
  throw new TypeError('A snapshot copier is required for opaque objects.');
};

export const snapshotValue = (node: DocumentNode, value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (node.kind === 'field' && node.snapshot) {
    const copy = node.snapshot(value);
    if (
      copy &&
      (typeof copy === 'object' || typeof copy === 'function') &&
      'then' in copy &&
      typeof copy.then === 'function'
    )
      throw new TypeError('Snapshot copiers must be synchronous.');
    if (
      copy === value &&
      value !== null &&
      (typeof value === 'object' || typeof value === 'function')
    )
      throw new TypeError('Snapshot copiers must return an independent value.');
    return copy;
  }
  if (node.kind === 'object' && isRecord(value)) {
    const result: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value))
      Object.defineProperty(result, key, {
        value:
          typeof key === 'string' && Object.prototype.hasOwnProperty.call(node.shape, key)
            ? snapshotValue(node.shape[key], value[key])
            : detached((value as Record<PropertyKey, unknown>)[key]),
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
      });
    return Object.freeze(result);
  }
  if (node.kind === 'variant' && isRecord(value)) {
    const branch = node.variants[String(value[node.tag])];
    if (branch) return snapshotValue(branch, value);
  }
  if ((node.kind === 'map' || node.kind === 'table') && isRecord(value)) {
    const entries = node.kind === 'table' ? value.byId : value;
    if (isRecord(entries)) {
      const result: Record<string, unknown> = Object.create(Object.getPrototypeOf(entries));
      for (const id of Object.keys(entries))
        Object.defineProperty(result, id, {
          value: snapshotValue(node.value, entries[id]),
          enumerable: true,
        });
      Object.freeze(result);
      return node.kind === 'table'
        ? Object.freeze({ ids: Object.freeze([...(value.ids as string[])]), byId: result })
        : result;
    }
  }
  if (node.kind === 'list' && Array.isArray(value))
    return value.map(item => snapshotValue(node.value, item));
  if (node.kind === 'tree' && isRecord(value) && isRecord(value.nodes)) {
    const nodes = Object.fromEntries(
      Object.entries(value.nodes).map(([id, entry]) => {
        const item = entry as { parentId?: string; children: string[]; value?: unknown };
        return [
          id,
          {
            ...item,
            children: [...item.children],
            ...(Object.hasOwn(item, 'value')
              ? { value: snapshotValue(node.value, item.value) }
              : {}),
          },
        ];
      })
    );
    return { ...value, nodes };
  }
  return detached(value);
};

/** Copy editable structure; atomic payloads retain their immutable ownership contract. */
export const copyValue = (node: DocumentNode, value: unknown): unknown => {
  if (value === undefined || node.kind === 'field') return value;
  if (node.kind === 'variant' && isRecord(value))
    return copyValue(node.variants[String(value[node.tag])], value);
  if (node.kind === 'object' && isRecord(value)) {
    const result = Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value))
      Object.defineProperty(result, key, {
        value:
          typeof key === 'string' && Object.hasOwn(node.shape, key)
            ? copyValue(node.shape[key], value[key])
            : cloneValue((value as Record<PropertyKey, unknown>)[key]),
        writable: true,
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
        configurable: true,
      });
    return result;
  }
  if ((node.kind === 'table' || node.kind === 'map') && isRecord(value)) {
    const entries = (node.kind === 'table' ? value.byId : value) as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.keys(entries).map(id => [id, copyValue(node.value, entries[id])])
    );
    return node.kind === 'table' ? { ids: [...(value.ids as string[])], byId: result } : result;
  }
  if (node.kind === 'list') return [...(value as unknown[])];
  if (node.kind === 'tree' && isRecord(value)) {
    const entries = value.nodes as Record<string, { children: readonly string[] }>;
    return {
      ...value,
      nodes: Object.fromEntries(
        Object.entries(entries).map(([id, n]) => [id, { ...n, children: [...n.children] }])
      ),
    };
  }
  return value;
};

export const equalValue = (node: DocumentNode, left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (node.kind === 'field' || left === undefined || right === undefined) return false;
  if (node.kind === 'variant' && isRecord(left) && isRecord(right))
    return (
      left[node.tag] === right[node.tag] &&
      equalValue(node.variants[String(left[node.tag])], left, right)
    );
  if (node.kind === 'list' && Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((v, i) => equalValue(node.value, v, right[i]))
    );
  if (node.kind === 'table' && isRecord(left) && isRecord(right))
    return (
      deepEqual(left.ids, right.ids) &&
      equalValue({ kind: 'map', value: node.value }, left.byId, right.byId)
    );
  if (node.kind === 'tree' && isRecord(left) && isRecord(right)) {
    if (left.rootId !== right.rootId) return false;
    const a = left.nodes as Record<
        string,
        { parentId?: string; children: string[]; value?: unknown }
      >,
      b = right.nodes as typeof a;
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        id =>
          Object.hasOwn(b, id) &&
          a[id].parentId === b[id].parentId &&
          deepEqual(a[id].children, b[id].children) &&
          Object.hasOwn(a[id], 'value') === Object.hasOwn(b[id], 'value') &&
          equalValue(node.value, a[id].value, b[id].value)
      )
    );
  }
  if ((node.kind === 'object' || node.kind === 'map') && isRecord(left) && isRecord(right)) {
    const keys = Reflect.ownKeys(left);
    return (
      keys.length === Reflect.ownKeys(right).length &&
      keys.every(key => {
        if (!Object.hasOwn(right, key)) return false;
        const child =
          typeof key === 'string'
            ? node.kind === 'map'
              ? node.value
              : Object.hasOwn(node.shape, key)
                ? node.shape[key]
                : undefined
            : undefined;
        const a = (left as Record<PropertyKey, unknown>)[key],
          b = (right as Record<PropertyKey, unknown>)[key];
        return child ? equalValue(child, a, b) : deepEqual(a, b);
      })
    );
  }
  return false;
};

export const parse = <N extends DocumentNode>(node: N, input: unknown): Infer<N> => {
  const valueNode: DocumentNode = node;
  const failure = checkValue(valueNode, input, [], true);
  if (failure) throw new ParseError(failure);
  return snapshotValue(valueNode, input) as Infer<N>;
};
