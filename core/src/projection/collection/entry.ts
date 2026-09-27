/** Accepted member presence/value, shared by storage and net transition accumulation. */
export type CollectionEntry<V> =
  { readonly present: true; readonly value: V } | { readonly present: false };
