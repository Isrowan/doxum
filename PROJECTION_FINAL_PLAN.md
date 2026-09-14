# Projection 最终架构与实施方案

状态：最终设计草案（只描述目标态和实施顺序，不包含本次代码实现）

本文是对当前 Projection 链的最终收敛方案。目标不是给现有 API 增加一层包装，而是在不要求兼容的前提下，删除重复协议、收回运行时所有权，并同时满足两类使用者：

- React/普通业务用户：熟悉 `input → derive → useProjection` 的值、selector、setter 心智。
- 高级用户：仍然可以使用 retained state、keyed collection、before/after、changed keys、reverse index 和增量 processor。

方案遵循单一 owner、单一 mutation funnel、显式依赖和删除旧协议的原则。

## 1. Final Goal

最终公开模型只保留两个核心概念：

1. `Projection<T>`：惰性、不可变、可复用的派生定义。
2. `ProjectionRuntime`：唯一的 materialization、图执行、发布、订阅、输入写入和生命周期 owner。

构造和消费 Projection 的基础入口只有：

```text
input
observe
derive
runtime.get
runtime.subscribe
runtime.set
runtime.batch
runtime.dispose
```

增量 processor 是高级能力，但仍然产生同一种 `Projection<T>`，不引入 `ValueProjection`、`CollectionProjection` 或第二套 Runtime。

最终依赖链：

```text
Document / external owner / input
              ↓
           observe
              ↓
        Projection<T>
              ↓
           derive
              ↓
      ProjectionRuntime
              ↓
             T
```

Document 继续拥有 canonical state；Projection Runtime 只拥有 derived state、processor state、索引和订阅。

## 2. Global Scope and Breaking Replacements

不保留兼容层、别名、旧重载或内部桥接协议。所有生产者、消费者、测试、React adapter、文档和根导出一次性切到目标态。

### 2.1 基础 API

```text
input(initial, equality?)
observe(document, pathSelector)
derive(dependencies, compute)
```

`dependencies` 使用 tuple，而不是 `{ from, compute }` 配置对象：

```js
const filterInput = input('all');

const visibleTasks = derive([observe(document, path => path.tasks), filterInput], (tasks, filter) =>
  filterTasks(tasks, filter)
);
```

如果一个 source 会被多个 Projection 使用，可以命名：

```js
const tasks = observe(document, path => path.tasks);
const filterInput = input('all');

const visibleTasks = derive([tasks, filterInput], (tasks, filter) => filterTasks(tasks, filter));
```

`observe` 是 Projection 层拥有的边界函数，不让 `DocumentReadable` 反向依赖 Projection。它表达“从某个外部 owner 建立一个显式响应式依赖”，但不向调用者暴露 SourcePort 或 source record。

### 2.2 Runtime API

```text
runtime.get(projection)
runtime.subscribe(projection, listener)
runtime.set(input, value)
runtime.batch(options?, run)
runtime.dispose()
```

语义：

- `get` 返回当前已发布的 `T`。
- `subscribe` 默认只表达 invalidation，不携带 value/collection/document 多套事件参数。
- `set` 是 Runtime-local input 的唯一写入入口。
- `batch` 合并一次应用动作；只允许传 opaque `cause`，不公开 `ProjectionBatch`。
- `dispose` 释放整个 Runtime。

删除以下 Runtime 操作：

```text
collection
item
revision
rebuild
release
```

`rebuild`、revision、release 都是内部生命周期或 publication 事实，不是普通应用能力。

### 2.3 React API

React 根入口只保留：

```text
ProjectionProvider
useProjection(projection)
useProjection(projection, selector, equality?)
useInput(input)
```

示例：

```js
const tasks = useProjection(visibleTasks);

const task = useProjection(visibleTasks, tasks => tasks.get(taskId));

const [filter, setFilter] = useInput(filterInput);
```

不再要求应用使用 `useProjectionItem`、`useProjectionSelector`、`useProjectionSetter` 三套并行 hook。`useProjection` 的可选 selector 覆盖普通 value、collection、单个 item 和聚合选择。

### 2.4 高级入口

高级 retained-state 和 keyed incremental processor 从基础入口隔离到 `doxum/advanced`：

```text
incremental(dependencies, processor)
```

它仍返回普通 `Projection<T>`。高级入口可以暴露 `IncrementalContext`、`CollectionDraft` 和 `SourceChange`，但这些类型不进入默认根导出。

## 3. Representation Ledger

| 当前表示                                                                    | 当前 owner / 问题                                   | 目标表示                                                       | 动作                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `Projection`、`ValueProjection`、`CollectionProjection`、`CollectionSource` | 同一 derived definition 被拆成多种公共 hierarchy    | `Projection<T>`                                                | 保留一个公共类型，删除 kind 泛型和 collection/value 分叉        |
| `ProjectionRuntime` + `ProjectionEngine`                                    | 两个运行时协议重复拥有 factory、batch、dispose      | `ProjectionRuntime`                                            | 删除 `ProjectionEngine`，Runtime 成为唯一 owner                 |
| `project()` 十余个重载                                                      | 结构判断、属性存在性判断和 competing models         | `observe` + `derive(tuple, compute)`                           | 删除重载和运行时 shape dispatch                                 |
| `ProjectionValueSource` / `ProjectionCollectionSource`                      | 两套外部 source hierarchy                           | 内部 SourcePort adapter                                        | 保留内部边界，删除根导出                                        |
| `MaterializedValue` / `MaterializedCollection`                              | 同时是 value、source、readable、lifecycle handle    | `ProjectionRuntime` 内部 instance                              | 删除公共 materialized 类型                                      |
| `CollectionRead` / `CollectionReadable` / `CollectionInput`                 | snapshot、processor context、consumer view 混在一起 | public `ReadonlyMap`-like value + internal `CollectionContext` | 应用侧只见只读 keyed value；processor 侧拥有 context            |
| `EngineValueSpec` / `AdvancedValueSpec`                                     | 两套 value processor 定义                           | `incremental` processor                                        | 合并并移到 advanced 入口                                        |
| `EngineCollectionSpec` / `AdvancedCollectionSpec`                           | 两套 collection processor 定义                      | `incremental` processor + `CollectionDraft`                    | 合并，draft 只在 callback 内借用                                |
| `ProjectionRuntime.item` / `useProjectionItem`                              | item 生命周期泄漏为公共 Runtime API                 | selector dependency tracking                                   | Runtime 内部保留 keyed invalidation，React 只用 `useProjection` |
| `ProjectionRuntime.revision`                                                | 读取内部 publication metadata                       | 内部 revision                                                  | 删除主 API，debug-only 访问另行处理                             |
| `ProjectionRuntime.rebuild` / `release`                                     | 应用层介入内部生命周期                              | Runtime 内部 recovery / disposal                               | 删除公共 API                                                    |
| `ProjectionBatch`                                                           | batch identity 在多个事件类型中重复传播             | `cause` + 内部 batch identity                                  | 只保留 opaque cause，batch id 内部化                            |
| `select` 一次性文档读取                                                     | 与响应式 selection 语义冲突                         | `read`/snapshot 与 `observe` 分离                              | 不兼容重命名，避免同名双语义                                    |

## 4. Final Types and Ownership

### 4.1 Canonical

`createDocument` 继续是 canonical document state 的唯一写入 owner。

Projection 不得写入 document canonical state，也不得维护第二份 document。

### 4.2 Resolved

Projection 的 published value 是 Runtime 根据显式 source 和 processor 计算出的 resolved value：

- scalar value：普通不可变值。
- keyed value：对外呈现 `ReadonlyMap`-like 语义，内部可使用 branded immutable collection facade。
- selector result：React consumer boundary 的 resolved snapshot，不进入 canonical graph。

不公开 `MaterializedValue` 或 `MaterializedCollection`，避免 resolved value 带上 Runtime 生命周期方法。

### 4.3 Session

`CollectionDraft` 是 processor-local session：

- 只在 `incremental` callback 的同步生命周期内有效。
- 不能逃逸、持久化或被其他 processor 共享。
- Runtime 在 callback 结束后 seal、计算 before/after、生成 change 并发布。

### 4.4 Boundary

以下均为 boundary，不得成为公共 domain hierarchy：

- document source adapter
- readable/external adapter
- React `useSyncExternalStore` adapter
- cross-runtime bridge
- diagnostics/debug output

## 5. Final Basic API

### 5.1 `input`

`input(initial, equality?)` 返回 `Input<T>`，但 input 状态属于每个 Runtime。

```text
same Input definition + two Runtime
  -> two independent input values
```

应用只能通过对应 Runtime 的 `set` 或 React 的 `useInput` 修改它。

### 5.2 `observe`

`observe` 的职责仅限于从外部 owner 建立显式 dependency：

```text
observe(document, pathSelector)
```

它不负责 mapper、filter、derived calculation，也不返回可写对象。

外部 runtime/readable 的 adapter 放在 integration 入口；不把 `ProjectionValueSource` 和 `ProjectionCollectionSource` 导出到默认 API。

### 5.3 `derive`

基础 `derive` 只有一个语义：

```text
derive(tupleDependencies, synchronousCompute) -> Projection<T>
```

依赖必须显式列出。不能通过 processor 内部读取自动修改 graph dependency。

纯 collection map、selector、summary 和 UI-friendly derived value 都使用同一条路径。

## 6. Selector Incremental Semantics

`useProjection(projection, selector, equality?)` 是消费端 selector，不是新的 Projection processor。

### 6.1 Key-aware tracking

selector 在同步执行时记录其实际读取：

```js
useProjection(visibleTasks, tasks => tasks.get(taskId));
```

记录：

```text
visibleTasks / key = taskId
```

当 `visibleTasks` 发布 changed keys 时，Runtime/React adapter 做交集判断：

```text
changed keys = [anotherTaskId]
selector keys = [taskId]
交集为空 -> selector 不执行，React 不通知
```

如果 `taskId` 改变，selector 才重新执行；此时 equality 再判断结果是否真的改变。

### 6.2 依赖粒度

| selector 读取                    | 依赖粒度          | 无关 key 更新时        |
| -------------------------------- | ----------------- | ---------------------- |
| `tasks.get(id)`                  | 单 key            | 不执行 selector        |
| `tasks.get(a)` 和 `tasks.get(b)` | 两个 key          | 只有 a/b 改变时执行    |
| `tasks.keys()`                   | key/order 集合    | 结构或顺序改变时执行   |
| `tasks.values()` / 全量迭代      | 整个集合          | 任意相关成员变化时执行 |
| 不可分析的外部函数               | coarse projection | 退化为整体订阅         |

动态 key 的 selector 在每次相关执行后更新 dependency set。

### 6.3 equality 的职责

依赖追踪和 equality 解决不同问题：

- dependency tracking：避免无关 selector 执行。
- equality：selector 已经因为相关依赖改变而执行后，避免结果相同的 React 重渲染。

默认使用 `Object.is`。Collection 必须保持未变化成员的稳定引用；否则调用者会被迫使用深 equality，破坏增量语义。

### 6.4 追踪边界

selector tracking 只允许存在于 React/UI consumer boundary。它不能反向构建 Projection processor graph。

```text
Projection processor dependencies：显式
React selector dependencies：消费端可追踪
```

selector 必须同步、纯、不能把 borrowed reader 或 draft 逃逸到异步回调。

## 7. Advanced Incremental API

高级入口只解决普通 `derive` 无法高效完成的场景：

- retained state
- reverse index
- 多 source 协调
- 跨 key 输出
- keyed collection patch
- order 增量维护
- 大集合局部更新

概念形态：

```text
incremental(dependencies, processor)
```

processor context 包含：

```text
sources
previous
change
reset
cause
state
output（collection processor 的借用 draft）
```

`output` 支持有限的 session 操作：

```text
set(key, value)
remove(key)
order(ids)
replace(entries)
```

Runtime 负责：

1. 进入 processor session。
2. 提供 current/previous 和 source change。
3. 捕获 draft 操作。
4. 校验 order 和 key 覆盖关系。
5. 计算 added/removed/updated/orderChanged/transitions。
6. 一次性发布新的 immutable collection。
7. 按 keyed dependency 通知下游 selector。

高级 processor 不允许直接调用 `rebuild`。Source reset、fault 或 processor 无法增量处理时，由 Runtime 内部重新初始化。公共 API 不公开 `rebuild`。

## 8. Runtime and Error Semantics

Runtime 仍然拥有完整的 execute/rollback/seal/publish/notify 生命周期，但这些阶段不再形成第二套 Engine API。

硬性语义：

- batch 内 `previous` 是 batch 开始前状态，`current` 是最终状态。
- document commit、input 写入和 external source publication 进入同一 settlement 生命周期。
- processor 和 listener 通知期间禁止写入。
- processor failure 触发内部 fault/recovery；不能让应用层手动 rebuild。
- observer/listener failure 不回滚已经接受的 commit；通过统一 error reporter 返回。
- `cause` 是 opaque application metadata；batch identity 只在 Runtime 内部存在。

## 9. Findings and Lowest Correct Boundaries

### Finding A：ProjectionEngine 是重复 owner

Evidence： [core/src/projection/store.ts](/Users/realrong/doxum/core/src/projection/store.ts) 包装 [core/src/projection/runtime.ts](/Users/realrong/doxum/core/src/projection/runtime.ts)，两者都参与 factory、batch 和 dispose。

Domain fact：Projection materialization、执行和生命周期。

Lowest wrong boundary：Runtime owner 边界。

Final owner：`ProjectionRuntime`。

Deleted：`ProjectionEngine` 类型、factory API 和 debug bridge。

Replacement：Runtime 内部私有 executor，不形成第二套公共协议。

Invariant：一个 Runtime 只有一个 materialization owner 和一个 disposal owner。

### Finding B：`project` 重载是定义边界错误

Evidence： [core/src/projection/definition.ts](/Users/realrong/doxum/core/src/projection/definition.ts) 同时解析 document、readable、external source、map、value、advanced value、advanced collection。

Domain fact：Projection definition。

Lowest wrong boundary：definition normalization。

Final owner：definition module。

Deleted：结构猜测、属性存在性判断、competing overloads。

Replacement：`input`、`observe`、`derive(tuple, compute)` 和 advanced `incremental`。

Invariant：每个 definition 在构造时拥有明确的 discriminated kind；materialize 不再根据 incidental properties 猜类型。

### Finding C：Value/Collection source 协议重复

Evidence： [core/src/projection/contract.ts](/Users/realrong/doxum/core/src/projection/contract.ts) 同时定义 `ValueInput`、`CollectionInput`、`DocumentInput`、`DocumentCollectionInput`、`ProjectionValueSource` 和 `ProjectionCollectionSource`。

Domain fact：source publication 和 before/after metadata。

Lowest wrong boundary：source adapter boundary。

Final owner：内部 SourcePort/publication normalizer。

Deleted：默认入口中的 source hierarchy 和事件类型族。

Replacement：内部统一 publication envelope + typed detail。

Invariant：reset、previous、cause、batch 和 revision 只在一个 publication lifecycle 中传播。

### Finding D：Collection consumer API 暴露了 processor 生命周期

Evidence： [core/src/projection/collection.ts](/Users/realrong/doxum/core/src/projection/collection.ts) 同时维护 collection snapshot、item handles、ids/all listeners、transitions 和 writer。

Domain fact：keyed derived value。

Lowest wrong boundary：consumer view 与 processor session 的边界。

Final owner：Runtime 内部 collection state；应用侧只读取 immutable map-like value。

Deleted：`CollectionReadable`、`MaterializedCollection`、`runtime.item`。

Replacement：React selector tracking + advanced `CollectionDraft`。

Invariant：应用不能持有 writer、draft 或 Runtime lifecycle handle。

### Finding E：React selector 不应退化为全量订阅

Evidence：当前 [react/src/hooks.ts](/Users/realrong/doxum/react/src/hooks.ts) 的 `useProjection` 直接订阅整个 projection，而 `useDocumentSelector` 已经有 target tracking，`useProjectionItem` 又单独维护 item revision。

Domain fact：UI consumer 的 selector invalidation。

Lowest wrong boundary：React consumer subscription adapter。

Final owner：React adapter + Runtime keyed invalidation。

Deleted：`useProjectionItem` 与 core item handle 的并行路径。

Replacement：`useProjection(projection, selector, equality?)` 的 selector dependency tracking。

Invariant：无关 key 更新不执行 selector；相关依赖更新后 equality 只负责结果级过滤。

## 10. Change-Surface Ledger

| 文件/区域                                        | 目标变化                                                         | 删除项                                                                      | 必须更新的消费者                         |
| ------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `core/src/projection/contract.ts`                | 收敛为 Projection、Input、Runtime、internal publication/context  | Engine*、Materialized*、多套 Input/Source 类型                              | root exports、definition、runtime、tests |
| `core/src/projection/definition.ts`              | `input`、`observe`、`derive` tuple definition                    | `project` 重载、结构 dispatch、Projection kind hierarchy                    | docs、core tests、React usage            |
| `core/src/projection/store.ts`                   | 与 Runtime owner 合并或完全私有化                                | ProjectionEngine wrapper、get/collection/item/revision/rebuild/release 分叉 | root entry、integration、tests           |
| `core/src/projection/runtime.ts`                 | 成为唯一 Runtime owner                                           | Runtime → Engine forwarding                                                 | source、value、collection、React         |
| `core/src/projection/source.ts`                  | adapter 只输出统一内部 publication                               | public fromSource/fromCollectionSource/fromReadable protocol                | observe、external integration            |
| `core/src/projection/scheduler.ts` / `node.ts`   | 私有 graph executor 和 unified node lifecycle                    | 对外 scheduler/node capability                                              | runtime only                             |
| `core/src/projection/value.ts` / `collection.ts` | 共享 node lifecycle；collection 保留内部 keyed diff              | Materialized value/collection public contracts                              | runtime、advanced processor              |
| `core/src/integration.ts`                        | `observeExternal` 和 diagnostics boundary                        | `projectionRuntimeDebug` 主路径导出                                         | external adapters、debug tools           |
| `core/src/index.ts`                              | 根导出只保留基础 API                                             | 全部旧 projection type family                                               | README、docs、tests                      |
| `core/src/advanced` 或 advanced export path      | 提供 `incremental`、context、draft                               | Advanced types 混入根入口                                                   | advanced tests、docs                     |
| `react/src/hooks.ts`                             | selector tracking、`useProjection` optional selector、`useInput` | `useProjectionItem`、独立 setter/selector hooks                             | React tests、docs                        |
| `docs/projections.md` / `docs/architecture.md`   | 重写为基础/高级两层 API                                          | 旧 Engine、Materialized、CollectionReadable 文档                            | README、fixtures                         |

## 11. Implementation Plan

实施顺序必须自底向上，先修 owner 和 boundary，再更新 consumer，最后删除旧路径。

### Phase 0：冻结语义和基准

先建立不变语义的测试基线，不改 API：

- lazy materialization
- Runtime-local input
- batch previous/current
- reset/recovery
- document collection candidates
- collection before/after transitions
- unchanged item reference stability
- observer error 不回滚 commit
- keyed selector 的无关 key 不触发

同时记录现有 benchmark/profile 结果，作为 collection 和 selector 优化的回归基线。

### Phase 1：定义最终边界和导出

先改 contract 和根导出设计：

- 定义最终 `Projection<T>`、`Input<T>`、`ProjectionRuntime`。
- 定义 `observe` 的 document boundary。
- 定义 tuple `derive`。
- 将一次性 document selector 的旧语义改名为 `read`/snapshot 语义，避免与 reactive observe 混淆。
- 建立 advanced export path，但暂不迁移实现。

这一阶段不保留旧别名；所有编译错误都视为需要直接迁移的 consumer。

### Phase 2：删除双 Runtime owner

- 把 `store.ts` 的 lazy materialization owner 和 `runtime.ts` 的执行 owner 合并为一个 Runtime spine。
- 删除 `ProjectionEngine` 类型和 factory forwarding。
- 将 scheduler、source、materializer 改成 Runtime 私有实现。
- `rebuild`、`release`、`revision` 移入内部生命周期。

完成标准：仓库搜索不到 active `ProjectionEngine` 和 Runtime forwarding。

### Phase 3：重做 definition/source normalization

- 删除 `project()` 全部 competing overloads。
- 实现 `input`、`observe`、`derive(tuple, compute)`。
- 将 document/readable/external adapter 统一成内部 publication。
- 删除运行时的 `'current' in`、`'read' in`、`'address' in` 等 incidental shape dispatch。
- source-specific commits、candidates、transitions 变成 typed detail，不再复制整套事件类型。

### Phase 4：统一 node/processor lifecycle

- 把 value 和 collection 的 build/update/publish/clear/fault 生命周期收敛到一个内部 node state machine。
- Collection 只保留内部 keyed storage、order 和 transition calculation。
- 对外发布 immutable map-like value。
- `CollectionDraft` 只在 advanced processor session 中存在。

### Phase 5：实现 selector dependency tracking

- 以现有 `useDocumentSelector` 的 target tracking 为参考，扩展到 Projection collection reads。
- `get(key)` 记录 key dependency。
- `keys()/values()/entries()` 记录集合或 order dependency。
- collection publication 提供 changed keys/order/reset 给 consumer boundary。
- selector dependency 变化时重新安装订阅。
- 无法追踪的 selector 退化为 coarse subscription + equality。

这一阶段必须区分：React selector tracking 只影响消费端订阅，不能自动改变 Projection processor graph。

### Phase 6：迁移 React adapter

- `useProjection(projection)` 使用 Runtime get/subscribe。
- `useProjection(projection, selector, equality?)` 使用 tracked selector。
- `useInput(input)` 返回 `[value, setValue]`。
- Provider 管理默认 Runtime 的创建和 disposal。
- 删除 `useProjectionItem`、`useProjectionSelector`、`useProjectionSetter` 的并行路径。

### Phase 7：迁移 advanced processor

- 把 `EngineValueSpec`、`AdvancedValueSpec`、`EngineCollectionSpec`、`AdvancedCollectionSpec` 合并成 `incremental`。
- 迁移 retained state、reverse index、cross-key update 和 collection draft。
- 删除 public `CollectionInput`、`MaterializedCollectionWriter`、`AdvancedCollectionProcess`。
- 将 reset/recovery 变成 Runtime 内部行为。

### Phase 8：删除旧路径和更新文档

- 删除所有旧 type、API、export、helper、fallback 和 wrapper。
- 更新 README、`docs/projections.md`、`docs/architecture.md`、React 文档和 fixtures。
- 搜索仓库确认旧符号没有 active reference。
- 重新执行 typecheck、test、build、check、bench、profile。

## 12. Structural Rules

以下规则是目标态不可破坏的约束：

1. Document canonical state 只有 `createDocument` 一个写入 owner。
2. Projection derived state 只有 `ProjectionRuntime` 一个 owner。
3. Input 修改只有 `runtime.set` 一个 mutation funnel。
4. Projection processor dependencies 必须显式声明。
5. React selector tracking 只存在于消费边界，不反向构建 graph。
6. `observe` 只负责外部边界接入，不负责 map/filter/compute。
7. Collection draft 是借用式 session，不能逃逸。
8. Published collection 保持未变更成员的稳定引用。
9. 无关 key 更新不执行 key-aware selector。
10. 相关 key 更新后，equality 只负责结果级过滤，不承担 dependency invalidation。
11. 普通订阅只表达 invalidation，不携带多套 source/event 结构。
12. revision、batch id、rebuild、release 都是内部 runtime metadata/lifecycle。
13. processor 和 notification 期间禁止写入。
14. observer failure 不使已接受的 document commit 回滚。
15. dynamic cross-key dependency 必须由 advanced processor 显式维护 reverse index。
16. 不引入 generic join DSL，不引入自动 processor dependency tracking。

## 13. Completion Criteria

### API

- 根入口没有 `ProjectionEngine`。
- 根入口没有 `ValueProjection`、`CollectionProjection` 和两套 Materialized 类型。
- 基础定义只有 `input`、`observe`、`derive`。
- Runtime 主 API只有 `get`、`subscribe`、`set`、`batch`、`dispose`。
- React 基础 API只有 Provider、`useProjection`、`useInput`。
- advanced incremental 不污染默认根入口。

### Ownership

- 每个 canonical fact 只有一个 write owner。
- 每个 resolved fact 只有一个 resolver/materializer owner。
- source adapter、React adapter 和 diagnostics 都停留在 boundary。
- 没有调用者手动同步 canonical state、projection cache、selector cache 和 UI state。

### Incremental semantics

- `tasks.get(id)` 的 selector 在其他 key 更新时不执行。
- 读取整个 keys/order 的 selector 在结构变化时执行。
- 相关依赖变化但结果相等时，默认 `Object.is` 能阻止 React 重渲染。
- 动态 selector 依赖改变后能重新绑定 dependency set。
- 无法追踪的 selector 明确退化为 coarse subscription + equality。
- collection map、filter、order 和 reverse index 有性能回归测试。

### Verification

- `pnpm run typecheck` 通过。
- `pnpm run test` 通过。
- `pnpm run check` 通过。
- `pnpm run build` 通过。
- `pnpm run bench` 和 `pnpm run profile` 保持关键 collection/selector 路径的性能基线。
- 仓库搜索确认旧 API、旧类型、旧 export、别名和 forwarding path 已删除。

## 14. 最终判断

最小、清晰且不牺牲高级能力的最终使用模型是：

```text
基础：
  input
  observe
  derive([dependencies], compute)
  useProjection(projection, selector?)
  useInput(input)

高级：
  incremental([dependencies], processor)

内部：
  SourcePort
  Publication
  GraphNode
  Scheduler
  CollectionDraft
  keyed dependency index
```

普通用户只需要理解：

```text
observe → derive → useProjection
input → useInput
```

高级用户仍可获得真正的 key-level 增量更新，但不会再把 Runtime、Collection、Source、Materialized lifecycle 和 scheduler 细节带入基础 API。
