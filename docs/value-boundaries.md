# Value Boundaries

`Infer<N>` describes independent schema data. `Read<N>` and `Draft<N>` describe
scoped access with different permissions. `snapshot(scope)` returns the matching
Infer value at that instant. Its structural objects can be frozen, while detached
atomic builtins remain independent values.

## Structure And Atomic Values

Object nodes expose ordinary editable properties. Fields are atomic and return
deeply readonly values from scoped access. Replace an object field with a new
value; never mutate its nested arrays, Map entries, Date state or object members.
This is an ownership contract, not a runtime defensive deep-proxy mechanism.

Canonical copies traverse editable schema structure and preserve atomic payloads.
Callers must stop mutating supplied payloads. Snapshots detach atomic values and
use a field's `snapshot(value)` copier for opaque classes or functions. Copiers
must be synchronous and return independent values. Lists and trees get their
validation and copying rules from their field value node.

A standalone raw field value carries no schema metadata. `snapshot(rawValue)`
uses generic copying; snapshot the containing structural scope to invoke the
field's custom copier. Detached collection read methods reject use after their
schema branch changes; fetch the method from the current proxy again.

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

Validators are synchronous, value-preserving functions or Standard Schema v1
objects. Validation runs against detached input so a validator cannot mutate a
canonical payload. Transformation and async validation are rejected.
Strict `parse` requires validators for atomic values; typed runtime fields may
omit them. Incremental writes validate only their affected values.

Map/table key validators can infer branded string keys. Those types survive
indexing, table methods and anchors, symbolic item paths, projection mapping and
collection impact. Symbolic path registration validates keys too. Raw external
documents and ChangeSet assignments pass the same key boundary.

Absent values are distinct from present `undefined`. Optional object properties
can be deleted; required properties cannot. Map entry deletion controls membership
independently of whether its field value accepts undefined.

## Lifetimes

Structural access expires at callback completion. Retained child proxies are
address accessors, not references to removed canonical objects. Delete/recreate
and variant replacement must resolve current schema and data before later use.
`in`, enumeration and snapshots register explicit read dependencies. Framework
reads forbid document writes while evaluating their callback.
