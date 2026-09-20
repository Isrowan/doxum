import type { Readable } from '../readable';
import { contextOf } from '../runtime/context';
import type { ReadonlyDocument } from '../runtime/contract';
import type { Infer, ObjectSchema, ReadonlyValue } from '../schema/model';
import {
  compilePath,
  type CollectionEntry,
  type CollectionId,
  type CollectionPath,
  type PathValueOf,
  type SchemaPath,
  type ValueSelector,
} from '../schema/path';
import type { CollectionChange, ExternalCollectionSource, ExternalValueSource } from './contract';
import { defineSource, type Projection, type ProjectionWithChange } from './definition';

type PathSelector<S extends ObjectSchema<object>> = (path: SchemaPath<S>) => unknown;

/** Establish a lazy reactive boundary from a document, readable, or external source. */
export function observe<S extends ObjectSchema<object>>(
  document: ReadonlyDocument<S>
): Projection<Infer<S>>;
export function observe<T>(source: ExternalValueSource<T>): Projection<T>;
export function observe<K extends string, V>(
  source: ExternalCollectionSource<K, V>
): ProjectionWithChange<ReadonlyMap<K, V>, CollectionChange<K, V>>;
export function observe<T>(readable: Readable<T>): Projection<T>;
export function observe<S extends ObjectSchema<object>, P extends CollectionPath>(
  document: ReadonlyDocument<S>,
  selector: (path: SchemaPath<S>) => P
): ProjectionWithChange<
  ReadonlyMap<CollectionId<P>, ReadonlyValue<CollectionEntry<P>>>,
  CollectionChange<CollectionId<P>, ReadonlyValue<CollectionEntry<P>>>
>;
export function observe<S extends ObjectSchema<object>, P>(
  document: ReadonlyDocument<S>,
  selector: (path: SchemaPath<S>) => P
): Projection<PathValueOf<P>>;
export function observe<S extends ObjectSchema<object>>(
  source:
    | ReadonlyDocument<S>
    | Readable<unknown>
    | ExternalValueSource<unknown>
    | ExternalCollectionSource<string, unknown>,
  selector?: PathSelector<S>
): Projection<unknown> {
  if (isExternalSource(source))
    return source.kind === 'collection'
      ? defineSource(
          { kind: 'external-collection', source },
          { kind: 'collection', equality: Object.is }
        )
      : defineSource(
          { kind: 'external-value', source, equality: Object.is },
          { kind: 'value', equality: Object.is }
        );
  if ('current' in source && typeof source.current === 'function')
    return defineSource(
      { kind: 'readable', readable: source as Readable<unknown>, equality: Object.is },
      { kind: 'value', equality: Object.is }
    );

  const document = source as ReadonlyDocument<S>;
  const state = contextOf<S>(document).state;
  const selected = selector
    ? compilePath<S>(state.schema, 'auto', selector)
    : (Object.freeze({
        kind: 'value' as const,
        schema: state.schema,
        address: Object.freeze([]),
      }) as ValueSelector);
  return defineSource(
    {
      kind: 'document',
      document: document as unknown as ReadonlyDocument<ObjectSchema<object>>,
      selector: selected,
    },
    { kind: selected.kind, equality: Object.is }
  );
}

const isExternalSource = (
  source: unknown
): source is ExternalValueSource<unknown> | ExternalCollectionSource<string, unknown> => {
  if (!source || typeof source !== 'object') return false;
  const candidate = source as {
    readonly kind?: unknown;
    readonly current?: unknown;
    readonly revision?: unknown;
    readonly subscribe?: unknown;
  };
  return (
    (candidate.kind === 'value' || candidate.kind === 'collection') &&
    typeof candidate.current === 'function' &&
    typeof candidate.revision === 'function' &&
    typeof candidate.subscribe === 'function'
  );
};
