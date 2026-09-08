# Value Boundaries

`Infer<N>` describes readonly schema data, including readonly atomic payloads.
`Read<N>` and `Draft<N>` describe scoped access with different permissions.
`snapshot(scope)` returns the matching Infer value at that instant. Its editable
schema structure is independent, and its immutable payloads are shared.

## Structure And Atomic Values

Object nodes expose ordinary editable properties. Fields are atomic and return
deeply readonly values from scoped access. Replace an object field with a new
value; never mutate its nested arrays, Map entries, Date state or object members.
This is an ownership contract, not a runtime defensive deep-proxy mechanism.

Canonical copies traverse editable schema structure and preserve atomic payloads.
Inputs, Read/Draft, snapshots, ChangeSets, history and projections may all retain
the same payload reference. Callers must never mutate a supplied payload through
any alias, including after it is replaced or removed: history may still retain it.
This includes builtin mutation methods and mutable state reachable through classes
or function closures. `ReadonlyValue<T>` expresses common readonly types; it cannot
prevent every mutating method on arbitrary classes or typed arrays.

`copyValue` is the single schema structure copier. Object/map/table structures,
list arrays and tree topology are copied; fields, list items and tree payloads are
shared. Extra properties outside an object's declared shape are opaque readonly
values too. Subsequent document writes cannot change an earlier snapshot's structure.
Root snapshots, scoped snapshots and strict parse all follow these rules.
There is no field copier option. `snapshot(rawValue)` has no schema metadata and
returns the original readonly value without traversing it.

Commits, ChangeSets, addresses, snapshots and their payloads are readonly by contract.
The publication path does not freeze them. Do not modify published structures even
when JavaScript permits it: history and other consumers can share them. Mutable
application exports require an explicit application-owned copy (`structuredClone`
for supported data, or domain-specific conversion for other values). Serialization
belongs to adapters; local sync still accepts JSON data only.

Detached collection read methods reject use after their schema branch changes;
fetch the method from the current proxy again.

Atomic equality is `Object.is`. Replacing a field object with an equal-looking
new object is a change. Restoring the same original atomic reference is net-zero.
Schema structures compare their fields by these rules. Cross-process baselines
use revision/sequence, not reference comparison of transported before values.

## Assignment Types

Simple fields, object fields and ordinary map entries use property assignment.
TypeScript does not support different read/write types on a mapped index
signature: a nested table is read as collection tools but supplied as `{ ids, byId }`.
Use `assign(container, key, value)` for such replacements. It validates the key and
`Infer` data at compile time and routes to the same draft session at runtime.

```ts
const model = object({
  entries: map(object({ rows: table(object({ n: field<number>() })) })),
});
const document = createDocument({ schema: model, initial: { entries: {} } });
document.update(draft => {
  assign(draft.entries, 'a', { rows: { ids: ['x'], byId: { x: { n: 1 } } } });
  draft.entries.a!.rows.get('x')!.n++;
});
```

The helper also handles optional list/tree initialization and object-inherited
key names such as `constructor` when TypeScript's object type interferes with
index assignment. It grants no extra mutation authority and cannot modify a read
scope, ordinary object as a whole, or a variant discriminant.

## Validation

Validators are pure synchronous functions or Standard Schema v1 objects. They
receive the original input reference. They must not mutate input or perform side
effects. A successful output is ignored; Doxum retains the original input and does
not detect transformations or compare input/output deeply. Perform conversions
before entering Doxum. Mutation by a validator violates the ownership contract and
cannot be repaired by transaction rollback. Async validation is rejected.
Strict `parse` requires validators for atomic values; typed runtime fields may
omit them. Incremental writes validate only their affected values.
Reassigning an identical already-valid member is a no-op and does not invoke its
validator. Validators must not rely on invocation counts or external mutable state.

Map/table key validators can infer branded string keys. Those types survive
indexing, table methods and anchors, symbolic item paths, projection mapping and
collection impact. Symbolic path registration validates keys too. Raw external
documents and ChangeSet assignments pass the same key boundary.

Absent values are distinct from present `undefined`. Optional object properties
can be deleted; required properties cannot. Map entry deletion controls membership
independently of whether its field value accepts undefined.
ChangeSet member kinds carry that distinction directly: `added` has after,
`removed` has before, and `updated` has both. There is no Presence wrapper.
Before and after structure is fixed at seal time; deferred impact queries never
read later canonical state to reconstruct a published commit.

## Lifetimes

Structural access expires at callback completion. Retained child proxies are
address accessors, not references to removed canonical objects. Delete/recreate
and variant replacement must resolve current schema and data before later use.
`in`, enumeration and snapshots register explicit read dependencies. Framework
reads forbid document writes while evaluating their callback.
