export type KeyedEntries<K extends string, V> = readonly (readonly [K, V])[];

/** Shared entry boundary; membership and duplicate policy belong to each operation. */
export function assertKeyedEntry(entry: unknown, name: string): void {
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
    throw new TypeError(`${name} entries must be [string key, value] tuples.`);
}
