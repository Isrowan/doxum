# Public API 参考

这里列出稳定的公开契约。Projection 生命周期和示例见 [Projection 参考](projections.zh-CN.md)，
建模选择见 [指南](guide.zh-CN.md)。

## Package 入口

| Package            | 用途                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `doxum`            | schema、canonical document runtime、读取、history、impact、projection |
| `doxum/advanced`   | retained state 与多输出 incremental processor                         |
| `doxum/react`      | Core capability 的 React adapter                                      |
| `doxum/local-sync` | IndexedDB 持久化与浏览器 leader/follower 协调                         |

## `doxum`

### Schema

| API                       | 契约                                                  |
| ------------------------- | ----------------------------------------------------- |
| `field<T>(validator?)`    | 原子 payload，整体替换；内部只读。                    |
| `optional(schema)`        | 让 field/variant/map/list/tree member 可缺省。        |
| `object(shape)`           | 固定声明 member；返回 opaque `ObjectSchema<T>`。      |
| `variant(tag, variants)`  | object branch 组成的 tagged union。                   |
| `map(value, { key }?)`    | 动态 keyed record。                                   |
| `table(entity, { key }?)` | 有序 object/variant entity，数据为 `{ ids, byId }`。  |
| `list(field, { keyOf })`  | 带稳定 string identity 的有序数组。                   |
| `tree(field)`             | 空或单根树；optional field 表示 node payload 可缺省。 |
| `parse(schema, input)`    | 校验 unknown 输入并复制 schema structure。            |

公开 schema 类型包括 `Schema<T>`、`ObjectSchema<T>`、`Infer<S>`、
`ReadonlyValue<T>`、`Validator<T>`、`SchemaPath<S>`、`PathValueOf<P>`、
`DocumentAnchor`、`DocumentListConfig<T>`、`DocumentTreeNode<T>`、
`DocumentTreeValue<T>`。具体 node representation 属于内部实现，不是公开契约。
`Schema` / `ObjectSchema` 是可跨 package 生成声明的 handle；下游 package 可以直接
export 推导出的 schema 常量，不需要应用层写 `ReturnType` 包装。

`Validator<T>` 只负责校验。函数 validator 是 predicate/assertion：返回 `true` 或
`undefined` 表示成功，返回 `false` 表示拒绝，assertion 也可以 throw。
Standard Schema 成功时必须按 identity 返回原输入；transform output 会被拒绝。
validator 必须同步且不能修改输入。

Draft collection 方法：

| Container | 读                                           | 写                                                                           |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| map       | `get`, `has`, `ids`                          | `put`, `remove`, `replace(next)`                                             |
| table     | `get`, `has`, `ids`                          | `create`, `remove`, `move`, `reorder`, `replace(id,value)`, `replace(next)`  |
| list      | `get`, `has`, `ids`                          | `insert`, `remove`, `move`, `reorder`, `replace(key,value)`, `replace(next)` |
| tree      | `rootId`, `get`, `has`, `parent`, `children` | `insert`, `move`, `remove`, `replace(id,value)`, `replace(next)`             |

`replace(parent, key, value)` 用 plain `Infer` 数据替换一个 object/variant member。
`document.replace(value)` 是 whole-document reset，是独立操作。

### Document runtime

```ts
const document = createDocument({ schema, initial, history: { capacity: 100 } });
```

`DocumentRuntime<S>` 提供：

- `schema`、`revision()`、`snapshot()`、`readonly()`；
- `update(run, { source?, history? }?)`：同步、原子的 Draft mutation；
- `apply(changes, { expectedRevision, source?: 'local' | 'system', history? })`；remote replay
  使用 `apply(changes, { expectedRevision, source: 'remote' })`；
- `replace(value, { source? }?)`：whole-document reset；
- `subscribe(listener)`、`subscribe(path | paths, listener)`；
- `history.undo()`、`redo()`、`clear()`、`group()`；
- `dispose()`。

`document.readonly()` 返回 `ReadonlyDocument<S>`，只保留 `revision()` 和
document commit/path subscription，用于显式去掉写 capability 的边界。

`update` 返回 `TransactionResult`；`apply`、whole-document `replace`、history travel
和 group cancel 返回 `OperationResult`。状态为 `committed`、`unchanged`、`rejected`。
应用层预期拒绝用 `TransactionRejected`；普通 throw 会 rollback 后原样抛出。

Document 错误为 `TransactionRejected`、`DocumentReentrancyError`、
`DocumentDisposedError`。parse 错误为 `ParseError`，并带 `ParseIssue`。

### 读取与订阅

| API                                     | 契约                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `read(document, selector)`              | 一次同步 borrowed `Read`。                              |
| `select(document, selector, equality?)` | 动态 read-tracked `Readable<TResult>`。                 |
| `snapshot(value)`                       | 把 borrowed schema structure 导出为稳定 readonly data。 |

`Readable<T>` 提供 `current()`、`revision()`、`subscribe(listener)`。
`select` 会随 selector 分支变化重绑依赖；`equality` 判定结果相等时不发布。

Commit 包含 `revision`、`source`、`changes`、`impact`。公开 change/impact 类型包括
`ChangeSet`、`Change`、`MemberChange`、`ValueTransition`、`DocumentCommit`、
`DocumentImpact`、`CollectionImpact`、`MutationIssue` 和结果/诊断类型。

### Projection

```ts
const mode = input<'all' | 'open'>('all');
const selection = input.collection<RowId, Selection>();
const rows = observe(document, path => path.rows);
const count = derive({ rows }, ({ rows }) => rows.size);
```

| API                                                     | 契约                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `input(initial, equality?)`                             | Runtime-local writable scalar `Input<T>`。                           |
| `input.collection<K,V>(initial?, equality?)`            | Runtime-local keyed `CollectionInput<K,V>`，equality 按 entry 比较。 |
| `observe(document)`                                     | whole-document Projection source。                                   |
| `observe(document, path => ...)`                        | schema-path scalar 或 keyed Projection source。                      |
| `observe(readable)`                                     | 接入 Doxum `Readable`。                                              |
| `observe(externalSource)`                               | 接入公开 external value/collection source contract。                 |
| `derive(dependencies, compute, equality?)`              | named dependencies 的 pure value Projection。                        |
| `derive.keyed(driver, select, equality?)`               | 保留 driver key/order，逐 entry projection。                         |
| `derive.keyed(driver, deps, select, equality?)`         | 带 named global/dynamic keyed dependencies 的 keyed projection。     |
| `derive.keyed.keys(source)`                             | 正式顺序的 key array；value-only update 不发布。                     |
| `derive.keyed.values(source)`                           | 按 keyed collection 正式顺序排列的 value array。                     |
| `derive.keyed.entries(source)`                          | 正式顺序的 readonly `[key, value]` tuple，未变化 tuple 保持引用。    |
| `derive.keyed.get(source, key, equality?)`              | 精确绑定当前 selected key 的 scalar lookup。                         |
| `derive.keyed.subset(source, orderedKeys)`              | membership/order 由 ordered keys 决定的 keyed subset。               |
| `derive.keyed.filter(source, predicate)`                | 保留 source value 与 source-relative order 的 keyed filter。         |
| `derive.keyed.filter(source, deps, predicate)`          | 使用标准 keyed dependency protocol 的 filter。                       |
| `derive.keyed.compact(source, select, equality?)`       | map entry，并省略 selected value 为 `undefined` 的 key。             |
| `derive.keyed.compact(source, deps, select, equality?)` | 使用标准 keyed dependencies 的 compact。                             |
| `derive.keyed.groupBy(source, selector)`                | group key → source keys 的 reverse index，成员遵循 source 正式顺序。 |
| `derive.keyed.groupBy(source, deps, selector)`          | 使用标准 keyed dependency protocol 的 reverse index。                |
| `derive.keyed.singleton(source, keyOf, equality?)`      | optional scalar → 0/1 keyed projection。                             |

动态 keyed dependency 写法为
`{ source: keyedProjection, key: (driverValue, driverKey) => sourceKey | undefined }`。
Runtime 拥有 output-key → source-key binding 和 reverse invalidation。这个 helper shape
在调用点自动推断，不暴露独立 public helper type。
plural lookup 使用
`{ source: keyedProjection, keys: (driverValue, driverKey) => readonly sourceKey[] }`。
返回数组必须有序且无重复；dependency value 是按该顺序包含当前存在 selected entry 的
readonly map。缺失 key 仍保留 reverse binding，后续 add 会使 dependent driver key 失效。
keyed selector 的前置参数固定：无额外 dependency 时为 `(value, key)`；存在 named
dependency object 时为 `(value, key, dependencies)`。

`ProjectionRuntime` 提供：

- `read(projection)`；
- `select(projection)`、`select(projection, selector, equality?)`；
- `items(keyedProjection)`：有序 keys + membership 生命周期稳定的逐 key Readable；
- `update(input, nextValue)`：写 scalar `Input<T>`；
- `update(collectionInput, draft => ...)`：写 `CollectionInput<K,V>`；
- `batch(run, { cause? }?)`；
- `scope()`；
- `dispose()`。

`input.collection` 的 draft callback 与逐 entry equality 都在本地状态正式安装前完成；
任一环节抛错时，已发布 collection 与下一次 draft 都保持更新前状态。

`CollectionInputDraft` 提供 `get`、`has`、`set`、`remove`。edit callback throw 时该次 edit
整体不应用。`ProjectionScope` 镜像 `read`、`select`、`items`、`update`、`batch`、`dispose`，
并增加 `own(projectionOrTree)`，统一拥有 scalar/keyed input、derive 与 advanced output
tree 的 lifecycle。同一个 definition 只能属于一个 scope，并且必须在该 definition
首次作为 root materialize 之前调用 `own`。

公开 Projection 类型包括 `Projection<T>`、`KeyedProjection<K,V>`、`Input<T>`、
`CollectionInput<K,V>`、`CollectionInputDraft<K,V>`、`ProjectionRuntime`、
`ProjectionScope` 和 external source/event contract。所有 keyed producer 都返回
`KeyedProjection<K,V>`；`CollectionInput<K,V>` 是它的 Runtime-local writable 形式。
`ProjectionError` 只公开 `phase` 与 `cause`；
`ProjectionDisposedError` 表达 disposed access。

`filter` / `subset` 直接复用 source value，因此没有第二个 equality 参数。
`compact` 用 `undefined` 表达 membership 缺失；普通 `derive.keyed` 仍保留所有 driver key，
即使 selected value 本身为 `undefined`。

External value source 提供 `kind: 'value'`、`current()`、`revision()`、`subscribe()`。
External collection source 提供 `kind: 'collection'` 和 `get/has/ids` read，可给
`CollectionImpact` invalidation hint；adapter 会导出精确 `CollectionChange`。

## `doxum/advanced`

只有 retained state、cross-key index 或直接 incremental patch 无法用
`derive` / `derive.keyed` 清晰表达时才使用 advanced processor。

`collectionChange.keys(change)` 按 added → updated → removed 遍历 incremental
`CollectionChange` 的 entry-transition keys。它不解释 reset，也不会把 order change
扩展成所有 keys；调用前由业务代码先处理 `reset`。

所有 advanced API 都使用 named dependencies + closed definition object。

```ts
const total = incremental(
  { rows },
  {
    state: () => ({ runs: 0 }),
    process: ({ values, changes, previous, reset, cause, state }) => nextValue,
  }
);
```

`incremental.collection(dependencies, { process, state? })` 额外提供 keyed
`previous`、`next` 和 borrowed `output`；output 有 `set`、`remove`、`order`。只有确实
需要 retained state 时才声明 `state()`；无状态 process context 不包含 `state`。

`incremental.keyed(driver, dependencies, { process, state?, equality? })` 保留 driver
membership/order，并为每个当前 driver key 独立拥有 retained state。普通 dependency
变化使所有当前 driver key 失效；singular/plural keyed dependency 通过 reverse routing
只运行真正依赖的 key。driver 仅 order 变化不会执行 `process`。remove 释放该 key state，
同 key re-add 进入新的 membership lifecycle；reset intersection 保留 state，processor
fault recovery 会重建全部 per-key state。process context 包含 `key`、`value`、named
`dependencies`、`reset`、`cause` 和可选 `state`，返回当前 output key 的值，不暴露
collection draft。

`incremental.group(dependencies, { output, process, state? })` 声明多个 leaf：

```ts
const view = incremental.group(
  { rows },
  {
    output: define => ({
      cards: define.collection<RowId, Card>(),
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, changes, previous, next, output, reset, cause, state }) => {},
  }
);
```

`define.collection<K,V>(equality?)`、`define.value<T>(equality?)` 只存在于
`output` callback 内。返回值必须是非空静态 object tree，每个 descriptor 恰好返回一次；
最终同 shape 的 collection leaf 是 `KeyedProjection<K,V>`，value leaf 是
`Projection<T>`。

普通 source reset 保留已声明的 retained state。processor fault 的 recovery 由 Runtime
拥有：重新创建已声明的 state，再执行 reset evaluation；stateless processor 走同一恢复
路径但没有 state object。没有公开 rebuild token 或手工恢复协议。

advanced 导出 `collectionChange`、value/collection/keyed/group 的 context/definition 类型、`CollectionChange`，
以及声明可移植性所需的 `IncrementalGroupOutput` / `IncrementalGroupResult` 类型边界。
普通调用方通常只依赖推导；scheduler/output runtime plumbing 不属于公开 API。

## `doxum/react`

| API                                                  | 契约                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `ProjectionProvider`                                 | 提供 `ProjectionRuntime` 或 `ProjectionScope`。               |
| `useProjection(projection)`                          | 读取 Projection。                                             |
| `useProjection(projection, selector, equality?)`     | selector 形式读取 Projection。                                |
| `useInput(input)`                                    | scalar `[value,setValue]` 或 collection `[map,updateDraft]`。 |
| `useDocumentSelector(document, selector, equality?)` | Core document `select` 的 React adapter。                     |
| `useReadable(readable)`                              | 订阅任意 Doxum `Readable`。                                   |
| `useHistory(history)`                                | history state + `undo` / `redo`。                             |

## `doxum/local-sync`

```ts
const sync = await attachLocalSync({
  runtime: document,
  database: 'app',
  documentId: 'doc:1',
  schemaVersion: 1,
  changeLimits,
  onError,
});
```

`LocalSync` 提供 `state: Readable<LocalSyncState>`、`flush()`、async `dispose()`。
attached 时只有 leader 可写；whole-document replace 和外部 remote apply 不支持。

`LocalSyncError` 是唯一公开 operational error class。`code` 取值：
`unavailable`、`schema-mismatch`、`consistency`、`read-only`、
`unsupported-operation`、`disposed`、`invalid-data`。
`LocalSyncState` 的 error state 持有 `LocalSyncError`，`onError` 也只接收同一
operational error contract；consumer state-listener exception 不进入 sync fault state
或 `onError`。

`JsonChangeLimits` 包含 `maxChanges`、`maxBytes`、`maxDepth`、`maxStringLength`。
`defaultJsonChangeLimits` 提供默认值。limits 只限制新 local commit；更小的新 limit
不会阻止读取已经持久化的 durable replay。
