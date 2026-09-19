# Doxum Public API Refactor Plan

本文定义 Doxum 下一轮公开 API 的目标状态。实施时按 **breaking change** 处理，不保留兼容层、deprecated alias、旧 overload 或双协议过渡。

目标不是减少函数数量本身，而是让每个公开概念只有一个稳定含义、一个 owner 和一套调用协议；应用层应能仅凭公开类型和文档完成常规开发，不需要理解 Runtime 内部的 processor、change metadata、recovery signal 或 schema representation。

## 1. 最终目标

重构后的公开 API 保持四个明确边界：

- `doxum`：schema、canonical document runtime、read/select、history/impact、普通 projection 与正式 UI state input。
- `doxum/advanced`：只有普通 derive 无法表达时才使用的 retained-state / cross-key / multi-output processor。
- `doxum/react`：只做 Core capability 的 React 适配，不定义第二套状态或依赖模型。
- `doxum/local-sync`：浏览器本地持久化与 leader/follower 协调，保持独立 adapter 边界。

必须长期保持两个不同 owner：

- `DocumentRuntime` 唯一拥有 canonical document state、revision、mutation、history 和 document notification。
- `ProjectionRuntime` 唯一拥有 materialized derived state、UI inputs、processor graph、projection batching、scope 和 projection notification。

不合并这两个 Runtime。它们拥有不同事实和生命周期，强行合并只会模糊写权限与 derived-state ownership。

### 本轮明确不做

- **不修改现有 `replace` API 体系。** `document.replace`、collection `replace(...)`、顶层 `replace(parent, key, value)` 均不在本轮重构范围。
- 不增加 schema/projection facade namespace 来包装已有函数。
- 不增加兼容 API、V2 名称、bridge、legacy overload 或 migration runtime。
- 不增加 processor-side `runtime.get()` 依赖追踪、第二套 join protocol 或 document path grammar。

## 2. Breaking replacement 总表

| 当前公开 API / 概念                            | 最终状态                                                      |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `Validator<T>` 的“返回 T”语义                  | 改成纯 validation contract；成功结果不得转换 canonical input  |
| tuple `derive([a, b], ...)`                    | 改成 named dependency object                                  |
| tuple `incremental*([a, b], ...)`              | 改成 named dependency object；`sources/changes` 按名字访问    |
| public processor `Rebuild`                     | 删除；recovery 完全由 `ProjectionRuntime` 拥有                |
| `state: Record<string, unknown>`               | 改成 processor definition 中声明的 typed state initializer    |
| `Projection<T, C>`                             | 收敛成 `Projection<T>`；change metadata 内部化                |
| `Input<T, C>`                                  | 拆成 `Input<T>` 与正式 `CollectionInput<K, V>`                |
| `DocumentReadable<S>`                          | 改成 `ReadonlyDocument<S>`                                    |
| `asReadable(document)`                         | 删除；由 `document.readonly()` 返回 capability-stripped alias |
| `runtime.get(projection)`                      | 改成 `runtime.read(projection)`                               |
| `runtime.readable(...)`                        | 改成 `runtime.select(...)`                                    |
| `runtime.set(input, value)`                    | 删除；统一并入 `runtime.update(...)`                          |
| React `DocumentSelectorOptions`                | 删除；equality 直接作为第三参数                               |
| scalar-only `useInput`                         | 增加 `CollectionInput` overload；不增加 `useCollectionInput`  |
| 多个 local-sync error subclasses               | 收敛成 `LocalSyncError` + `LocalSyncErrorCode`                |
| 大量 schema node implementation types          | 收敛成少量 opaque public schema types                         |
| `KeyedDependency` 等主要用于内部类型拼装的导出 | 默认删除，除非外部独立函数签名确实需要标注                    |

## 3. Validator：先修正类型与运行时语义一致性

这是优先级最高的 breaking change。

当前 `Validator<T>` 容易让 TypeScript 把 validator 的成功输出理解为 canonical value 类型，但 Runtime 实际保留原始 input，成功返回值不会成为存储值。允许 transform/coerce schema 会造成静态类型与真实 canonical value 不一致。

最终规则：

1. Mutation、`createDocument`、`parse` 的 schema validation 都是 **validation only**。
2. Validator 不拥有 transformation；转换必须发生在数据进入 Doxum 之前。
3. function validator 使用 assertion/predicate 语义，不再靠“返回一个 T”表达成功值。
4. Standard Schema 仅接受无转换语义的使用方式；成功结果不得替换原始 input。实现阶段应对成功 output 与 input 的一致性做明确约束，而不是继续默默忽略可能发生的 transform。
5. `field<T>()` 的 T 是 canonical payload 类型的唯一静态来源。为了 soundness，可以接受 function validator 场景需要更显式的 T 标注，不再用一个可能转换的返回值反推 canonical 类型。

目标形态示意：

```ts
const title = field<string>(assertString);
const count = field<number>(numberSchema);
```

最终 invariant：**validator 可以拒绝一个值，但不能定义另一个被写入 Doxum 的值。**

## 4. Projection dependencies：全部统一为 named object

`derive.keyed` 已经证明 named dependency object 更容易阅读、扩展和类型推断。普通 `derive` 与全部 `incremental.*` 应使用同一原则，删除 tuple + positional indexing 协议。

### 普通 derive

最终 API：

```ts
const visible = derive({ tasks, filter }, ({ tasks, filter }) => projectTasks(tasks, filter));
```

删除：

```ts
derive([tasks, filter], (tasks, filter) => ...)
```

### keyed derive

driver 继续单独保留，因为 driver 拥有 output membership 与 order，这是独立 domain meaning：

```ts
const labels = derive.keyed(rows, row => row.label);

const resolved = derive.keyed(
  links,
  {
    entity: { source: entities, key: link => link.entityId },
    mode,
  },
  (link, { entity, mode }, linkId) => projectLink(link, entity, mode, linkId)
);
```

这里继续保持：

- 普通 Projection dependency 变化时使 driver key set 失效。
- `{ source, key }` dependency 只使当前绑定对应 source key 的 output keys 失效。
- dependency graph 本身仍静态；动态的只是 output-key → source-key binding。
- missing source key 仍保留 binding。
- selector 不允许隐式 `runtime.get()` 建依赖。

### Advanced incremental

依赖同样具名：

```ts
incremental({ tasks, filter }, definition);
incremental.collection({ tasks, filter }, definition);
incremental.group({ scene, mode }, definition);
```

processor context 中使用同样 key set：

```ts
context.values.tasks;
context.values.filter;
context.changes.tasks;
context.changes.filter;
```

`changes.<name>` 对 value projection 为 `undefined`，对 keyed collection 为对应 `CollectionChange | undefined`。

删除所有 `sources[0]` / `changes[0]` 风格位置协议。`sources` 建议同时改名为 `values`，因为 processor 得到的是当前 dependency values，而不是 graph source internals。

## 5. Advanced processor：definition 化、typed state、Runtime-owned recovery

`doxum/advanced` 的目标不是最短调用形式，而是让复杂 processor 的 lifecycle 明确且类型可靠。

最终采用闭合的 processor definition object，而不是继续向 positional function 参数追加协议：

```ts
const total = incremental(
  { tasks },
  {
    state: () => ({ index: new Map<string, number>() }),
    process({ values, changes, previous, state, reset, cause }) {
      return computeTotal(values.tasks, changes.tasks, previous, state, reset, cause);
    },
  }
);
```

`process` 是唯一必需的 lifecycle callback。只有确实需要跨 evaluation retained state 时才声明
`state()`；无状态 processor 的 context 不暴露 `state` 字段。

collection：

```ts
const index = incremental.collection(
  { tasks },
  {
    state: () => ({/* typed retained state */}),
    process({ values, changes, previous, next, output, state, reset, cause }) {
      // output.set / remove / order
    },
  }
);
```

group：

```ts
const render = incremental.group(
  { scene, mode },
  {
    output: define => ({
      nodes: define.collection<NodeId, NodeRender>(),
      count: define.value<number>(),
    }),
    state: () => ({ cache: new Map<NodeId, CachedNode>() }),
    process({ values, changes, previous, next, output, state, reset, cause }) {
      // one processor, several outputs
    },
  }
);
```

### state lifecycle

- `state()` 是可选 capability；仅在 processor 需要 retained state 时声明。
- 声明后，`state()` 在 processor materialization 时调用一次。
- state 类型由 initializer 精确推断，不再公开 `Record<string, unknown>`。
- 普通 source reset 不隐式替换 state；processor 收到 `reset: true` 后根据当前 values 重新同步 retained state。
- fault recovery 由 Runtime 重新建立 processor lifecycle；应用 processor 不持有 recovery command。

### 删除 Rebuild public protocol

`Rebuild` 是 scheduler / Runtime recovery concern，不应出现在 public processor return type。

最终：

- value incremental 返回下一 value；
- collection/group processor 正常返回 `void`；
- initial build、source reset、fault recovery 的触发与重建由 Runtime 统一控制；
- 应用代码只消费 `reset` 与 current values，不构造 recovery token。

## 6. Projection 类型：公开只表达 value，change metadata 内部化

公开 `Projection<T, C>` 把 processor/change transport metadata 泄漏到了所有调用者。最终改为：

```ts
type Projection<T> = /* opaque */;
```

Runtime 内部继续知道 projection 是 value output 还是 keyed collection output，以及对应 change protocol，但这不成为每个公开 Projection 的第二泛型。

### Input 类型

`input.collection` 是正式 UI capability，因此不应再通过 `Input<ReadonlyMap<K,V>, CollectionChange<K,V>>` 间接表达。

最终公开两个不同 writable projection capability：

```ts
type Input<T> = Projection<T> & /* scalar input brand */;
type CollectionInput<K extends string, V> =
  Projection<ReadonlyMap<K, V>> & /* collection input brand */;
```

两者不是“同一个 Input 加一个 change 泛型”的两种参数化，而是写协议确实不同的两个 capability；但 Runtime 对外只需要一个统一的写动作：

```ts
runtime.update(modeInput, 'compact');

runtime.update(selectionInput, draft => {
  draft.set(rowId, nextSelection);
  draft.remove(oldRowId);
});
```

最终删除 `runtime.set`。`runtime.update` 根据第一个参数的 capability 选择协议：

- `Input<T>`：第二参数是完整 next value。
- `CollectionInput<K,V>`：第二参数是同步 draft callback。

这不是用 overload 保留两套竞争模型；`Input` 与 `CollectionInput` 本来就有不同的写能力，而 `update` 只是它们共同的 Runtime mutation verb。不要再增加 `write()`、`setCollection()` 等第三个命名。

### `input.collection` 作为正式 UI state

它用于 selection、expanded/collapsed state、local overrides、临时 keyed view state 等 Runtime-local UI/application state：

```ts
const selection = input.collection<RowId, SelectionState>();
```

正式语义：

- state 属于 `ProjectionRuntime`，不进入 document canonical state/history/persistence。
- 保留 exact keyed `CollectionChange`、key-level invalidation 和 batch coalescing。
- root input definition 可跨 Runtime 复用，每个 Runtime 有独立 materialized value。
- scoped `scope.input.collection` 属于 scope 生命周期，scope dispose 后释放。
- `input.collection(initial?, equality?)` 应支持 per-entry equality，默认 `Object.is`，避免 UI state 重复 set 产生无意义 updated transition。

不新增 `uiInput`、`store`、`atomFamily` 等平行概念；正式能力仍叫 `input.collection`。

## 7. Read-only document capability：修正命名

当前 `DocumentReadable<S>` 不是标准 `Readable<Infer<S>>`：它没有 `current()`，subscription 也是 document commit/path 语义。继续使用 `Readable` 命名会与真正的 `Readable<T>` 混淆。

最终改为：

```ts
type ReadonlyDocument<S> = {
  revision(): number;
  subscribe(...): Unsubscribe;
};
```

`DocumentRuntime<S>` 具有 read-only document capability，同时提供：

```ts
document.readonly(): ReadonlyDocument<S>
```

该方法返回 capability-stripped alias，用于需要明确去掉 write API 的边界。删除：

- `DocumentReadable`
- `asReadable(document)`

所有 Core consumer 改为接受 `ReadonlyDocument`：

- `read`
- `select`
- `observe(document, ...)`
- React `useDocumentSelector`
- 其它只读 adapter

标准 `Readable<T>` 保持不变：只有 `current()` / `revision()` / `subscribe()`。

## 8. 统一 read / select 词汇

建立一个全库稳定规则：

- `read`：同步读取当前值。
- `select`：创建一个随依赖变化的 `Readable`。
- `observe`：把外部/document/readable boundary 声明成 lazy Projection source。

Document 侧继续：

```ts
read(document, selector);
select(document, selector, equality?);
```

ProjectionRuntime 改为：

```ts
runtime.read(projection);
runtime.select(projection);
runtime.select(projection, selector, equality?);
```

删除：

- `runtime.get`
- `runtime.readable`

Scope 使用同一 API：

```ts
scope.read(projection);
scope.select(projection, selector?, equality?);
```

`runtime.scope()` 保持现状。虽然它创建一个需要 dispose 的 lifecycle owner，但这里 `scope` 已经是稳定且足够明确的 capability 名称，没有必要仅为强调“创建”再引入 `createScope`。

## 9. React：只适配最终 Core capability

React 不增加自己的状态模型。

### `useDocumentSelector`

删除独立的 `DocumentSelectorOptions`：

```ts
useDocumentSelector(document, selector, equality?)
```

与 Core `select(document, selector, equality?)` 保持相同参数语义。

### `useProjection`

保持：

```ts
useProjection(projection)
useProjection(projection, selector, equality?)
```

内部改为调用 owner 的最终 `select` API。

### `useInput`

`input.collection` 是正式 UI capability，所以同一个 hook 直接 overload，不增加 `useCollectionInput`：

```ts
const [mode, setMode] = useInput(modeInput);

const [selection, updateSelection] = useInput(selectionInput);
updateSelection(draft => {
  draft.set(rowId, nextSelection);
  draft.remove(oldRowId);
});
```

目标类型：

```ts
useInput<T>(input: Input<T>): readonly [T, (value: T) => void];

useInput<K extends string, V>(
  input: CollectionInput<K, V>
): readonly [
  ReadonlyMap<K, V>,
  (update: (draft: CollectionInputDraft<K, V>) => void) => void,
];
```

需要 key-level React render isolation 时继续使用 `useProjection(collectionInput, selector)`；`useInput(collectionInput)` 表示订阅整个 collection value。

`ProjectionProvider` 继续接受 `ProjectionRuntime | ProjectionScope`，因为 scope 是真实 lifecycle capability。

## 10. 收缩 schema 与 processor 的公开类型面

当前 root 暴露大量 `FieldNode` / `ObjectNode` / `VariantNode` / `MapNode` / `TableNode` 等 representation types。若 Doxum 不提供第三方自定义 schema node 扩展，这些结构类型不应成为长期外部 contract。

目标改为 opaque schema types：

```ts
type Schema<T> = /* opaque */;
type ObjectSchema<T extends object> = Schema<T> & /* root/entity capability */;
type Infer<S extends Schema<unknown>> = /* value of S */;
```

builder 继续保持当前函数式 API：

```ts
field<T>()
optional(schema)
object(shape)
variant(tag, variants)
map(value, options?)
table(entity, options?)
list(field, { keyOf })
tree(field)
```

是否可以传给 `table` / `map` / `optional` 等约束由 opaque capability brand 表达，不要求应用依赖 `.kind`、`.shape`、`.value` 等内部 representation。

保留真正属于业务边界的类型，例如：

- `Infer`
- `ReadonlyValue`
- `Validator`
- `DocumentAnchor`
- `DocumentTreeNode` / `DocumentTreeValue`
- `Schema` / `ObjectSchema`

`SchemaPath` / `PathValueOf` 仅在确实支持外部通用 path helper 的情况下保留；普通 path callback 应全部依赖推断。

### Projection / advanced 类型导出

同样遵循“能从调用点稳定推断就不公开 representation helper”：

- 删除 public `KeyedDependency`，除非独立 helper 函数的签名无法在不导出它的情况下表达。
- 删除 `IncrementalGroupDefine`、`IncrementalGroupOutputTree` 等 declaration plumbing 类型。
- `GroupProjections` 若只服务内部返回类型则不导出。
- 保留真正用于抽取独立 processor 函数的少量 context/processor type，并让它们与最终 named dependencies + typed state 对齐。
- external source/event types继续公开，因为它们是真实 adapter boundary。

## 11. Local Sync：统一错误协议

local-sync 当前公开多个 error subclass，调用者通常只需要判断错误类别并展示/恢复。长期改为一个错误 class：

```ts
type LocalSyncErrorCode =
  | 'unavailable'
  | 'schema-mismatch'
  | 'consistency'
  | 'read-only'
  | 'unsupported-operation'
  | 'disposed'
  | 'invalid-data';

class LocalSyncError extends Error {
  readonly code: LocalSyncErrorCode;
}
```

删除：

- `LocalSyncUnavailableError`
- `LocalSyncSchemaError`
- `LocalSyncConsistencyError`
- `LocalSyncReadOnlyError`
- `LocalSyncUnsupportedOperationError`
- `LocalSyncDisposedError`
- `LocalSyncDataError`

错误 message / cause 继续保留具体上下文；外部控制流只依赖稳定 `code`。

其它 local-sync API 保持当前 ownership：

- `attachLocalSync(...)`
- `LocalSync.state`
- `flush()`
- async `dispose()`
- leader/follower write admission
- JSON admission limits

不把 local-sync 方法塞进 `DocumentRuntime`。

## 12. 最终 public surface 草图

### `doxum`

主要 value API：

```ts
field;
optional;
object;
variant;
map;
table;
list;
tree;
parse;

createDocument;
read;
select;
snapshot;
replace;

input;
input.collection;
observe;
derive;
derive.keyed;
createProjectionRuntime;
```

主要 capability/type：

```ts
Schema<T>
ObjectSchema<T>
Infer<S>
ReadonlyValue<T>
Validator<T>

DocumentRuntime<S>
ReadonlyDocument<S>
Readable<T>

Projection<T>
Input<T>
CollectionInput<K, V>
ProjectionRuntime
ProjectionScope

ChangeSet / Change / DocumentCommit / DocumentImpact / CollectionImpact
TransactionResult / OperationResult / diagnostics
ExternalValueSource / ExternalCollectionSource and events
```

### `doxum/advanced`

```ts
incremental;
incremental.collection;
incremental.group;
```

只额外暴露少量真正用于独立 processor 函数签名的 context/type；Runtime/scheduler recovery representation 不出现在这个入口。

### `doxum/react`

```ts
ProjectionProvider;
useProjection;
useInput;
useDocumentSelector;
useReadable;
useHistory;
```

### `doxum/local-sync`

```ts
attachLocalSync;
defaultJsonChangeLimits;
LocalSyncError;
```

以及 `LocalSync`、`LocalSyncState`、`AttachLocalSyncOptions`、`JsonChangeLimits` 等真实 boundary types。

## 13. Change-surface ledger

| Addition                            | Role / owner                            | Lifecycle                  | Replaces / deletes                        |
| ----------------------------------- | --------------------------------------- | -------------------------- | ----------------------------------------- |
| `Schema<T>` / `ObjectSchema<T>`     | opaque schema boundary                  | definition lifetime        | exported schema node representation types |
| `CollectionInput<K,V>`              | Runtime-local keyed UI state capability | ProjectionRuntime / Scope  | `Input<T,C>` collection encoding          |
| typed incremental state initializer | advanced processor retained state       | one materialized processor | `Record<string, unknown>`                 |
| `ReadonlyDocument<S>`               | read-only canonical document capability | shared RuntimeContext      | `DocumentReadable<S>`                     |
| `document.readonly()`               | capability stripping boundary           | document lifetime          | `asReadable()`                            |
| `runtime.read/select`               | projection consumption protocol         | Runtime/Scope lifetime     | `get/readable`                            |
| `LocalSyncError` + code             | adapter error boundary                  | thrown error               | seven subclasses                          |

不新增其它长期概念。named dependency object、`input.collection`、`ProjectionScope`、`Readable<T>`、`CollectionChange` 均沿用现有 owner 并收敛语义。

## 14. 实施顺序

按最低层到上层一次性完成，不保留中间兼容状态。

### Phase 1 — Validator soundness

- 定义最终 validator contract。
- 修正 `field` / `parse` / mutation validation 的类型与 runtime enforcement。
- 更新 Standard Schema tests，明确拒绝 transformation 语义。
- 删除旧“validator return T == canonical T”的推断路径。

### Phase 2 — Opaque schema public types

- 建立 `Schema<T>` / `ObjectSchema<T>` public contract。
- 让 builder inference 不再要求应用看到内部 node shape。
- 更新 createDocument、Infer、path callbacks 和所有 public generics。
- 删除不再需要的 node representation exports。

### Phase 3 — Projection type spine

- `Projection<T,C>` → `Projection<T>`。
- scalar `Input<T>` 与 `CollectionInput<K,V>` 分开。
- change metadata 移入 internal projection definition/graph。
- `input.collection` 加正式 entry equality contract。
- 删除 `runtime.set`；`runtime.update` overload 覆盖 scalar next-value 与 collection draft 两种 writable input capability。

### Phase 4 — Named dependencies everywhere

- 普通 `derive` 改 named object。
- `incremental` / `.collection` / `.group` 同步改 named object。
- context `sources` → `values`；`changes` 改 named object。
- 删除全部 tuple dependency API、位置 indexing types 和 tests。

### Phase 5 — Advanced processor lifecycle

- incremental family 改 closed definition object。
- `process` 作为必需 callback；`state()` 仅在需要 retained state 时声明，并保持精确类型推断。
- public processor return type 删除 `Rebuild`。
- recovery 只留 Runtime-owned path。
- 收缩 advanced type exports。

### Phase 6 — Read-only document + read/select vocabulary

- `DocumentReadable` → `ReadonlyDocument`。
- `asReadable` → `document.readonly()`。
- `ProjectionRuntime.get/readable` → `read/select`。
- Core、projection source、React consumers 一次切到最终名称。

### Phase 7 — React formal UI input integration

- `useDocumentSelector` equality 参数与 Core 对齐。
- 删除 `DocumentSelectorOptions`。
- `useInput` 增加 `CollectionInput` overload。
- 验证 whole collection subscription 与 `useProjection(input, selector)` key-level tracking。

### Phase 8 — Local-sync + export cleanup

- 合并 local-sync error classes。
- 审计 root / advanced / react / local-sync 所有 exports。
- 删除不属于稳定外部边界的 helper/representation types。
- 更新 package declaration surface guard，禁止旧 symbols 再出现。

### Phase 9 — 全量 consumer 与文档切换

- README、docs、skills 只写最终 API。
- 测试和 bench 直接迁移，不保留 legacy fixtures。
- repo-wide search 删除所有旧调用、旧 symbol、old tuple dependencies 和 aliases。

## 15. Structural invariants

重构过程中以下规则不可破坏：

1. `createDocument` 仍是 canonical document state 唯一写 owner。
2. mutation 继续同步、原子、可完整 rollback；publication 保持在 rollback boundary 之外。
3. ChangeSet / impact / history 继续共用同一 canonical mutation facts。
4. schema resolution 仍是 document changes、subscription、impact、projection path 的唯一寻址真值。
5. Projection definitions 仍 lazy；`ProjectionRuntime` 是 materialized state、graph、recovery、dispose 的唯一 owner。
6. processor graph dependency 静态显式，不允许 processor 运行时隐式读 Runtime 建依赖。
7. `derive.keyed` 的 reverse binding index 继续由 Runtime/materialized processor 持有。
8. `input.collection` 是 derived/UI Runtime-local state，不成为第二份 canonical document。
9. scoped definitions 只能属于一个 scope；scope dispose 释放自己的 inputs/processors/subscriptions。
10. React 不定义状态 ownership，只适配 Core Readable / Projection / Input capability。
11. local-sync 不获得第二个 mutation protocol，只通过 document runtime 的受控写边界工作。
12. 本轮不改变现有 `replace` 体系。

## 16. 完成标准

只有全部满足时才算重构完成：

- root package 中不存在 `Projection<T,C>`、collection-as-`Input<T,C>`、`DocumentReadable`、`asReadable`、`runtime.get`、`runtime.readable`、`runtime.set` 的活动调用或 export；`runtime.scope()` 保留。
- 普通 derive 与 advanced incremental 中不存在 tuple dependency declaration 或 `sources[i]` / `changes[i]` 协议。
- public advanced processor type 中不存在 `Rebuild` 与 `Record<string, unknown>` retained state。
- `input.collection` 有独立 public type、entry equality、Runtime update 和 React `useInput` overload，并有 scope 生命周期测试。
- schema builder 的普通使用不需要导入内部 node representation types。
- validator 无法通过 transform/coerce 造成 canonical runtime value 与 TypeScript 类型不一致。
- local-sync 用户只需处理 `LocalSyncError.code`，旧 error subclasses 已删除。
- README、docs、skills、tests、bench 全部只使用最终 API。
- public declaration surface guard 覆盖四个 package entry points，并禁止旧 symbols 回归。
- `pnpm run check`、build、projection/profile regression checks 全部通过。
- repo-wide search 证明没有 legacy alias、compatibility branch、旧 overload 或平行协议残留。

最终应达到的使用体验是：应用开发者理解 **Document、Projection、Input、Readable、Scope** 这几个核心 capability 后，就可以完成绝大多数工作；复杂增量算法才进入 `doxum/advanced`，而 advanced 仍沿用同一套 named dependencies、Runtime ownership 与 recovery 规则。
