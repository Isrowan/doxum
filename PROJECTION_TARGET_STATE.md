# Projection 最终目标态与一步到位实施清单

> 这份清单是 Projection 子系统的目标态合同。范围覆盖 `core`、`react`、integration 边界、文档与测试。
> 目标是减少长期概念数量、消除重复协议、保留增量更新能力，并接受一次性 breaking change。
> 不建立兼容别名、适配层、旧入口或“双轨实现”。

## 0. 决策摘要

### 最终只保留的公共心智模型

| 类别   | 最终概念                 | 责任                                                                       |
| ------ | ------------------------ | -------------------------------------------------------------------------- |
| 声明   | `Projection<T, C>`       | 惰性、可复用、不可变的投影定义；不持有运行时状态                           |
| 声明   | `Input<T>`               | `Projection` 的可写特化；写入必须经过 `ProjectionRuntime.set`              |
| 运行时 | `ProjectionRuntime`      | 唯一的物化状态、缓存、输入写入、batch 与 disposal 所有者                   |
| 集成   | `Readable<T>`            | 面向 React/外部 store 的当前快照、revision 与订阅边界                      |
| 增量   | `CollectionChange<K, V>` | 唯一的精确 keyed collection transition；包含 reset 与 incremental 两种分支 |
| 高级   | `incremental`            | 保留状态、读取 change、反向索引和 keyed patch 的高级处理器命名空间         |

`input`、`observe`、`derive`、`createProjectionRuntime` 是工厂函数，不额外算作领域概念。
外部源类型是边界协议；它们支持集成，但不进入 Projection 核心心智模型。

### 最终只保留的内部概念

| 概念              | 责任                                                          | 是否形成独立长期边界                           |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `ProjectionGraph` | 连接 source adapter、node 与 scheduler，管理物化拓扑          | 是，内部唯一图边界                             |
| `Scheduler`       | 负责 settle、拓扑顺序、错误恢复、publication 与 notification  | 是                                             |
| `ValueNode`       | 标量值的构建、更新、equality、revision                        | 是                                             |
| `CollectionNode`  | keyed map、顺序、draft、精确 change publication               | 是                                             |
| `CollectionRead`  | callback 生命周期内借用的只读 collection reader               | 是，内部协议                                   |
| `CollectionDraft` | processor 生命周期内借用的 collection 写入意图                | 是，内部协议                                   |
| source adapters   | document、`Readable`、external source 到 graph context 的转换 | 是模块职责，但不是额外的 `SourceBoundary` 类型 |

下列名称不再作为最终概念存在：`ProjectionDefinition`、`SourceBoundary`、`CollectionDelta`、
`PublicCollection`、`CollectionProjection`、`IncrementalState`、`CollectionHandle`、
`CollectionContext.keys`、`CollectionContext.orderDirty`、incremental value 的 `{ kind: 'value' }` 返回协议。

## 1. Final Goal

完成后，Projection 应满足以下不变量：

- 定义与运行时完全分离。一个 `Projection` 可被多个 `ProjectionRuntime` 独立物化，定义本身不共享值、缓存、processor state 或订阅。
- `ProjectionRuntime` 是物化状态的唯一 owner。调用方不能手动 rebuild、dispose node、同步另一个缓存或直接改内部 collection。
- 依赖关系显式声明。`derive` 与 `incremental` 不通过读取其他 projection 自动追踪依赖。
- 每个 collection source/node 在自己的边界一次性产生精确的 net `CollectionChange`；下游不再同时读取 `keys`、`orderDirty`、transition list 等平行事实。
- document collection 的 `added`、`updated`、`removed`、`before`、`after` 和 order 信息在 processor 中完整可用；一个 document batch 只产生一个 batch-boundary transition。
- keyed selector 只在受影响的 key、结构或全量读取受影响时执行；无关 key 不会靠 equality 兜底。
- processor 先 settle，外部 listener 后通知；通知期间禁止写入；listener 失败不回滚已经接受的 document commit。
- Runtime batch 只延迟 graph settlement 和 projection listener，不延迟 document commit 或 document listener；batch 内 reader 看到最后一次 published projection。
- 所有 callback 同步执行；借用的 `CollectionRead` / `CollectionDraft` 不得逃逸 callback。
- 性能路径按变更规模工作。单 key 更新不能因为内部层重复复制、全量扫描或重复计算而退化为无界全量更新；确需扫描（例如结构变化时重建顺序）必须有明确的结构性原因。

## 2. Global Scope and Breaking Replacements

这次变更是一次目标态切换，不提供兼容窗口。

| 现有/候选形态                                                             | 最终形态                                                                               | 动作                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `ProjectionDefinition`                                                    | `Projection<T, C>`                                                                     | 删除前者；“definition”只保留为文档术语          |
| `source(...)` / `observeExternal(...)` / `observeExternalCollection(...)` | `observe(...)`                                                                         | 统一声明入口；不保留别名                        |
| `PublicCollection<K, V>`                                                  | `ReadonlyMap<K, V>`                                                                    | 删除别名，公共值直接使用平台语义                |
| `CollectionProjection<K, V>`                                              | `Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>`                                | 删除别名，调用点内联真实类型                    |
| `CollectionDelta`                                                         | `CollectionChange`                                                                     | 只保留一个名字；由于包含 reset，使用 `Change`   |
| `CollectionContext.keys`                                                  | 从 `change.added/updated/removed` 派生                                                 | 删除重复事实                                    |
| `CollectionContext.orderDirty`                                            | 由 `change.added`、`change.removed`、`change.order` 推导                               | 删除平行布尔协议                                |
| `CollectionContext.reset`                                                 | scheduler 内部保留 `SourceRecord.reset()`；context 通过 `change.kind === 'reset'` 表达 | 不对 processor 再暴露重复 reset 字段            |
| `IncrementalState`                                                        | `Record<string, unknown>` 内联                                                         | 删除无语义 alias                                |
| incremental value `{ kind: 'value', value, state? }`                      | 直接返回 `T`；state 在 callback 提供的对象上原地保留                                   | 删除 normalize/result protocol                  |
| `CollectionDraft.replace(...)`                                            | `set`、`remove`、`order`；需要全量替换时返回 `rebuild`                                 | 删除重复批量 API                                |
| collection entry 内部的 `{ kind: 'added' }` 等标签                        | `added`、`updated`、`removed` 数组的字段名承担分类                                     | 删除冗余嵌套 discriminator                      |
| external event `change?: CollectionImpact`                                | `impact?: CollectionImpact`，adapter 生成 canonical `CollectionChange`                 | 避免两个不同语义都叫 `change`                   |
| external event `detail`、外部注入的 `batch`                               | `cause`；Runtime 自己管理 batch context                                                | 删除未被 processor 消费的 metadata              |
| `ProjectionValues` / `ProjectionChanges` root export                      | definition/advanced 内部类型工具                                                       | 不再作为应用建模 API 导出                       |
| React hook 的 runtime positional overload                                 | `ProjectionProvider` + `useProjection(...)` / `useInput(...)`                          | 删除歧义 overload；多 runtime 使用嵌套 Provider |
| `trackProjection` / `subscribeProjection` 作为应用入口                    | `runtime.readable(projection, selector?, equality?)`                                   | integration 层只保留内部实现，不作为主心智模型  |

已经在当前工作区完成的基线删除也必须保持：`RuntimeExecutor`、旧 transitions、collection
`ids/all/item` handles、手动 node rebuild/dispose、scheduler forced/debug/disposeNode、
多套 materialization WeakMap 和 `Internal*` 兼容 alias 均不回归。

## 3. Representation Ledger

### 3.1 定义与公开值

| 表示                                 | 唯一 owner                                | 生产点                                         | 消费点                                         | 不变量                                          |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `Projection<T, C>`                   | `definition.ts` 的 definitions registry   | `input` / `observe` / `derive` / `incremental` | `ProjectionRuntime` materializer               | 惰性、不可变、无运行时状态                      |
| `Input<T>`                           | definition registry + owning Runtime      | `input` 定义，Runtime 首次 materialize         | `runtime.get`、`runtime.set`、React `useInput` | 值按 Runtime 隔离，写入只能经 `set`             |
| `ReadonlyMap<K, V>` projection value | `ProjectionRuntime`                       | `CollectionNode` publish 后由 `mapView` 暴露   | app、selector、React                           | 不可变视图；未变 entry 保持引用                 |
| `Readable<T>`                        | `ProjectionRuntime` 或外部 readable owner | `runtime.readable`                             | `useSyncExternalStore`、外部 store             | 只暴露当前快照、publication revision、subscribe |

### 3.2 Change、impact 与读写借用

| 表示                     | 语义                                    | owner                | 明确不能做什么                                     |
| ------------------------ | --------------------------------------- | -------------------- | -------------------------------------------------- |
| `CollectionChange<K, V>` | 已解析的精确 net transition             | source/node boundary | 不承担 document candidate filtering                |
| `CollectionImpact`       | document mutation 的候选失效提示        | document impact 层   | 不直接传给 projection processor；不含 before/after |
| `CollectionRead<K, V>`   | callback 内解析后的当前/next keyed read | source/node          | 不能跨 callback 或异步保存                         |
| `CollectionDraft<K, V>`  | processor 对输出 map 的写入意图         | `CollectionNode`     | 不能直接改 published map；不能跨 callback 保存     |
| `ProjectionContext`      | source/node 运行时 metadata             | graph 内部           | 不作为应用 API；不复制成第二套 transition 模型     |

### 3.3 当前要删除的重复表示

- collection 同时携带 `change`、`keys`、`orderDirty`：删除后两类 selector 与 map processor 都只读 `change`。
- public collection 同时有 alias、collection-specific alias 和 `ReadonlyMap`：删除 alias，只留 `ReadonlyMap`。
- scalar incremental 同时有 bare value 与 tagged value：删除 tagged value。
- source adapter 同时存 transition key set、impact flag 与 processor-facing change：key set 只作为 adapter 内部暂存，context 出口只有 canonical change。
- document `CollectionImpact` 与 projection `CollectionChange`：保留两者，但严格分层、不同命名、不同 owner。

## 4. Findings

### 4.1 可以直接去掉的概念

1. **`ProjectionDefinition` 不需要存在。** `Projection` 本身就是惰性定义句柄；再包一层 definition 只会造成类型、文档和 materializer 分叉。
2. **`SourceBoundary` 不需要成为类型。** document、readable、external source 的差异属于 source adapter 实现；给它们统一再抽象一层不会增加调用方能力。
3. **`CollectionDelta` 不需要与 `CollectionChange` 并存。** reset 也是一次变化，两个名字会让 processor 误以为有两种 payload。
4. **`PublicCollection`、`CollectionProjection`、`IncrementalState` 都是表面 alias。** 它们没有独立不变量，应删除。
5. **`keys` 与 `orderDirty` 不应成为 context API。** 它们是从 canonical change 可推导的优化辅助事实；保留会产生状态不同步风险。
6. **incremental value 的 tagged result 不需要存在。** callback 已经有 retained `state`；若需要重新建立内部索引，返回 `rebuild` 即可。
7. **`CollectionDraft.replace` 不需要存在。** 初始构建直接多次 `set`；更新时完整重建由 `rebuild` 表达，避免第二套“清空并替换”语义。

### 4.2 不能合并的概念

| 不应合并                                 | 原因                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ValueNode` / `CollectionNode`           | collection 有 key coverage、order、before/after 和 draft；泛化成一个 node 会把分支复杂度藏进泛型状态机             |
| `CollectionRead` / `CollectionDraft`     | 一个是 borrowed read，一个是 processor-local write intent；生命周期与权限相反                                      |
| `ProjectionGraph` / `Scheduler`          | graph 管声明物化、source attachment 与 node factory；scheduler 管 settlement、错误和通知顺序                       |
| `ProjectionRuntime` / `Readable`         | Runtime 是状态 owner；Readable 是集成边界。合并会让订阅生命周期污染 materializer                                   |
| `CollectionChange` / `CollectionImpact`  | 一个是精确数据 transition，一个是 document 失效候选；before/after 与覆盖范围不同                                   |
| `incremental` / `incremental.collection` | 共享命名空间即可；value 返回整体值，collection 通过 draft 发布 keyed patch，ownership 不同                         |
| `derive` / `incremental`                 | derive 是无 retained state 的常规计算；incremental 是显式高级协议，合并会让基本 API 带上 state/change/draft 复杂度 |

### 4.3 必须保留但不应扩大为新概念的内容

- `ProjectionError`、`ProjectionDisposedError`：错误/生命周期支持类型，不进入核心图模型。
- `ExternalValueSource`、`ExternalCollectionSource`：边界协议；通过 `observe` 接入，不增加新的 observe 函数族。
- `GraphSource`、`ValueContext`、`CollectionContext`、`NodeUpdate`、mapped tuple helper：内部类型 plumbing，不 root-export，不写入用户心智模型。

## 5. Final Types

### 5.1 公共声明 API

```ts
type Projection<T, C = undefined> = {
  readonly [projectionDefinition]: T;
  readonly [projectionChanges]: C;
};

type Input<T> = Projection<T> & {
  readonly [writableInput]: true;
};

function input<T>(initial: T, equality?: (previous: T, next: T) => boolean): Input<T>;

function observe<T>(source: ExternalValueSource<T>): Projection<T>;
function observe<K extends string, V>(
  source: ExternalCollectionSource<K, V>
): Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>;
function observe<S extends ObjectNode>(document: DocumentReadable<S>): Projection<Infer<S>>;
function observe<S extends ObjectNode, P>(
  document: DocumentReadable<S>,
  selector: (path: SchemaPath<S['shape']>) => P
): Projection<PathValueOf<P>>;

function derive<const D extends readonly Projection<unknown, unknown>[], T>(
  dependencies: D,
  compute: (...values: ProjectionValues<D>) => T,
  equality?: (previous: T, next: T) => boolean
): Projection<T>;
```

`ProjectionValues` 只作为内部/advanced 类型推导工具存在，不从根入口导出。上面用它是为了表达
tuple inference，不表示它是用户需要理解的独立概念。

### 5.2 唯一的 collection transition

```ts
type CollectionChange<K extends string, V> =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'incremental';
      readonly added: readonly { readonly key: K; readonly after: V }[];
      readonly updated: readonly {
        readonly key: K;
        readonly before: V;
        readonly after: V;
      }[];
      readonly removed: readonly { readonly key: K; readonly before: V }[];
      readonly order?: {
        readonly before: readonly K[];
        readonly after: readonly K[];
      };
    };
```

约束：

- `reset` 表示无法安全复用旧索引或旧引用；processor 必须按完整输入重建。
- `incremental` 是一个 application action / document batch 的 net change；不会泄漏 batch 内部的中间写入。
- `before`/`after` 是 source/node 边界捕获的真实值，不信任调用方传入的逆向数据。
- `order` 只在顺序发生可观察变化时出现；`added`/`removed` 本身已足以说明结构变化，runtime.map 在结构变化时读取当前 ids 以保留插入位置。
- 不在 entry 内重复放 `kind`；数组字段已经承担 added/updated/removed 分类。

### 5.3 Runtime 与 Readable

```ts
type ProjectionRuntime = {
  get<T>(projection: Projection<T, unknown>): T;
  readable<T>(projection: Projection<T, unknown>): Readable<T>;
  readable<T, R>(
    projection: Projection<T, unknown>,
    selector: (value: T) => R,
    equality?: (previous: R, next: R) => boolean
  ): Readable<R>;
  set<T>(input: Input<T>, value: T): void;
  batch<T>(run: () => T): T;
  batch<T>(options: { readonly cause?: unknown }, run: () => T): T;
  dispose(): void;
};

type Readable<T> = {
  current(): T;
  revision(): number;
  subscribe(listener: () => void): Unsubscribe;
};
```

Runtime 只有五类动作：读、建立 readable、写 input、批处理、释放。没有公开 node handle、rebuild、
per-key subscription、手动 flush 或 executor。

### 5.4 高级 incremental API

```ts
const total = incremental([tasks], ({ sources, changes, previous, reset, cause, state }) => {
  // 直接返回 T；state 在 Runtime 内按 definition 隔离并跨 update 保留
  return nextTotal;
});

const index = incremental.collection(
  [tasks],
  ({ sources, changes, previous, next, reset, cause, state, output }) => {
    // output 只有 set/remove/order；完整重建通过返回 { kind: 'rebuild' }
    for (const entry of changes[0]?.updated ?? []) {
      output.set(entry.key, buildIndex(entry.after));
    }
  }
);
```

最终 callback context 保留：`sources`、`changes`、`previous`、`next`（collection）、`reset`、`cause`、
`state` 和 `output`（collection）。删除 `IncrementalState` alias 与 value tagged result。
`sources` 中的 collection 值是 callback-local 的惰性 `ReadonlyMap` 视图；`get`/`has` 不扫描全量，
迭代才显式读取全部成员，且该视图不得保存或作为 processor 结果直接返回。

## 6. Final APIs and Ownership

### 6.1 典型应用用法

```ts
const filter = input<'all' | 'open'>('all');
const tasks = observe(document, path => path.tasks);
const visibleTasks = derive([tasks, filter], (tasks, filter) => filterTasks(tasks, filter));

const runtime = createProjectionRuntime({ onError: reportProjectionError });

runtime.get(visibleTasks);
runtime.readable(visibleTasks);
runtime.readable(visibleTasks, tasks => tasks.get(taskId));
runtime.set(filter, 'open');
runtime.batch({ cause: { action: 'refresh' } }, () => {
  runtime.set(filter, 'all');
  // document transaction 仍按 document 自己的写入 API 执行
});
runtime.dispose();
```

React 只保留常见心智模型：

```tsx
<ProjectionProvider value={runtime}>
  <TaskList />
</ProjectionProvider>;

function TaskList() {
  const tasks = useProjection(visibleTasks);
  const task = useProjection(visibleTasks, tasks => tasks.get(taskId));
  const [mode, setMode] = useInput(filter);
  // ...
}
```

React hook 不再接受位置含义容易混淆的 runtime overload；需要多个 runtime 时使用嵌套 Provider。
`runtime.readable` 是 React 与其他 integration 的共同基础，不再分别维护 `trackProjection` / `subscribeProjection` 主路径。

### 6.2 唯一 ownership 表

| owner               | 唯一负责                                                            | 明确不负责                         |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| definition registry | 保存惰性定义与 runtime-independent metadata                         | 不保存当前值、state、订阅          |
| `ProjectionRuntime` | materialized definition、公开快照缓存、input setter、dispose        | 不直接实现 scheduler 拓扑算法      |
| `ProjectionGraph`   | source attachment、node factory、graph lifecycle                    | 不向应用暴露低级 graph handle      |
| source adapters     | 读取 document/external/readable，捕获 baseline，产生 context/change | 不拥有 canonical document state    |
| `Scheduler`         | settle、排序、blocked/fault recovery、publish、notify               | 不解释业务 collection 语义         |
| `ValueNode`         | scalar candidate/equality/revision                                  | 不管理 keyed order 或 draft        |
| `CollectionNode`    | staged map、order、entry equality、canonical change                 | 不让 processor直接写 published map |
| `CollectionRead`    | callback 内借用读取                                                 | 不跨 callback/异步逃逸             |
| `CollectionDraft`   | callback 内写入意图                                                 | 不作为第二个 mutation engine       |
| React adapter       | `useSyncExternalStore`、Provider、hook 生命周期                     | 不缓存/修改 projection state       |

### 6.3 Selector 增量语义

- `tasks.get(id)` 记录一个 key dependency；其他 id 的 `updated` 不执行 selector。
- `tasks.has(id)` 同样只依赖一个 key。
- `tasks.keys()` 依赖结构与顺序；单纯 value update 不执行 selector。
- `tasks.values()`、`entries()`、`for...of` 依赖整个 collection。
- 只有命中 dependency 后才运行 selector；`equality` 只负责判断 selector 结果是否发布，不是无关更新的兜底机制。
- selector 必须同步、纯函数；不得保存借用 reader 或 draft。

## 7. Structural Rules

### 7.1 图与调度

- `ProjectionGraph` 是唯一的内部 graph facade；所有 source/node 都通过它进入 scheduler registry。
- `Scheduler` 的 phase 固定为 idle → compute → publish → notify；compute/notify 中禁止重新进入写入。
- processors 先完成并发布，随后才调用 external listeners；错误通过 `ProjectionError` 和 `onError` 报告。
- fault recovery 只通过内部重新 build；应用永远不调用 `rebuild`。
- 所有 projection dependency 在 definition 创建时冻结；不得在 processor 执行期间动态注册 graph edge。

### 7.2 Collection change

- document source 在 commit boundary 保存 collection baseline；只在 source context 出口生成一次 exact `CollectionChange`。
- external collection source 可以提供 `impact` 作为候选优化，但 adapter 最终必须生成相同的 exact `CollectionChange`；processor 永远看不到 `CollectionImpact`。
- node output 通过 `CollectionDraft` 暂存，publication 时一次性校验 key coverage 和 order，并一次性计算 added/updated/removed/order。
- 如果 processor 返回 `rebuild`，清空旧实例和 staged output，重新执行 build；不得保留半更新的 output。
- `CollectionRead` 和 `CollectionDraft` 的 active scope 由 scheduler 维护；同步 callback 返回后立即失效。

### 7.3 Runtime 与批处理

- materialized state 只存在于 owning `ProjectionRuntime`；同一 definition 在不同 runtime 中值和 state 完全隔离。
- materialization 采用 definition → runtime-local node 的单一 WeakMap；不得另建按 handle、source、selector 的多套 owner cache。
- Runtime batch 只在最外层 callback settle 一次；嵌套 batch 复用同一个 batch context。
- `runtime.get` 在 batch 内返回最后一次 published 值，不提前暴露 staged 值。
- `dispose` 后所有 runtime-owned node、source binding、readable 和 input setter 统一失效，并抛 `ProjectionDisposedError`。

## 8. Change-Surface Ledger

### Core

- [x] 将 `CollectionChange` 提取为唯一 canonical change contract；删除 entry 内部冗余 `kind`。
- [x] 从 `CollectionContext` 删除 `keys`、`orderDirty` 以及重复的 public `reset`；scheduler-private reset 保留。
- [x] 精简 `ValueContext`、`CollectionContext`：删除未被 processor 消费的 `previous`、`changed`、`detail`、外部注入 `batch`。
- [x] 将 external collection event 的 hint 命名为 `impact`；由 adapter 转成 exact change。
- [x] 删除 `PublicCollection`、`CollectionProjection`、`IncrementalState`、`CollectionHandle` 等 alias/type facade。
- [x] 删除 `CollectionDraft.replace`；统一使用 `set`、`remove`、`order` 和 `rebuild`。
- [x] 删除 incremental value 的 tagged result 与 `normalizeValue`。
- [x] 将 `ProjectionValues`、`ProjectionChanges` 降为内部 type plumbing，不再 root-export。
- [x] 按职责整理文件：公开 runtime/materializer 与内部 graph construction 分离；`runtime.ts` 不再同时承担两个含义。
- [x] 保留 `CollectionImpact` 在 document domain；禁止 projection 层直接构造 impact index 过滤 selector。

### React / integration

- [x] `useProjection` 只保留 `projection`、`selector`、`equality` 参数；runtime 仅从 `ProjectionProvider` 取得。
- [x] `useInput` 只保留 `input` 参数；setter 仍通过 runtime.set。
- [x] integration 内部可复用 `runtime.readable`，但不再把 `trackProjection` / `subscribeProjection` 作为使用者需要理解的公开模型。
- [x] keyed selector 的 invalidation 完全读取 `CollectionChange`；不增加第二套 collection subscription protocol。

### Docs / package surface

- [x] 更新 `README.md`、`docs/projections.md`、`docs/architecture.md`：只展示最终 API 和最终生命周期。
- [x] root `doxum` export 只导出稳定公共契约；内部 graph/node/context/type helper 不通过 root 暴露。
- [x] `doxum/advanced` 只导出 `incremental` 与其必要推导类型；不导出 materializer 内部协议。
- [x] 删除旧 API、旧术语和兼容示例的全文引用；文档中明确 `observe` 是唯一 source declaration 入口。

## 9. Phase Checklist

实施顺序固定为自底向上，禁止先在 React 层打补丁再反推 core。

### Phase 0 — Freeze the contract

- [x] 将本文件作为设计基线评审并锁定最终命名。
- [x] 建立删除清单，任何旧名重新出现都视为失败，而不是兼容需求。
- [x] 确认根导出、advanced 导出、React 导出和 integration export 的最终白名单。

### Phase 1 — Contract and type cleanup

- [x] 修改 `CollectionChange`、source event、value/collection contexts、draft protocol。
- [x] 删除 aliases、tagged result、keys/orderDirty/detail/batch 等重复字段。
- [x] 让所有 producer/consumer 先通过同一套类型边界，再进入实现改造。

### Phase 2 — Source boundaries

- [x] document collection 捕获 batch baseline，生成 exact before/after/order change。
- [x] external value/collection adapter 统一由 `observe` 接入；`impact` 仅作为候选优化。
- [x] external source 的 reset、revision、cause 语义与 document source 对齐。
- [x] 对 source 异常、disposed document、外部 source 订阅失败保持统一 `ProjectionError` 路径。

### Phase 3 — Nodes and scheduler

- [x] `ValueNode` / `CollectionNode` 保持分离，只共享 scheduler/node registration plumbing。
- [x] `CollectionNode` 只从 staged state 发布一个 canonical `CollectionChange`。
- [x] 完成 output key coverage、order、entry equality、reset/rebuild 的原子校验。
- [x] 保持 processors-before-listeners、禁止 re-entry、fault recovery 和 publication ordering。

### Phase 4 — Runtime materializer and readable

- [x] Runtime 成为 materialized state 的唯一 owner；definition → node 只保留一套缓存。
- [x] `runtime.get` 对 collection 提供 stable immutable `ReadonlyMap` view；未变 entry 保持引用。
- [x] `runtime.readable(projection, selector?, equality?)` 成为唯一 selector/integration boundary。
- [x] selector invalidation 直接消费 `CollectionChange`；无关 key 不执行 selector。
- [x] batch、dispose、error reporter 的最终生命周期与本文件一致。

### Phase 5 — Advanced incremental

- [x] `incremental` 仍是 value processor；`incremental.collection` 仍是 keyed draft processor。
- [x] value processor 只返回 `T | { kind: 'rebuild' }`；state 原地保留。
- [x] collection processor 只通过 `output.set/remove/order` 写入；全量替换通过 rebuild。
- [x] `changes` tuple 对 collection dependency 提供 exact before/after；scalar dependency 为 `undefined`。
- [x] reset、rebuild、processor fault 后 state/output 不出现半旧半新的混合状态。

### Phase 6 — React and integration

- [x] 去除 hook runtime positional overload，统一 Provider 心智模型。
- [x] React 仅使用 `Readable` 与 `useSyncExternalStore`；不触碰 graph/node/context。
- [x] SSR/server snapshot、嵌套 Provider、多 runtime 隔离和 dispose 行为补齐测试。

### Phase 7 — Tests and documentation

- [x] 更新 core projection tests、React tests、integration tests 和 public type tests。
- [x] 更新 README、projection docs、architecture docs 的所有 API、生命周期和术语。
- [x] 为每个删除项增加“旧 symbol 不存在”的静态检查或 grep guard，防止回归。

### Phase 8 — Verification and cleanup

- [x] `pnpm run format:check`
- [x] `pnpm run lint`
- [x] `pnpm run typecheck`
- [x] `pnpm run test`
- [x] `pnpm run build`
- [x] `pnpm run check`
- [x] projection 相关变更运行 `pnpm run bench` / `pnpm run profile`（常规 bench 与 targeted profile 已完成；100k stress 配置保留为 `DOXUM_PROJECTION_BENCH_SIZE=100000`，不纳入常规 check）。
- [x] 清理所有旧文件、未使用 export、过渡 helper、注释中的旧 API 和死类型。

## 10. Test Matrix

### Correctness

- [x] unrelated document commit 不触发不相关 projection processor。
- [x] collection added / updated / removed / reorder 均产生正确 before/after 与 stable references。
- [x] 同一 batch 内多次修改同一 key，只发布 net transition；add→remove 与 update→restore 正确折叠。
- [x] reset 后第一次 incremental 的 baseline 正确；reset 不泄漏旧 state/output。
- [x] external source 有 impact、无 impact、revision 跳跃、source fault、source dispose 均正确。
- [x] processor 返回 rebuild、抛异常、error reporter 抛异常时，published state 不半更新。
- [x] selector 读取单 key、结构、全量 collection 时，只有对应 change 才重新执行。
- [x] equality 只抑制结果 publication，不负责屏蔽无关 selector 执行。
- [x] 多 Runtime 使用同一 definition 时 state、input、revision、dispose 完全隔离。
- [x] nested batch、batch callback 抛异常、listener 抛异常、通知期间写入均符合生命周期合同。

### Type and API surface

- [x] `ProjectionDefinition`、`CollectionDelta`、`PublicCollection`、`CollectionProjection`、`IncrementalState`、`SourceBoundary` 不在 root 或 advanced export。
- [x] `ProjectionValues`、`ProjectionChanges` 只存在于必要的内部推导位置。
- [x] `CollectionChange` 是所有 collection processor 的唯一 change 类型。
- [x] React hook 不接受 runtime positional overload。
- [x] `ReadonlyMap` 作为 collection projection 的唯一公共值类型。

### Performance

- [x] 100k collection 中单 key update 的 processor work 与变更 key 数量近似线性，不复制无关 values。
- [x] 单 key selector 不因其他 key update 执行；结构变化才扫描 ids。
- [x] derive chain 不引入重复 materialization 或重复 source subscription。
- [x] batch 中多次写入只 settle 一次，且只生成一次 net collection change。
- [x] profile counters 能区分 rebuilt、updated、ids scanned、mapped、notifications，避免优化回归无法观测。

## 11. Completion Criteria

只有以下条件全部满足，Projection 才算完成目标态：

1. 公共 API、内部概念和 ownership 与本文件一致；没有未决“双方案”。
2. 所有删除项均已物理删除，不是 deprecated、alias 或隐藏兼容入口。
3. 每个 source/node collection boundary 都产生 canonical exact `CollectionChange`，processor 不接触 `CollectionImpact`、keys 或 orderDirty。
4. `runtime.readable` 是唯一高层订阅/selector 入口，React 不直接依赖 graph/integration 内部协议。
5. 增量 value 与增量 collection 都能保留 runtime-local state，并在 reset/rebuild/fault 时原子恢复。
6. 正确性、类型表面、性能矩阵全部通过；`pnpm run check`、build、bench/profile 均无回归。
7. README、projection docs、architecture docs 只描述目标态；代码搜索不再出现旧术语。
8. 新贡献者只需要理解“声明 → Runtime 物化 → Readable 消费”，只有确需增量算法时才进入 `incremental`。

## 12. Non-goals

- 不引入自动 dependency tracking、隐式 source discovery 或 processor 内读取其他 projection 的魔法。
- 不把 React、`useSyncExternalStore` 或 UI lifecycle 引入 core。
- 不把 document mutation 的 `CollectionImpact` 改造成 projection 的公共 change 模型。
- 不为旧 API 保留迁移适配器、deprecated export、运行时分支或双写路径。
- 不为了“统一”而把 scalar node、collection node、read、draft、graph、scheduler 强行压成一个泛型对象。
