---
name: doxum-runtime
description: Use Doxum public APIs to design, implement, and review schemas, document mutations, projections, React bindings, local sync, and advanced processors without reading implementation source. Read maintainer invariants only when changing Doxum itself.
---

# Doxum Runtime

Use this skill as the public contract for Doxum. When Doxum is a dependency, work from the public API and these references. Do not inspect `core/src`, `react/src`, tests, source maps, or built JavaScript to discover how application code should use Doxum. If a public behavior is missing here while working in the Doxum repository, treat that as a skill documentation defect and update the skill together with the API change.

Answer and write examples in the user's language. The canonical references are intentionally single-source so API semantics cannot drift between translations.

## Ownership spine

Choose the owner before choosing an API:

- **Canonical application data** belongs to one `DocumentRuntime` created by `createDocument`.
- **Pure derived data** belongs to lazy `Projection` definitions and one materializing `ProjectionRuntime`.
- **Runtime-local UI/application state** belongs to `input` or `input.collection`, not to the canonical document unless it must participate in document history, persistence, replay, or impact.
- **Framework state** stays behind adapters. React consumes `Readable`, document selectors, projections, and projection inputs.
- **Browser durability/leadership** belongs to `doxum/local-sync`; network collaboration and distributed conflict policy are separate boundaries.
- **Retained incremental state** belongs to `doxum/advanced` only when ordinary `derive` / `derive.keyed` cannot express the work clearly.

## Reference routing

Read the smallest complete reference for the task before implementing it.

| Task                                                                                                                           | Read                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Exact imports, signatures, callback fields, result types, errors, and all public exports                                       | [Public API](references/public-api.md)             |
| Schema modeling, validators, Draft operations, reads, snapshots, commits, history, apply, impact, trees                        | [Document runtime](references/document-runtime.md) |
| `observe`, `derive`, the `derive.keyed` family, dynamic keyed dependencies, Runtime/scope/items, batching, advanced processors | [Projections](references/projections.md)           |
| React, external sources, `Readable`, and local-sync lifecycle                                                                  | [Integrations](references/integrations.md)         |
| End-to-end usage patterns that can be adapted directly                                                                         | [Recipes](references/recipes.md)                   |
| Editing or reviewing Doxum internals, ownership boundaries, scheduler/mutation architecture, release-facing invariants         | [Maintainer invariants](references/invariants.md)  |

For application work, do not read the maintainer reference unless the task is actually changing Doxum itself.

## Default API decisions

Follow these choices unless the requirement says otherwise:

1. Model stable document structure with `object`, `variant`, `map`, `table`, `list`, and `tree`; use `field` for atomic payloads that are replaced as a whole.
2. Mutate canonical state only through `document.update`, `document.apply`, `document.replace`, or history operations. Draft/read proxies are synchronous borrowed views and must not escape their callback.
3. Use `read` for one synchronous document read and `select` for a document `Readable` with dynamic dependency tracking.
4. Use `observe` to bring a document/readable/external source into the projection graph.
5. Use named-object `derive` for pure aggregate values.
6. Use `derive.keyed.from` to turn an ordered scalar/static collection into a keyed projection. Use `derive.keyed.singleton({ inputs }, computeEntry)` for zero or one computed member (`[key, value]` or `undefined`), and `derive.keyed.fromEntries({ inputs }, compute)` for a complete keyed result of arbitrary size; use `flatMap` when individual keyed parents must recompute independently. Use `derive.keyed.merge` to compose multiple keyed projections; for base + sparse overrides, use `{ conflict: 'last' }`.
7. Use `derive.keyed` when one keyed source owns output membership/order. Prefer its built-in `keys`, `values`, `entries`, `get`, `from`, `fromEntries`, `merge`, `subset`, `filter`, `compact`, `groupBy`, `flatMap`, and `singleton` primitives over hand-written incremental collection patches.
8. Express per-output-key joins through `{ source }` for same-key lookup, `{ source, key }` for one mapped key, or `{ source, keys }` for several mapped keys. Let the Runtime own binding and reverse invalidation; do not maintain an application `Map` just to route dependency changes.
9. Use `runtime.items(keyedProjection)` or `scope.items(...)` for stable per-membership item `Readable`s.
10. Use `incremental.keyed` for independent retained state per driver key. Use `incremental.collection` or `incremental.group` only when direct incremental output patching or shared retained state is required.
11. Use `ProjectionScope` only for lifecycle ownership. Define projections normally, then `scope.own(...)` before that definition is first materialized as a root.

Use `runtime.read` or `Readable.current()` for current values both inside and outside batches. `runtime.batch(() => ...)` groups net notifications; demanded dependencies may compute during a read. Ordinary commands compose without another reader API. Keep derived values in derive instead of synchronizing an input mirror. Use `derive.keyed.flatMap` for synchronous pure one-to-many output with global child keys; do not hand-maintain child membership in advanced state.

## Failure and lifecycle rules

- Doxum callbacks are synchronous unless the public API explicitly returns a Promise.
- `TransactionRejected` expresses expected application rejection; ordinary thrown exceptions roll back and rethrow unchanged.
- A committed document write remains committed even if projection or listener notification later fails; observer errors are reported on the result or through projection error handling.
- `CollectionChange` is an advanced processor transport contract. Reset, membership transitions, value updates, and order are distinct facts.
- Input acceptance has a strong exception boundary: assignment equality or collection callback/equality failure installs no partial next state. A batch is not a transaction and retains earlier successful writes.
- Dispose the owning `ProjectionRuntime`, `ProjectionScope`, and `LocalSync` with the application/service lifecycle that created them.

## Completion contract

Before finishing Doxum application work, verify that:

- every import comes from `doxum`, `doxum/advanced`, `doxum/react`, or `doxum/local-sync`;
- no application behavior depends on an internal path, private brand, generated chunk, or source implementation detail;
- canonical, projection, input, adapter, and persistence responsibilities have one owner each;
- advanced APIs are used only for requirements that the ordinary public projection family cannot express;
- examples follow the documented public failure and lifecycle semantics.
