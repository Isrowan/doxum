# Doxa Contribution Guide

## Repository Layout

- `core` is the framework-neutral Doxa runtime and is the owner of schema,
  operations, canonical document state, history, impact, and projections.
- `react` is a one-way adapter from `@doxa/core` to React. Do not import React
  or UI concepts into `core`.
- `core/dist` and `react/dist` are build output. Change `src` and rebuild; do
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
- Every committed operation needs correct inverse data and an exact impact.
  Update history and notification tests alongside mutation behavior.
- `mutation/operation.ts` is the sole operation boundary: decode external
  input before journal/resolution/execution, normalize it once, and use its
  publish/inverse APIs for public operation payloads. Do not add executor-side
  envelope parsing.
- `mutation/issue.ts` owns engine failure construction. Use typed
  `MutationIssue` for runtime failures and `DocumentDiagnostic` only for
  application-level `tx.report` / `tx.reject` behavior.
- `mutation/tree.ts` owns tree validation and traversal. Trees are empty or
  single-root, connected, acyclic structures with reciprocal parent/child
  links; validate replacement and import boundaries before writing them.
- `mutation/anchor.ts` owns ordered-key and Anchor semantics. Table, list, and
  journal code must call it rather than recreate key/index calculations.
- `impact-target.ts` owns `ImpactTarget` address, schema ownership, identity,
  equality, and bucketing. Core and React must not inspect selector target
  shapes locally.
- Schema resolution is authoritative for operations and selectors. Do not add
  alternate string-path parsers or separate address models.
- `CollectionView` and `MaterializedView` are derived state. Their values must
  be recomputed from runtime state and declared sources, never manually kept in
  sync by callers.
- Preserve notification ordering: materialized processors settle before
  external listeners; writes remain forbidden while notifying. Observer
  failures are returned on the committed result and must not be rethrown as a
  mutation rejection.

## Testing Expectations

- Add or update tests in `core/test` for core behavior and `react/test` for
  adapter behavior.
- A mutation change should cover success, rejection/rollback, history inverse,
  and impact or subscription behavior when applicable. Boundary-operation
  changes must include malformed input tests; tree changes must include
  invalid snapshots and root/orphan/cycle cases.
- A projection change should cover unrelated commits, dynamic dependencies,
  stable references, and disposal where relevant.
- Large-collection, list, or tree paths need an optimization regression test
  when they could accidentally copy or traverse unrelated data.

## Public API And Packaging

- `@doxa/core` and `@doxa/react` are the public package identities. Keep their
  exports and internal imports aligned with `dist` output.
- Public behavior is exported deliberately from package entry points. Keep
  internal runtime plumbing unexported unless it forms a stable external
  contract.
- Keep package-specific dependencies in that package. Shared build and test
  tooling belongs in the root `package.json`.
- Keep `format`, `format:check`, and `lint` passing. The root lint policy is
  intentionally narrow: it protects framework and package dependency
  direction, not personal formatting preferences.
- Update README examples and `docs/architecture.md` when public behavior or
  lifecycle semantics change.
