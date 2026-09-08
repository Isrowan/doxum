import type { DocumentAddress, DocumentNode, Infer } from './schema';
import { compiledShape } from './address';
import { isPlainObject, isRecord } from './value/ownership';
import { validate as validTree } from './mutation/tree';
import * as anchor from './mutation/anchor';
import { profile } from './profile';

/** Pure synchronous validation. Successful output is ignored; input is never transformed. */
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

export const checkScalar = (
  validator: Validator<unknown> | undefined,
  value: unknown,
  address: DocumentAddress,
  strict: boolean
): ParseIssue | undefined => {
  if (!validator)
    return strict
      ? issue(address, 'A validator is required to parse an opaque value.', 'missing-validator')
      : undefined;
  try {
    const result =
      typeof validator === 'function' ? validator(value) : validator['~standard'].validate(value);
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    )
      return issue(address, 'Validators must be synchronous.');
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
      if (!Object.hasOwn(result, 'value')) return issue(address, 'Malformed validator result.');
    }
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
  if (node.kind === 'field') return checkScalar(node.validator, value, address, strict);
  if (node.kind === 'object' || node.kind === 'variant') {
    if (!isPlainObject(value)) return issue(address, 'Expected an object.');
    if (node.kind === 'variant') {
      const tag = value[node.tag];
      if (
        !Object.hasOwn(value, node.tag) ||
        typeof tag !== 'string' ||
        !Object.hasOwn(node.variants, tag)
      )
        return issue([...address, node.tag], 'Unknown variant tag.');
    }
    const { members } = compiledShape(node, value)!;
    for (const key of Reflect.ownKeys(value)) {
      if (node.kind === 'variant' && key === node.tag) continue;
      if (typeof key !== 'string' || !members.has(key))
        return issue([...address, String(key)], 'Property is not declared in the object schema.');
    }
    for (const [key, member] of members) {
      const child = member.node;
      if (!Object.prototype.hasOwnProperty.call(value, key) && !child.optional)
        return issue([...address, key], 'Required property is missing.');
      const failure = checkValue(child, value[key], [...address, key], strict);
      if (failure) return failure;
    }
    return undefined;
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

/** Copy editable structure; atomic payloads retain their immutable ownership contract. */
export const copyValue = (node: DocumentNode, value: unknown): unknown => {
  if (value === undefined || node.kind === 'field') return value;
  profile.copy.structure();
  if ((node.kind === 'object' || node.kind === 'variant') && isRecord(value)) {
    const result = Object.create(Object.getPrototypeOf(value));
    const { members } = compiledShape(node, value)!;
    for (const key of Object.getOwnPropertyNames(value)) {
      Object.defineProperty(result, key, {
        value:
          node.kind === 'variant' && key === node.tag
            ? value[key]
            : copyValue(members.get(key)!.node, value[key]),
        writable: true,
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable,
        configurable: true,
      });
    }
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
  if ((node.kind === 'object' || node.kind === 'variant') && isRecord(left) && isRecord(right)) {
    if (node.kind === 'variant' && left[node.tag] !== right[node.tag]) return false;
    for (const [key, member] of compiledShape(node, left)!.members) {
      if (Object.hasOwn(left, key) !== Object.hasOwn(right, key)) return false;
      if (!equalValue(member.node, left[key], right[key])) return false;
    }
    return true;
  }
  if (node.kind === 'list' && Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((v, i) => equalValue(node.value, v, right[i]))
    );
  if (node.kind === 'table' && isRecord(left) && isRecord(right))
    return (
      anchor.equal(left.ids as string[], right.ids as string[]) &&
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
          anchor.equal(a[id].children, b[id].children) &&
          Object.hasOwn(a[id], 'value') === Object.hasOwn(b[id], 'value') &&
          equalValue(node.value, a[id].value, b[id].value)
      )
    );
  }
  if (node.kind === 'map' && isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) && equalValue(node.value, left[key], right[key]))
    );
  }
  return false;
};

export const parse = <N extends DocumentNode>(node: N, input: unknown): Infer<N> => {
  const valueNode: DocumentNode = node;
  const failure = checkValue(valueNode, input, [], true);
  if (failure) throw new ParseError(failure);
  return copyValue(valueNode, input) as Infer<N>;
};
