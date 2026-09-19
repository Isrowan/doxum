---
name: doxum-runtime
description: 'Use doxum and doxum/react for schemas, scoped draft updates, ChangeSets, history, projections, subscriptions and React integration.'
---

# Doxum Runtime

Read the [English guide](references/guide.en.md) or [中文指南](references/guide.zh-CN.md).
For examples read [patterns](references/patterns.en.md) or [中文模式](references/patterns.zh-CN.md).
For any projection design or implementation, especially custom processors or
cross-collection dependencies, read the [projection reference](references/projections.en.md)
or [中文 Projection 参考](references/projections.zh-CN.md).
Before runtime changes read [invariants](references/invariants.en.md) or
[中文不变量](references/invariants.zh-CN.md).

- Root object defines schema identity; Infer describes readonly data with shared immutable payloads.
- createDocument owns canonical state. update, apply and replace share one session.
- Draft and trusted internal readWith scopes are borrowed for synchronous callbacks;
  their proxies must not escape. Public values should use snapshot when they need to
  outlive the callback.
- Atomic fields are deeply readonly during access and replaced whole.
- Maps use get/has/ids/put/remove/replace; table/list/tree use overloaded replace
  for member and whole-container replacement. Use replace(parent, key, value) for
  object or variant members whose Draft type contains collection tools.
- Ordered table/list Drafts use move(key | readonly key[], anchor?) for relative
  movement and reorder(keys) for an exact full-membership permutation.
- Trees may be empty. `tree(field(...))` requires every existing node to own `value`;
  use `tree(optional(field(...)))` only when node payload absence is part of the model.
  `optional(tree(...))` controls whole-tree presence independently.
- Tree projection paths reuse ordinary source protocols: `tree.rootId` is scalar,
  `tree.nodes` is keyed, and `tree.nodes.item(id)` is a single-node value.
- Expected business failure throws TransactionRejected. Other exceptions roll back
  and rethrow unchanged. Callback returns carry business values and notices.
- Commits contain final reversible ChangeSets. History and impact share those facts.
- ChangeSets group member transitions by container, with explicit added/removed/updated
  kinds, optional before/after order in the same group, and a separate root reset.
  Standalone order records and duplicate groups are invalid. Grouping preserves field-level impact.
- Paths belong in subscription, impact and collection source callbacks.
- Projection definitions are lazy; one ProjectionRuntime owns all materialized
  producers, outputs, scheduling and source attachments for that Runtime.
  Use tuple `derive` for pure values. Advanced `incremental` processors declare every
  source, own any forward/reverse dependency indexes, derive from final batched source
  state, and recover from resets internally. Core projections never track reads
  automatically; React selectors do through `ProjectionProvider` and
  `useProjection(projection, selector)`.
- Observer errors leave commits accepted. Do not retry as if they rolled back.
- Core stays framework-neutral; adapters consume standard `Readable`,
  document `select`, and projection readables without internal target/address protocols.
- Local sync owns browser persistence/leadership. Network conflict policy and
  collaborative undo belong at a separate boundary.

Update examples and tests when behavior changes. Never add compatibility APIs,
a second path grammar or another writable derived cache.
