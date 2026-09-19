# Doxum Public API Optimization Checklist

本文记录 `API_REFACTOR_PLAN.md` 完成后的第二轮公开 API 收口项。实施继续按 **breaking change** 处理：不保留 compatibility alias、deprecated overload、V2 API、bridge protocol 或双轨调用方式。

目标不是继续减少 API 数量，而是消除仍然存在的 ownership 重复、内部实现泄漏和参数协议不稳定，使最终 public model 尽量只保留稳定 capability。

## 1. 本轮范围

本轮只处理以下事项：

1. `ProjectionScope` 收敛为 lifecycle ownership capability。
2. `doxum/advanced` 与 root projection runtime 重新建立明确边界。
3. local-sync operational error contract 完整统一。
4. `ProjectionError` 收缩为稳定公共语义。
5. `derive.keyed` selector 参数顺序稳定化。
6. `ProjectionRuntime.batch` 改为 callback-first。
7. 收缩不必要的 root exports。
8. 收紧 `DocumentRuntime.apply` 中无意义的 option 组合。

### 明确不做

- **不修改任何 `replace` API。**
- **不修改 React `useHistory`。** 保留当前 API 与行为。
- 不重新设计 `TransactionResult` / `OperationResult`。
- 不修改 `history.group()` 生命周期模型。
- 不拆分 `observe()` 为多套 source API。
- 不增加 schema namespace、projection namespace 或 facade。
- 不新增第二套 keyed join / dynamic dependency protocol。

## 2. Breaking replacement 总表

| 当前 API / 问题                                                 | 最终状态                                                |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `scope.input / scope.derive / scope.incremental`                | 删除，统一为 `scope.own(...)`                           |
| root `ProjectionRuntime` import advanced incremental            | 删除；advanced 保持独立 package boundary                |
| `LocalSyncState.error: unknown`                                 | `LocalSyncError`                                        |
| `AttachLocalSyncOptions.onError(error: unknown)`                | 只接收 local-sync operational `LocalSyncError`          |
| local-sync listener callback failure 混入 operational `onError` | 删除该混用；listener failure 不改变 sync fault contract |
| `ProjectionError.identity / revisions`                          | 移出 public contract，保留 Runtime 内部 diagnostics     |
| `derive.keyed(..., (value, deps, key) => ...)`                  | `(value, key, deps) => ...`                             |
| `runtime.batch(options, run)`                                   | `runtime.batch(run, options?)`                          |
| root 导出 processor-facing `CollectionChange`                   | 默认从 root 删除，只由 `doxum/advanced` 暴露            |
| `apply({ source: 'remote', history: ... })` 可表达无效组合      | 用 discriminated options 从类型层禁止                   |

## 3. ProjectionScope：只表达 ownership

### 当前问题

`ProjectionScope` 当前复制：

```ts
scope.input(...)
scope.input.collection(...)
scope.derive(...)
scope.derive.keyed(...)
scope.incremental(...)
scope.incremental.collection(...)
scope.incremental.group(...)
```

这些 API 的共同语义只有一个：**把 lazy projection definition 绑定到当前 scope 生命周期。**

当前实现内部已经存在同一 ownership primitive，但公开 API 把它展开成三套 factory。这样带来两个问题：

- scope 每增加一种 projection definition family 都要同步新增 wrapper；
- root projection runtime 必须直接依赖 advanced incremental，削弱 `doxum/advanced` 边界。

### 最终 API

```ts
const scope = runtime.scope();

const filter = scope.own(input<'all' | 'open'>('all'));

const visible = scope.own(
  derive({ rows, filter }, ({ rows, filter }) => projectRows(rows, filter))
);

const render = scope.own(
  incremental.group(
    { rows },
    {
      output: define => ({
        cards: define.collection<RowId, Card>(),
        count: define.value<number>(),
      }),
      process({ values, output }) {
        // ...
      },
    }
  )
);
```

`scope.own(...)` 必须支持：

- 单个 `Projection<T>`；
- `Input<T>`；
- `CollectionInput<K,V>`；
- `derive.keyed` 返回的 keyed projection；
- `incremental.group` 返回的静态 nested projection tree。

### Ownership 规则

- `scope.own` 只负责 lifecycle ownership，不复制或 materialize projection state。
- 一个 definition 只能属于一个 scope。
- root definition 可以被多个 Runtime materialize；owned definition 只能由 owning scope 使用。
- scoped definition 可以依赖 root definition。
- root definition 不允许依赖 scoped definition。
- 一个 scope 不允许依赖另一个 scope 的 definition。
- scope dispose 一次释放其 materialized producers 和 subscriptions。

### 删除

删除：

```text
scope.input
scope.input.collection
scope.derive
scope.derive.keyed
scope.incremental
scope.incremental.collection
scope.incremental.group
```

同时删除为了这些 wrappers 存在的 `Reflect.apply` forwarding 与 scoped factory plumbing。

### Package 边界

完成后：

- `core/src/projection/runtime.ts` 不再 import `./advanced`；
- root `doxum` 不通过 `ProjectionScope` 间接暴露 advanced API；
- `doxum/advanced` 只负责创建 advanced definitions；
- Runtime/Scope 只认识统一的 opaque `Projection` ownership protocol。

## 4. Local Sync：error contract 真正闭合

### 当前问题

虽然已经收敛成一个 `LocalSyncError` class，但两个公开边界仍使用 `unknown`：

```ts
LocalSyncState.error;
AttachLocalSyncOptions.onError;
```

因此调用者仍无法依赖 `LocalSyncError.code` 完成完整错误处理。

此外，local-sync state listener 抛出的异常当前也会进入 `onError`，把 consumer callback failure 与 persistence/synchronization failure 混为一个协议。

### 最终 API

```ts
type LocalSyncState =
  | {
      status: 'leader' | 'follower';
      headSeq: number;
      checkpointSeq: number;
    }
  | {
      status: 'error';
      headSeq: number;
      checkpointSeq: number;
      error: LocalSyncError;
    }
  | {
      status: 'disposed';
    };

type AttachLocalSyncOptions<S> = {
  // ...
  onError?: (error: LocalSyncError) => void;
};
```

### Boundary 规则

- IndexedDB、Web Locks、BroadcastChannel、timeline、serialization、runtime attachment 等 operational failure 必须在 local-sync boundary 转成 `LocalSyncError`。
- 原始异常保存在 `cause`。
- 已经是 `LocalSyncError` 时保持 identity，不重复包装。
- consumer listener failure 不写入 `LocalSyncState.error`，也不传给 operational `onError`。
- `LocalSyncErrorCode` 保持唯一分类轴，不重新引入 error subclasses。

## 5. ProjectionError：删除 scheduler diagnostics 泄漏

### 当前问题

当前公开 `ProjectionError` 暴露：

```ts
identity: string
revisions: readonly number[]
```

两者都由 scheduler / producer topology 决定，不是稳定应用语义。依赖顺序、producer 命名或 scheduler 实现变化都可能迫使 public contract 跟着变化。

### 最终 public model

```ts
class ProjectionError extends Error {
  readonly phase: 'source' | 'processor' | 'listener' | 'blocked';
  readonly cause: unknown;
}
```

允许 Runtime 内部继续维护：

- producer identity；
- dependency revisions；
- output revisions；
- scheduler/debug metadata。

这些信息只能作为内部 diagnostics，不形成 public type contract。

`ProjectionDisposedError` 保留。

## 6. derive.keyed：selector 基础参数位置必须稳定

### 当前问题

无 dependency：

```ts
derive.keyed(rows, (row, rowId) => ...)
```

增加 dependencies 后：

```ts
derive.keyed(rows, deps, (row, deps, rowId) => ...)
```

加入一个新 capability 会改变原有 `rowId` 的位置，不利于 API 演进和阅读。

### 最终 API

```ts
derive.keyed(rows, (row, rowId) => project(rowId, row));

derive.keyed(
  rows,
  {
    entity: { source: entities, key: row => row.entityId },
    mode,
  },
  (row, rowId, { entity, mode }) => project(rowId, row, entity, mode)
);
```

固定规则：

```text
(value, key)
(value, key, dependencies)
```

`{ source, key }` dynamic keyed dependency shape 保持不变，不增加 `join()`、`lookup()` 或新的 dependency helper namespace。

## 7. ProjectionRuntime.batch：callback-first

### 当前问题

当前：

```ts
runtime.batch(run);
runtime.batch({ cause }, run);
```

而 document mutation 是：

```ts
document.update(run, options?);
```

同类“同步 callback + optional policy”的参数顺序不一致。

### 最终 API

```ts
runtime.batch(run);
runtime.batch(run, { cause });
```

公开类型收敛为一个签名：

```ts
batch<T>(
  run: () => T,
  options?: { readonly cause?: unknown }
): T;
```

`ProjectionScope.batch` 直接复用同一 contract。

## 8. Root exports 收缩

### CollectionChange

`CollectionChange<K,V>` 是 processor-facing incremental transport contract。普通 root projection consumer 不直接处理它；root 对它的导出主要来自 `CollectionInput` / keyed projection 内部 metadata。

最终：

- 从 `doxum` root 删除 `CollectionChange` export；
- `doxum/advanced` 继续公开 `CollectionChange`，供自定义 advanced processor 函数签名使用；
- `Projection<T>`、`CollectionInput<K,V>` 继续隐藏 change metadata。

### 保留的 root types

以下仍属于稳定 root capability，继续保留：

- `Projection<T>` / `Input<T>` / `CollectionInput<K,V>`；
- `Readable<T>`；
- document ChangeSet / impact / result types；
- external source/event contracts，因为 `observe(externalSource)` 是 root source-boundary capability。

## 9. DocumentRuntime.apply：禁止无意义 option 组合

### 当前问题

当前 options 可以表达：

```ts
{
  source: 'remote',
  history: true,
}
```

但 remote commit 的既定语义是 invalidate local history，因此这个组合没有真实含义。

### 最终类型

将 `apply` options 改为 discriminated union，使 remote source 不存在 history policy：

```ts
type ApplyOptions =
  | {
      expectedRevision: number;
      source?: 'local' | 'system';
      history?: boolean;
    }
  | {
      expectedRevision: number;
      source: 'remote';
    };
```

保持 invariant：

- local/system commit 是否进入 history 由 `history` 控制；
- remote commit 总是 invalidate local history；
- `history` 不再能表达与 source semantics 冲突的组合。

不要顺势创建通用 `MutationOptions`。`update`、`apply`、whole-document `replace` 的 source 权限不同，强行共享一个 options type 会重新引入无效状态。

## 10. React：本轮保持现状

明确保留：

```ts
useHistory(history);
```

本轮不改它的返回形态，不要求调用者改成 `useReadable(history)`，也不增加新的 history React hook。

其他 React API 继续保持：

```ts
ProjectionProvider;
useProjection;
useInput;
useDocumentSelector;
useReadable;
useHistory;
```

如果 `ProjectionScope` 改为 `scope.own`，React adapter 只消费最终 `ProjectionRuntime | ProjectionScope` capability，不增加 scope-specific hook。

## 11. 明确保留的 API 模型

本轮审计后以下设计继续保留：

### Document 与 Projection Runtime 分离

`DocumentRuntime` 继续拥有 canonical document；`ProjectionRuntime` 继续拥有 derived/UI state。两者不合并。

### TransactionResult / OperationResult 分离

`TransactionResult` 承载 update callback value 与 application rejection；`OperationResult` 表达无 callback operation。不要为了减少一个类型而引入 conditional generic。

### history.group()

它允许跨多个独立 `document.update()` 保持一个用户级 history lifetime，是真实 capability，不改成只能覆盖同步 callback 的 helper。

### observe()

继续作为统一 Projection source boundary：document、`Readable`、external value/collection source 都通过同一个概念接入 Projection graph。

### Schema builders

继续保留：

```text
field / optional / object / variant / map / table / list / tree
```

不新增 `schema.*` namespace，不改成统一 definition object。

### replace

所有现有 `replace` API 保持不动。

## 12. Change-surface ledger

| Addition / change                      | Role / owner                         | Replaces or deletes                       | Required consumers                              |
| -------------------------------------- | ------------------------------------ | ----------------------------------------- | ----------------------------------------------- |
| `scope.own`                            | Projection scope lifecycle ownership | scoped input/derive/incremental factories | Core, tests, docs, skills                       |
| typed local-sync failure normalization | local-sync boundary                  | `unknown` operational errors              | local-sync state/options/tests/docs             |
| slim `ProjectionError`                 | projection public error boundary     | public scheduler diagnostics              | scheduler/source/runtime/tests/docs             |
| keyed selector argument order          | keyed derive call protocol           | old `(value,deps,key)` form               | tests/docs/skills/consumers                     |
| callback-first `batch`                 | ProjectionRuntime action protocol    | options-first overload                    | Runtime/scope/tests/docs/React consumers if any |
| discriminated `ApplyOptions`           | document mutation policy             | invalid source/history combinations       | runtime/local-sync/tests/docs                   |

本轮原则上不新增其他 permanent public concept。

## 13. 实施顺序

### Phase 1 — Scope ownership spine

- 增加最终 `scope.own` type contract。
- 支持单 Projection 与静态 nested projection tree。
- 所有 scope tests/consumers 切到 `scope.own(...)`。
- 删除 scoped input/derive/incremental wrappers。
- 删除 core runtime 对 advanced 的 import。

### Phase 2 — Projection call surface

- `derive.keyed` 改 `(value, key, dependencies)`。
- `batch` 改 callback-first。
- 更新 Runtime 和 Scope 类型。
- 删除旧 overload，不保留兼容分支。

### Phase 3 — Error boundaries

- 收缩 `ProjectionError`。
- local-sync 所有 operational failure 归一成 `LocalSyncError`。
- state/onError 类型改为 `LocalSyncError`。
- consumer listener failure 移出 local-sync operational error channel。

### Phase 4 — Document policy typing

- 引入最终 `ApplyOptions` discriminated union，是否 export 取决于外部是否确实需要独立标注。
- local-sync remote apply 调用切到最终 contract。
- 添加类型级测试禁止 remote + history。

### Phase 5 — Export / docs / skills cleanup

- root 删除 `CollectionChange` export。
- advanced 保留该 type。
- README、architecture、projection docs、skills 全部更新。
- public surface guard 增加旧 scope factories、旧 keyed selector 示例、旧 batch order 和 root `CollectionChange` 的回归检查。

## 14. Structural invariants

实施过程中必须保持：

1. `createDocument` 仍是 canonical document state 唯一写 owner。
2. `ProjectionRuntime` 仍是 materialized projection state、graph、recovery、batching 的唯一 owner。
3. `scope.own` 只赋予 lifecycle ownership，不创建第二份 state 或 graph。
4. advanced processor dependency graph 仍静态显式。
5. dynamic keyed dependency reverse index 仍由 materialized processor / Runtime 拥有。
6. local-sync 仍只通过 DocumentRuntime 受控 mutation boundary 写 canonical state。
7. React 只适配 Core capability，不定义第二套 ownership 或 mutation model。
8. 所有 `replace` behavior 保持不变。
9. `useHistory` 保持不变。

## 15. 完成标准

只有全部满足才算完成：

- `ProjectionScope` public surface 中不存在 `input / derive / incremental` factories，只保留 `own` 与 Runtime-like lifecycle/read/update capability。
- `core/src/projection/runtime.ts` 不再 import advanced incremental。
- `scope.own` 对 scalar/keyed/group tree 都有 lifecycle、cross-scope、dispose 测试。
- `derive.keyed` 所有形式都保持 `(value, key, dependencies?)` 基础参数稳定。
- `runtime.batch` 与 `scope.batch` 均只接受 callback-first contract。
- `LocalSyncState.error` 与 `onError` 使用 `LocalSyncError`；operational path 不再泄漏任意 `unknown` error。
- `ProjectionError` public declaration 不含 producer identity、revision arrays 或 scheduler topology。
- root `doxum` 不再导出 `CollectionChange`；`doxum/advanced` 仍可用于 processor typing。
- TypeScript 无法表达 `apply(..., { source: 'remote', history: ... })`。
- `useHistory` public declaration 与行为保持不变。
- 所有 `replace` API 与行为保持不变。
- README、docs、skills、tests、bench 只出现最终 API。
- repo-wide search 不存在 compatibility alias、legacy overload、旧 scoped factory 或旧 batch order。
- `pnpm run check`、`pnpm run build`、`pnpm run profile`、`git diff --check` 全部通过。

完成这轮后，公开模型应基本稳定在以下核心 capability：

```text
Schema
Document / ReadonlyDocument
Readable
Projection / Input
ProjectionRuntime / Scope ownership
History / ChangeSet / Impact
Advanced processor
Local Sync boundary
React adapter
```

后续除非出现新的真实产品 capability，不再为了进一步减少名字而继续重构 public API。
