# Doxum Contribution Guide

## Repository Layout

- `core` is the framework-neutral Doxum runtime and is the owner of schema,
  ChangeSets, canonical document state, history, impact, and projections.
- `react` is a one-way adapter from `doxum` to React. Do not import React
  or UI concepts into `core`.
- Root `dist` is build output. Change `src` and rebuild; do
  not edit generated files.

## Development

Use pnpm from the repository root:

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

Run a package-level command when iterating on a focused change, then run
`pnpm run check` before handing off. Use `pnpm run bench` or `pnpm run profile`
when a change touches addressing, mutation, impact, notifications, or views.

## Runtime Invariants

- `createDocument` is the single write authority for canonical document state.
  New mutation behavior must flow through transactions or `apply`; never add a
  second writable cache or bypass the mutation session.
- A transaction is synchronous and atomic. Preserve rollback behavior for each
  new operation and test rejected batches after partial work.
- Every committed ChangeSet needs correct before/after data and an exact impact.
  Update history and notification tests alongside mutation behavior.
- `mutation/changes.ts` is the sole unknown ChangeSet boundary. Decode and
  normalize before execution. `mutation/recorder.ts` owns first-touch state,
  rollback and final net changes grouped by owning container; do not keep per-write
  forward/inverse logs or a flat ChangeSet intermediate representation.
  Members publish added/removed/updated transitions; root reset is explicit.
  Fixed members use schema slots; coverage indexes store owning groups, not scalar leaves.
  Reuse validated ChangeSet publications by identity under the readonly ownership contract.
- Public `apply` requires a matching `expectedRevision`. Record actual local
  before values rather than trusting incoming reverse data. Local root resets
  are reversible; remote commits invalidate local history.
- `mutation/issue.ts` owns engine failure construction. Use typed
  `MutationIssue` for runtime failures and `DocumentDiagnostic` only for
  application-level `TransactionRejected`. Ordinary exceptions roll back and
  rethrow unchanged; business notices use callback return values.
- `mutation/tree.ts` owns tree validation and traversal. Trees are empty or
  single-root, connected, acyclic structures with reciprocal parent/child
  links; validate replacement and import boundaries before writing them.
- `mutation/anchor.ts` owns ordered-key and Anchor semantics. Table, list, and
  recorder code must call it rather than recreate key/index calculations.
  Canonical list key indexes are derived caches; structural writes and rollback
  use anchor sequence operations that own invalidation. Do not expose a separate
  manual cache-invalidation protocol. Pure value replay must not revalidate unrelated collection values.
- `impact-target.ts` owns `ImpactTarget` address, schema ownership, identity,
  equality, bucketing, and exact subscription matching. Notifications must not
  construct commit impact indexes to filter candidates. Core and React must not inspect selector target
  shapes locally.
- Schema resolution is authoritative for changes and selectors. Do not add
  alternate string-path parsers or separate address models.
  Fixed and dynamic member layouts are discriminated schema facts; fixed members
  always have slots. Object/variant input is closed to undeclared own properties;
  use maps for dynamic keys and fields for arbitrary payloads.
- `access/scope.ts` owns Read/Draft access. Structural scopes expire at callback
  completion; atomic field interiors are readonly under the ownership contract.
  `assign` accepts plain Infer replacements through the same mutation session.
- Root ObjectNode is schema identity. Subscription/impact/collection paths compile
  at their consumer boundary; do not export application target constructors.
- `ProjectionCollection` and `ProjectionValue` are derived state. Their values must
  be recomputed from runtime state and declared sources, never manually kept in
  sync by callers.
- Preserve notification ordering: materialized processors settle before
  external listeners; writes remain forbidden while notifying. Observer
  failures are returned on the committed result and must not be rethrown as a
  mutation rejection.
- Explicit projection batches defer graph settlement and projection listeners,
  but not document commits or document listeners. Batch the full application
  action before its first commit; readers return the last published projection
  inside the batch. Processor dependencies are explicit, not automatically tracked.

## Testing Expectations

- Add or update tests in `core/test` for core behavior and `react/test` for
  adapter behavior.
- A mutation change should cover success, rejection/rollback, history inverse,
  and impact or subscription behavior when applicable. ChangeSet boundary
  changes must include malformed input tests; tree changes must include
  invalid snapshots and root/orphan/cycle cases.
- A projection change should cover unrelated commits, dynamic dependencies,
  stable references, and disposal where relevant.
- Large-collection, list, or tree paths need an optimization regression test
  when they could accidentally copy or traverse unrelated data.

## Public API And Packaging

- `doxum` is the public package identity. Keep its root, `integration`,
  `local-sync` and `react` exports aligned with `dist` output.
- Public behavior is exported deliberately from package entry points. Keep
  internal runtime plumbing unexported unless it forms a stable external
  contract.
- Local-sync change limits govern admission of new local commits, not durable
  replay. Previously admitted records must remain readable under smaller current limits.
- Keep package-specific dependencies in that package. Shared build and test
  tooling belongs in the root `package.json`.
- Keep `format`, `format:check`, and `lint` passing. The root lint policy is
  intentionally narrow: it protects framework and package dependency
  direction, not personal formatting preferences.
- Update README examples and `docs/architecture.md` when public behavior or
  lifecycle semantics change.
