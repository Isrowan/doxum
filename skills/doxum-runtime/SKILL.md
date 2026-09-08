---
name: doxum-runtime
description: 'Use doxum and doxum/react for schemas, scoped draft updates, ChangeSets, history, projections, subscriptions and React integration.'
---

# Doxum Runtime

Read the [English guide](references/guide.en.md) or [中文指南](references/guide.zh-CN.md).
For examples read [patterns](references/patterns.en.md) or [中文模式](references/patterns.zh-CN.md).
Before runtime changes read [invariants](references/invariants.en.md) or
[中文不变量](references/invariants.zh-CN.md).

- Root object defines schema identity; Infer describes readonly data with shared immutable payloads.
- createDocument owns canonical state. update, apply and replace share one session.
- Draft and trusted internal readWith scopes are borrowed for synchronous callbacks;
  their proxies must not escape. Public values should use snapshot when they need to
  outlive the callback.
- Atomic fields are deeply readonly during access and replaced whole.
- Use assign(scope, key, value) for replacements containing nested collection tools.
- Expected business failure throws TransactionRejected. Other exceptions roll back
  and rethrow unchanged. Callback returns carry business values and notices.
- Commits contain final reversible ChangeSets. History and impact share those facts.
- ChangeSets group member transitions by container, with explicit added/removed/updated
  kinds, optional before/after order in the same group, and a separate root reset.
  Standalone order records and duplicate groups are invalid. Grouping preserves field-level impact.
- Paths belong in subscription, impact and collection source callbacks.
- Projection dependencies are explicit; React selectors track actual reads.
- Observer errors leave commits accepted. Do not retry as if they rolled back.
- Core stays framework-neutral; adapters use integration capabilities.
- Local sync owns browser persistence/leadership. Network conflict policy and
  collaborative undo belong at a separate boundary.

Update examples and tests when behavior changes. Never add compatibility APIs,
a second path grammar or another writable derived cache.
