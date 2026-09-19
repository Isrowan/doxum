# 公开 API 参考

这份文档用于快速查公开 API。guide / patterns 负责设计选择，projection reference 负责增量语义。

## 包入口

| 包                 | 用途                                                        |
| ------------------ | ----------------------------------------------------------- |
| `doxum`            | schema、document runtime、读取、history、impact、projection |
| `doxum/advanced`   | retained-state 与多输出 projection processor                |
| `doxum/react`      | React 适配                                                  |
| `doxum/local-sync` | 浏览器本地持久化与 leader/follower 协调                     |

## `doxum`

### Schema

| API                       | 契约                                             |
| ------------------------- | ------------------------------------------------ |
| `field<T>(validator?)`    | 原子 payload，整体替换。                         |
| `optional(node)`          | field / variant / map / list / tree 成员可缺失。 |
| `object(shape)`           | 固定声明成员，拒绝额外 own properties。          |
| `variant(tag, variants)`  | tagged union；切分支整体替换 variant。           |
| `map(value, { key }?)`    | 动态 keyed record。                              |
| `table(entity, { key }?)` | 有序 keyed entity，数据为 `{ ids, byId }`。      |
| `list(field, { keyOf })`  | 由 `keyOf` 提供稳定字符串身份的有序数组。        |
| `tree(field)`             | 可空、单根、父子双向一致的树。                   |

常用 schema 类型：`Infer`、`ReadonlyValue`、`Validator`、`SchemaPath`、
`PathValueOf`、`DocumentAnchor`、`DocumentTreeNode`、`DocumentTreeValue` 以及导出的
各种 `*Node`。`parse(schema, input)` 校验并返回普通 `Infer` 数据；field payload 按
readonly 合约共享引用。

集合 Draft：

| 容器  | 读取                                         | 写入                                                                          |
| ----- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| map   | `get`, `has`, `ids`                          | `put`, `remove`, `replace(next)`                                              |
| table | `get`, `has`, `ids`                          | `create`, `remove`, `move`, `reorder`, `replace(id, value)`, `replace(next)`  |
| list  | `get`, `has`, `ids`                          | `insert`, `remove`, `move`, `reorder`, `replace(key, value)`, `replace(next)` |
| tree  | `rootId`, `get`, `has`, `parent`, `children` | `insert`, `move`, `remove`, `replace(id, value)`, `replace(next)`             |

顶层 `replace(parent, key, value)` 用普通 `Infer` 值整体替换 object/variant 成员，尤其适合
成员 Draft 内含集合方法的情况。`document.replace(...)` 则是整份文档 reset。

### Document Runtime

```ts
const document = createDocument({ schema, initial, history: { capacity: 100 } });
```

`DocumentRuntime` 暴露：

- `revision()`、`snapshot()`；
- `update(run, { source?, history? }?)`：同步原子 Draft 事务；
- `apply(changes, { expectedRevision, source?, history? })`；
- `replace(value, { source? }?)`：整份文档 reset；
- `subscribe(listener)` 或 `subscribe(path | paths, listener)`；
- `history.undo()`、`redo()`、`clear()`、`group()`；
- `dispose()`。

`update` 返回 `TransactionResult`；`apply`、整文档 `replace`、history travel、group cancel
返回 `OperationResult`。都应处理 `committed | unchanged | rejected`。
`TransactionRejected` 用于 update 内预期业务拒绝；普通异常回滚后原样抛出。

文档/runtime 错误包括 `TransactionRejected`、`DocumentReentrancyError`、
`DocumentDisposedError`；解析失败使用带 `ParseIssue[]` 的 `ParseError`。

History 分组：

```ts
const group = document.history.group();
// 多个本地 commit
group.end(); // 一个 undo 单元
// 或 group.cancel();
```

### Read 边界

| API                                     | 契约                                             |
| --------------------------------------- | ------------------------------------------------ |
| `read(document, selector)`              | 一次同步借用 `Read`。                            |
| `select(document, selector, equality?)` | 动态追踪实际读取，返回 `Readable<TResult>`。     |
| `snapshot(scopedValue)`                 | 把借用的 Read/Draft 值转为普通 readonly 数据。   |
| `asReadable(document)`                  | 把 `DocumentRuntime` 收窄成 `DocumentReadable`。 |

`Readable<T>` 统一只有 `current()`、`revision()`、`subscribe(listener)`。

Commit 暴露 `revision`、`source`、`changes`、`impact`。`DocumentImpact` 有
`affects(path => ...)` 与 `collection(path => collectionPath)`；collection impact 要么
`reset`，要么精确给出 `added`、`removed`、`updated`、`orderChanged`。公开边界类型包括
`ChangeSet`、`Change`、`MemberChange`、`DocumentCommit`、`DocumentImpact`、
`CollectionImpact`、`MutationIssue` 和结果类型。

### Projection

```ts
const mode = input('compact');
const overrides = input.collection<string, Override>();
const rows = observe(document, path => path.rows);
const count = derive([rows], rows => rows.size);
```

| API                                             | 契约                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| `input(initial, equality?)`                     | Runtime 本地可写 scalar。                           |
| `input.collection<K,V>(initial?)`               | Runtime 本地可写 keyed collection。                 |
| `observe(document)`                             | 整份文档 Projection。                               |
| `observe(document, path => ...)`                | schema-path scalar 或 keyed collection Projection。 |
| `observe(readable)`                             | 适配 Doxum `Readable`。                             |
| `observe(externalSource)`                       | 适配公开 external value/collection source 契约。    |
| `derive(dependencies, compute, equality?)`      | 纯 scalar / aggregate projection。                  |
| `derive.keyed(driver, select, equality?)`       | 保留 driver membership/order，逐 entry 映射。       |
| `derive.keyed(driver, deps, select, equality?)` | 命名依赖；selector 为 `(entry, deps, key)`。        |

dynamic keyed dependency 写成命名成员
`{ source: keyedProjection, key: (driverValue, driverKey) => sourceKey }`。source key 暂时
不存在时值为 `undefined`，binding 仍保留，后续添加该 key 会触发依赖输出。

`ProjectionRuntime` / `ProjectionScope` 都有 `get`、`readable`、scalar `set`、keyed
`update`、`batch`、`dispose`；Runtime 另外有 `scope()`。keyed `update` draft 有 `get`、
`has`、`set`、`remove`。Scope 另外拥有 scoped `input`、`derive`、`incremental`。
`createProjectionRuntime({ onError })` 报告 `ProjectionError`；已释放 scoped projection
相关访问会抛 `ProjectionDisposedError`。

外部 source 契约通过 `ExternalValueSource/Event` 与
`ExternalCollectionSource/Event/Read` 导出；Runtime 负责把 collection event 归一成
`CollectionChange`。

external value source 具有 `kind: 'value'`、`current()`、`revision()`、
`subscribe(listener)`；event 带 `value`、`revision` 和可选 `reset` / `cause`。
external collection source 使用 `kind: 'collection'`；`current()` 与 event 的 `previous`
read 都提供 `get`、`has`、`ids`，event 另外携带 `revision`、可选 `impact`、`cause`。
需要显式标注时可用 `KeyedDependency` 描述动态 `{ source, key }` 成员。

### 公开类型分组

- Schema：`DocumentAddress`、`DocumentAnchor`、`DocumentListConfig`、`DocumentNode`、
  各种 `*Node`、`Infer`、`ReadonlyValue`、`SchemaPath`、`PathValueOf`、`Validator`。
- Access/runtime：`Read`、`Draft`、`Readable`、`DocumentReadable`、`DocumentRuntime`、
  `DocumentSelector`、`CommitSource`、`DocumentCommit`、`HistoryState`、`LocalHistory`、
  `TransactionResult`、`OperationResult`、`ObserverError`、`Unsubscribe`。
- Change/diagnostic：`ChangeSet`、`Change`、`MemberChange`、`ValueTransition`、
  `DocumentImpact`、`CollectionImpact`、`DocumentDiagnostic`、`DocumentProblem`、
  `MutationIssue`、`MutationIssueCode`、`ParseIssue`。
- Projection：`Projection`、`Input`、`CollectionChange`、`ProjectionRuntime`、
  `ProjectionScope`、`KeyedDependency` 以及 external source/event 类型。

## `doxum/advanced`

只有 `derive` / `derive.keyed` 无法表达 retained state、跨 key index 或直接 keyed patch
时才使用 `incremental`。

### `incremental(dependencies, processor)`

生成单个 value projection。context：`sources`、与依赖一一对应的 `changes`、`previous`、
`reset`、`cause`、`state`。返回下一 value。

### `incremental.collection(dependencies, processor)`

额外提供单个 keyed output 的 `previous`、`next`、`output`。`previous` / `next` 有
`get`、`has`、`ids`；`output` 有 `set`、`remove`、`order`。

### `incremental.group(dependencies, defineOutputs, processor)`

```ts
const render = incremental.group(
  [scene],
  define => ({
    node: {
      shell: define.collection<NodeId, Shell>(),
      content: define.collection<NodeId, Content>(),
    },
    count: define.value<number>(),
  }),
  ({ sources, previous, next, outputs, state, reset, cause, changes }) => {
    // outputs.node.shell/content: set/remove/order
    // outputs.count: set(value)
  }
);
```

这里的 `define` 是 `incremental.group` 声明 callback 的参数，不是独立 import。它只提供：

- `define.value<T>(equality?)`：scalar output leaf；
- `define.collection<K extends string, V>(equality?)`：keyed collection output leaf。

声明必须同步返回非空静态 plain-object tree；每个已声明 leaf 必须恰好返回一次，descriptor
不能复用。返回对象保持同样形状，只是 leaf 都变成 `Projection`。

group processor 除公共 context 字段外还得到同形状的 `previous`、`next`、`outputs`。
value output draft 只有 `set(value)`；collection output draft 有 `set`、`remove`、`order`。
首次构建/恢复必须建立所有 value leaf，普通增量运行可以不写某个 value leaf。

公开类型包括 `Incremental*Context`、`Incremental*Processor`、
`IncrementalGroupDefine`、`IncrementalGroupOutputTree`、`GroupProjections`、
`CollectionChange`。

## `doxum/react`

| API                                                     | 契约                                            |
| ------------------------------------------------------- | ----------------------------------------------- |
| `ProjectionProvider`                                    | 提供 `ProjectionRuntime` 或 `ProjectionScope`。 |
| `useProjection(projection)`                             | 读取 Projection。                               |
| `useProjection(projection, selector, equality?)`        | 选择读取 Projection。                           |
| `useInput(input)`                                       | scalar input 的 `[value, setValue]`。           |
| `useDocumentSelector(document, selector, { isEqual? })` | Core `select` 的 React 适配。                   |
| `useReadable(readable)`                                 | 订阅任意 Doxum `Readable`。                     |
| `useHistory(history)`                                   | history state + `undo` / `redo`。               |

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

`LocalSync` 暴露 `state: Readable<LocalSyncState>`、`flush()`、异步 `dispose()`。state 为
`leader` / `follower` / `error` / `disposed`；活动状态含 `headSeq`、`checkpointSeq`。
附着期间只有 leader 可写，整文档 replace 与外部传入 remote apply 不支持。

`JsonChangeLimits` 有 `maxChanges`、`maxBytes`、`maxDepth`、`maxStringLength`；
`defaultJsonChangeLimits` 为 `{ maxChanges: 1000, maxBytes: 1_000_000, maxDepth: 64,
maxStringLength: 256_000 }`，`schemaVersion` 默认 `1`。限制只约束新的本地 commit，
durable replay 不会重新套用当前限制。环境必须提供 IndexedDB、Web Locks、
BroadcastChannel，持久化数据必须兼容 JSON。

公开错误：`LocalSyncUnavailableError`、`LocalSyncSchemaError`、
`LocalSyncConsistencyError`、`LocalSyncReadOnlyError`、
`LocalSyncUnsupportedOperationError`、`LocalSyncDisposedError`、`LocalSyncDataError`。
