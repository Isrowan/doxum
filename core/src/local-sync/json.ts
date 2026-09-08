import { isPlainObject } from '../value/ownership';
import { changeCount, decodeChanges } from '../mutation/changes';
import type { ChangeSet } from '../changes';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonChangeLimits = {
  readonly maxChanges?: number;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
};

type ResolvedJsonLimits = {
  readonly maxChanges: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
};

export const defaultJsonChangeLimits: Readonly<ResolvedJsonLimits> = Object.freeze({
  maxChanges: 1_000,
  maxBytes: 1_000_000,
  maxDepth: 64,
  maxStringLength: 256_000,
});

export class LocalSyncDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSyncDataError';
  }
}

const describePath = (path: readonly string[]): string =>
  path.length === 0 ? 'value' : path.join('.');

const limit = (value: number | undefined, fallback: number, label: string): number => {
  if (value === undefined) return fallback;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new TypeError(`${label} must be a positive safe integer.`);
};

const resolveLimits = (input: JsonChangeLimits | undefined): ResolvedJsonLimits => ({
  maxChanges: limit(input?.maxChanges, defaultJsonChangeLimits.maxChanges, 'maxChanges'),
  maxBytes: limit(input?.maxBytes, defaultJsonChangeLimits.maxBytes, 'maxBytes'),
  maxDepth: limit(input?.maxDepth, defaultJsonChangeLimits.maxDepth, 'maxDepth'),
  maxStringLength: limit(
    input?.maxStringLength,
    defaultJsonChangeLimits.maxStringLength,
    'maxStringLength'
  ),
});

const validate = (
  value: unknown,
  path: string[],
  limits: ResolvedJsonLimits | undefined,
  depth: number,
  ancestors: WeakSet<object>
): JsonValue => {
  if (limits && depth > limits.maxDepth)
    throw new LocalSyncDataError(`${describePath(path)} exceeds the maximum JSON depth.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (!limits || value.length <= limits.maxStringLength) return value;
    throw new LocalSyncDataError(`${describePath(path)} exceeds the maximum string length.`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new LocalSyncDataError(`${describePath(path)} contains a non-finite number.`);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new LocalSyncDataError(`${describePath(path)} contains a cycle.`);
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        path.push(String(index));
        validate(value[index], path, limits, depth + 1, ancestors);
        path.pop();
      }
    } finally {
      ancestors.delete(value);
    }
    return value as readonly JsonValue[];
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value))
      throw new LocalSyncDataError(`${describePath(path)} contains a cycle.`);
    ancestors.add(value);
    try {
      for (const key of Object.keys(value)) {
        path.push(key);
        validate(value[key], path, limits, depth + 1, ancestors);
        path.pop();
      }
    } finally {
      ancestors.delete(value);
    }
    return value as { readonly [key: string]: JsonValue };
  }
  throw new LocalSyncDataError(`${describePath(path)} must be JSON data.`);
};

export const json = (value: unknown, label: string): JsonValue =>
  validate(value, [label], undefined, 0, new WeakSet());

export const jsonChanges = (value: unknown, label: string, input?: JsonChangeLimits): ChangeSet => {
  const limits = input === undefined ? undefined : resolveLimits(input);
  let changes: ChangeSet;
  try {
    changes = decodeChanges(value);
  } catch {
    throw new LocalSyncDataError(`${label} contains an invalid ChangeSet.`);
  }
  if (limits && changeCount(changes) > limits.maxChanges)
    throw new LocalSyncDataError(`${label} exceeds the maximum change count.`);
  validate(changes.changes, [label], limits, 0, new WeakSet());
  if (limits) {
    const serialized = JSON.stringify(changes.changes);
    if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes)
      throw new LocalSyncDataError(`${label} exceeds the maximum ChangeSet size.`);
  }
  return changes;
};
