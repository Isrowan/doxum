---
name: doxum-runtime
description: 'Use doxum and doxum/react to design, build, or review Doxum document runtime code. Apply for schemas, mutations, operations, views, subscriptions, and React integration.'
---

# Doxum Runtime

Use this skill when a task creates, modifies, reviews, or explains Doxum code.
It applies to `doxum`, `doxum/react`, and application code that uses
Doxum's schema, runtime, transaction, operation, impact, projection, or React
APIs. Do not apply it to unrelated TypeScript or React work merely because the
application happens to contain a Doxum runtime.

## Read the right reference

- Start with [the English guide](references/guide.en.md) for English requests
  or [中文指南](references/guide.zh-CN.md) for Chinese requests. They are
  equivalent task-oriented introductions.
- Read [the English patterns](references/patterns.en.md) or
  [中文模式参考](references/patterns.zh-CN.md) when implementing schema models,
  transactions, replay, selectors, views, or React code.
- Read [the English invariants](references/invariants.en.md) or
  [中文不变量](references/invariants.zh-CN.md) before changing mutation,
  addressing, impact, notification, history, tree, or derived-view behavior.

## Required Doxum decisions

- Treat `createDocument` as the only write authority for canonical document
  state. Application writes use `runtime.update`; replayed external operations
  use `runtime.apply`.
- A transaction is synchronous and atomic. Do not retain a transaction reader
  or writer after its callback returns, and do not introduce another writable
  state cache.
- Use the runtime's schema selectors, anchors, addresses, and `target` APIs.
  Do not add local path parsers, duplicate impact-target helpers, or manually
  synchronize derived data.
- Handle expected mutation failure from the returned `rejected` result and its
  `MutationIssue` values. Use `tx.report` or `tx.reject` with
  `DocumentDiagnostic` for application validation. A thrown callback error
  rolls back and is rethrown.
- A committed result with `observerErrors` is still committed. Do not retry its
  write as if canonical state had been rolled back.
- Keep `core` framework-neutral. React code belongs behind `doxum/react` and
  must not make `core` import UI concepts.
- Doxum does not define persistence, synchronization, authorization, or
  conflict resolution. Keep those policies in the application boundary before
  `apply` or `replace`.

When public behavior or lifecycle semantics change, update the README and
architecture guide and add focused tests for rollback, inverse history, impact
or subscription behavior, and performance-sensitive collection or tree paths.
