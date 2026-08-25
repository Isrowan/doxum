import { isPlainObject } from '../value/ownership';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonCommandLimits = {
  readonly maxOperations?: number;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
};

type ResolvedJsonLimits = {
  readonly maxOperations: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
};

export const defaultJsonCommandLimits: Readonly<ResolvedJsonLimits> = Object.freeze({
  maxOperations: 1_000,
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

const resolveLimits = (input: JsonCommandLimits | undefined): ResolvedJsonLimits => ({
  maxOperations: limit(
    input?.maxOperations,
    defaultJsonCommandLimits.maxOperations,
    'maxOperations'
  ),
  maxBytes: limit(input?.maxBytes, defaultJsonCommandLimits.maxBytes, 'maxBytes'),
  maxDepth: limit(input?.maxDepth, defaultJsonCommandLimits.maxDepth, 'maxDepth'),
  maxStringLength: limit(
    input?.maxStringLength,
    defaultJsonCommandLimits.maxStringLength,
    'maxStringLength'
  ),
});

const validate = (
  value: unknown,
  path: readonly string[],
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
      for (let index = 0; index < value.length; index += 1)
        validate(value[index], [...path, String(index)], limits, depth + 1, ancestors);
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
      for (const [key, entry] of Object.entries(value))
        validate(entry, [...path, key], limits, depth + 1, ancestors);
    } finally {
      ancestors.delete(value);
    }
    return value as { readonly [key: string]: JsonValue };
  }
  throw new LocalSyncDataError(`${describePath(path)} must be JSON data.`);
};

export const json = (value: unknown, label: string): JsonValue =>
  validate(value, [label], undefined, 0, new WeakSet());

export const jsonArray = (
  value: unknown,
  label: string,
  input?: JsonCommandLimits
): readonly JsonValue[] => {
  const limits = resolveLimits(input);
  const parsed = validate(value, [label], limits, 0, new WeakSet());
  if (!Array.isArray(parsed)) throw new LocalSyncDataError(`${label} must be a JSON array.`);
  if (parsed.length > limits.maxOperations)
    throw new LocalSyncDataError(`${label} exceeds the maximum operation count.`);
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes)
    throw new LocalSyncDataError(`${label} exceeds the maximum command size.`);
  return parsed;
};
