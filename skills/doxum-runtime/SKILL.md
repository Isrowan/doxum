---
name: doxum-runtime
description: 'Use Doxum core, advanced projections, React, and local-sync for schemas, document state, ChangeSets, history, projections, subscriptions, persistence, and adapters.'
---

# Doxum Runtime

Read the [English guide](references/guide.en.md) or [中文指南](references/guide.zh-CN.md).
For examples read [patterns](references/patterns.en.md) or [中文模式](references/patterns.zh-CN.md).
For exact public call shapes, exported package surface, callback contexts, result
types, and supported errors, read the [API reference](references/api.en.md) or
[中文 API 参考](references/api.zh-CN.md) instead of implementation source.
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
- `Schema` / `ObjectSchema` are portable schema handles. Export inferred schemas
  directly; application code should not need `ReturnType<typeof object>` or internal
  node types to make declarations portable.
- Projection definitions are lazy; one ProjectionRuntime owns all materialized
  producers, outputs, scheduling and source attachments for that Runtime.
  `KeyedProjection<K,V>` is the single public keyed projection handle. Collection
  `observe`, `derive.keyed`, `incremental.collection`, group collection leaves and
  `CollectionInput<K,V>` all use that same keyed capability.
  Use named-object `derive` for pure aggregate values. The `derive.keyed` family owns
  keyed derivation: ordinary `derive.keyed` preserves driver membership/order;
  `keys`/`values` expose standard ordered read shapes; `subset`/`filter`/`compact` own
  membership-changing derivation without application-side collection patch loops.
  Per-entry equality suppresses unchanged generated values. Its dependency form uses a named object: plain Projection members
  invalidate the driver key set, while `{ source, key }` members let the Runtime own
  per-output-key source bindings and reverse lookup. Selectors receive
  `(entry, key)` or `(entry, key, dependencies)`. The producer graph remains explicit and static;
  processors never perform imperative Runtime reads to discover dependencies.
  `input.collection` edits have a strong exception boundary: callback or per-entry
  equality failure leaves both the published value and the next draft unchanged.
  A `ProjectionScope` only adds lifecycle ownership through `scope.own(...)`; create
  definitions with the root declaration APIs, then own a projection or static output tree
  before that definition is first materialized as a root.
  Use advanced `incremental` only for retained state or cross-key coordination that
  cannot be expressed by the `derive.keyed` family. `collectionChange.keys` is the
  transport-level iterable for incremental added/updated/removed keys; callers handle
  reset and order semantics themselves. React selector tracking remains a consumer
  concern through `ProjectionProvider` and `useProjection(projection, selector)`.
- Advanced incremental definitions always declare `process`; `state()` is present only
  when retained state is actually needed. `incremental.group` declares its static
  output tree through the synchronous `output` callback. `define.value` and
  `define.collection` are callback methods, not separate imports; every returned leaf
  is a `Projection<T>` or `KeyedProjection<K,V>` from the same producer.
- Observer errors leave commits accepted. Do not retry as if they rolled back.
- Core stays framework-neutral; adapters consume standard `Readable`,
  document `select`, and projection readables without internal target/address protocols.
- Local sync owns browser persistence/leadership. Network conflict policy and
  collaborative undo belong at a separate boundary.

Update examples and tests when behavior changes. Never add compatibility APIs,
a second path grammar, a parallel join/dependency protocol, or another writable
derived cache.
