# Projection Composition & Collection Observation 最终目标态

> 状态：已完成落地。按长期最优一次性收敛，不保留兼容层，不保留旧协议别名。
>
> 本文同时收敛两个缺口：
>
> 1. schema `list()` 的原生 keyed collection observation；
> 2. `incremental.group(...)` 的 scalar/value output leaf。

## 1. Final Goal

Projection 最终只保留一条 collection spine 和一条 value spine：

```text
Document / external / input
  ├─ value
  └─ collection
      ├─ map
      ├─ table
      └─ list(keyOf)

Projection graph
  ├─ value node
  └─ collection node

incremental.group
  └─ one atomic processor
      ├─ value leaf
      └─ collection leaf
```

最终必须满足：

- `observe(document, path => path.someList)` 对 schema `list()` 直接得到 keyed collection projection；
- list 的稳定 identity 只来自 schema `keyOf`，绝不使用数组 index 作为 key；
- map / table / list 统一发布同一个 `CollectionChange<K, V>`；
- ordered collection 的移动继续通过 `order.before/order.after` 表达，不增加 `ListChange` / `OrderChange`；
- `incremental.group` 的静态 namespace 可以混合 `define.collection(...)` 与 `define.value(...)`；
- value leaf 仍然是普通 `Projection<T>`，没有 `ValueChange`、singleton collection 或额外 scalar runtime；
- group 内所有 changed leaves 在同一个 causal settle 中原子提交，下游永远看不到半代状态；
- scope、runtime、React selector tracking、error recovery、revision 与 disposal 继续复用现有 Projection 体系；
- public API 概念不因这两个能力继续膨胀。

这两个能力不是两套新机制。它们分别补齐现有 collection source boundary 和 group output leaf model。

---

## 2. Final Public API

### 2.1 Keyed list observation

给定：

```ts
const model = object({
  order: list(field<Item>(), {
    keyOf: item => item.id,
  }),
});
```

最终直接支持：

```ts
const order = observe(document, path => path.order);
```

其类型语义等价于：

```ts
Projection<ReadonlyMap<string, ReadonlyValue<Item>>, CollectionChange<string, ReadonlyValue<Item>>>;
```

读取方式和 map/table collection 完全一致：

```ts
const items = runtime.get(order);

items.get(itemId);
items.has(itemId);

for (const [id, item] of items) {
  // iteration order === document list order
}
```

React 继续使用同一个 selector mental model：

```ts
const item = useProjection(order, items => items.get(itemId));
```

另一个 item 更新时，这个 selector 不执行；只有 `itemId` 自己的 added / updated / removed 才使该 keyed selection 失效。

### 2.2 什么才是 keyed list

只有 schema `list()` 是 keyed collection，因为它已经拥有稳定 `keyOf`：

```ts
list(field<Item>(), { keyOf: item => item.id });
```

以下普通 field 仍然只是 value：

```ts
field<readonly Item[]>();
```

不会：

- 自动把数组 index 当 identity；
- 猜测 `id` 字段；
- 新增 `observeList`；
- 新增调用方传入的 `keyOf` observation option。

稳定 identity 属于 schema 事实，必须在 canonical document model 上定义一次。

### 2.3 List item path

`list()` 进入 `CollectionPath` 后，也应该与 map/table 一样支持稳定 item addressing：

```ts
path => path.order.item(itemId);
```

它仍然使用 schema/address 体系，不增加第二套 list path 或 index path。

### 2.4 CollectionChange 最终语义

保持唯一 collection transition 协议：

```ts
type CollectionChange<K extends string, V> =
  | { kind: 'reset' }
  | {
      kind: 'incremental';
      added: readonly { key: K; after: V }[];
      updated: readonly { key: K; before: V; after: V }[];
      removed: readonly { key: K; before: V }[];
      order?: {
        before: readonly K[];
        after: readonly K[];
      };
    };
```

对于 list：

- 新 item：`added`；
- 删除 item：`removed`；
- key 不变、value 改变：`updated`；
- 已存在 item 的相对次序改变：`order.before/order.after`；
- 首次 materialize / reset：`reset`。

`keyOf` 在 replace 后必须保持原 key。这个 invariant 已属于 document mutation 层，Projection 不再做第二次身份修复。

#### Order 的重要约束

`order` 继续表达“变更前后都存在的 key，其相对顺序发生变化”，而不是把 membership change 重复编码一次。

因此纯 insert/remove：

```ts
{
  kind: 'incremental',
  added: [...],
  updated: [],
  removed: [...],
  // no order when surviving keys retain their relative order
}
```

纯 move：

```ts
{
  kind: 'incremental',
  added: [],
  updated: [],
  removed: [],
  order: {
    before: ['a', 'b', 'c'],
    after: ['b', 'a', 'c'],
  },
}
```

这是刻意保留的性能语义：不能因为 100k item list 新增一个元素，就强制 source 为每个 subscriber 构造两份完整 order 数组。

当前 `CollectionRead.ids()` / public `ReadonlyMap` iteration 始终是 after-state 的权威顺序。需要镜像完整顺序的 processor 在 `added.length || removed.length || change.order` 时读取一次当前 keys 即可。

### 2.5 Mixed-output incremental group

最终 API：

```ts
const scene = incremental.group(
  [graph, viewport],
  define => ({
    graph: define.collection<NodeId, SceneNode>(),
    background: define.value<Background>(),
    chrome: define.value<Chrome>(),
    overlay: define.value<Overlay>(),
    revision: define.value<number>(),
  }),
  ({ sources, changes, previous, next, outputs, reset, state }) => {
    // keyed output
    outputs.graph.set(nodeId, node);

    // scalar outputs
    outputs.background.set(background);
    outputs.chrome.set(chrome);
    outputs.overlay.set(overlay);
    outputs.revision.set(revision);
  }
);
```

嵌套 namespace 继续允许：

```ts
define => ({
  node: {
    shell: define.collection<NodeId, Shell>(),
    content: define.collection<NodeId, Content>(),
  },
  scene: {
    chrome: define.value<Chrome>(),
    overlay: define.value<Overlay>(),
  },
});
```

namespace 仍然只是静态命名树，不是 runtime、projection、event bus 或 transaction。

### 2.6 `define.value<T>(equality?)`

唯一新增的 group leaf API：

```ts
define.value<T>(equality?)
```

默认 equality：

```ts
Object.is;
```

不增加：

- `define.scalar`；
- `define.atom`；
- `define.singleton`；
- `define.field`；
- `ValueChange`；
- `ScalarProjection`。

value leaf 的 public result 就是：

```ts
Projection<T>;
```

collection leaf 仍然是：

```ts
Projection<ReadonlyMap<K, V>, CollectionChange<K, V>>;
```

### 2.7 Value output draft 语义

processor 中 value leaf 只暴露一个操作：

```ts
outputs.chrome.set(value);
```

没有：

- `remove()`；
- `clear()`；
- `replace()`；
- `reset()`。

如果“没有值”属于领域状态，类型直接写成：

```ts
define.value<Chrome | undefined>();
```

并显式：

```ts
outputs.chrome.set(undefined);
```

内部必须用 sentinel 区分“processor 没有 set”与“显式 set(undefined)”。

### 2.8 Initial/reset 与 incremental update

value leaf 的规则：

#### Initial build / rebuild

每个 `define.value<T>()` leaf 必须在该次 processor run 中至少 `set(...)` 一次。

如果遗漏：

- 整个 group evaluation 失败；
- 所有 leaf 都不 publish；
- 不允许产生部分初始化的 group。

#### Normal incremental update

如果某个 value leaf 本轮没有调用 `set(...)`：

- 保留已发布值；
- revision 不变；
- 不通知 listener；
- 不调度只依赖该 leaf 的 downstream node。

如果调用 `set(...)` 但 equality 相等，同样视为 unchanged。

### 2.9 `previous` / `next` 的 mixed leaf 语义

collection leaf 保持现状：

```ts
previous.graph: CollectionRead<K, V>
next.graph: CollectionRead<K, V>
outputs.graph: CollectionDraft<K, V>
```

value leaf：

```ts
previous.chrome: Chrome | undefined
next.chrome: Chrome | undefined
outputs.chrome.set(nextChrome)
```

具体语义：

- 首次 build：`previous` 为 `undefined`；
- rebuild：`previous` 是上一个已发布值，`next` 从未初始化状态开始；
- 普通 update：`next` 初始等于 `previous`；
- 调用 `outputs.x.set(v)` 后，`next.x` 反映 staged value；
- runtime 内部使用 sentinel 判断 reset 时 leaf 是否真正初始化，不能用 `undefined` 判断。

`next` 仍然是 callback-local borrowed read，不允许逃逸。

---

## 3. Global Scope and Breaking Replacements

本轮不做 compatibility。

### 3.1 Public breaking behavior

schema `list()` 的 selector 从普通 whole-value projection 改成 keyed collection projection：

```ts
observe(document, path => path.order);
```

目标态返回 `ReadonlyMap<key, item>`，不再返回 list array snapshot。

需要 whole-array 的调用方应该显式从 collection projection derive：

```ts
derive([order], order => [...order.values()]);
```

或者观察更高一级真正需要的 value boundary。不要为了兼容旧行为增加 `observeValueList`。

### 3.2 Internal breaking replacements

| Current                                                     | Final                                                  | Action                  |
| ----------------------------------------------------------- | ------------------------------------------------------ | ----------------------- |
| list path 仅为 value path                                   | list path 是 `CollectionPath`                          | replace                 |
| collection path 只接受 table/map                            | table/map/list 共用 collection selector                | widen existing spine    |
| source entry schema 只识别 map/table                        | map/table/list 共用 entry schema                       | replace branch          |
| `GroupOutput<K,V>` collection-only descriptor               | private discriminated value/collection leaf descriptor | replace                 |
| `CollectionGroupSpec`                                       | `GroupSpec`                                            | rename/replace          |
| `createCollectionGroup`                                     | `createGroup`                                          | rename/replace          |
| group outputs 固定 `CollectionNode[]`                       | mixed `ValueNode                                       | CollectionNode` outputs | replace |
| group definitions 的 projections 固定 collection projection | `Projection<unknown, unknown>[]` + leaf metadata       | replace                 |
| scene singleton collection wrapper                          | direct `define.value` leaves                           | delete                  |
| collection → scalar derive glue                             | direct value group leaf                                | delete                  |

不保留 old type aliases、overload、bridge 或 fallback。

---

## 4. Representation Ledger

| Current type/API           | Role                                | Current owner           | Problem                                                | Final representation                                        | Action             |
| -------------------------- | ----------------------------------- | ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------- | ------------------ |
| `ListNode<T>`              | canonical schema fact               | schema                  | 已有 `keyOf`，但 projection path 没把它视作 collection | 保持 `ListNode<T>`，其 path 编译为 keyed collection         | keep + extend      |
| `CollectionPath`           | schema-resolved path marker         | schema                  | 只覆盖 map/table                                       | 覆盖 map/table/list                                         | extend             |
| `CollectionSelector`       | resolved collection address         | schema                  | 语义实际可支持 list，但 compiler 拒绝                  | 同一个 selector 覆盖三类 keyed container                    | keep               |
| `CollectionImpact`         | document invalidation               | impact                  | 已有 added/removed/updated/orderChanged                | 继续服务 map/table/list                                     | keep               |
| `CollectionRead`           | projection collection read          | projection              | 已能表达 list 的 get/has/ids                           | 不变                                                        | keep               |
| `CollectionChange`         | projection transition               | projection              | 已能表达 list transition                               | 不变                                                        | keep               |
| `CollectionDraft`          | processor collection session intent | projection              | 已完整                                                 | 不变                                                        | keep               |
| `GroupOutput<K,V>`         | group declaration descriptor        | advanced projection API | collection-only                                        | private discriminated value/collection leaf descriptor      | replace            |
| `CollectionGroupSpec`      | graph processor boundary            | projection graph        | 名称和 shape 都假设 collection-only                    | mixed `GroupSpec`                                           | replace            |
| `createCollectionGroup`    | multi-output materializer           | projection graph        | 只能创建 collection leaf                               | `createGroup` mixed leaves                                  | replace            |
| value publication logic    | runtime derived state               | value node              | group scalar leaf 不能复用                             | 抽出 private value-state kernel供 ordinary value/group 共用 | factor, not public |
| `CollectionState`          | runtime derived keyed state         | collection node/group   | 已是共享 keyed publication kernel                      | 保持                                                        | keep               |
| singleton scene collection | fake derived representation         | application processor   | 用 fake key 承载 scalar                                | 普通 value leaf                                             | delete             |

这里没有新的 canonical state。所有 group output 继续是 `ProjectionRuntime` 拥有的 derived state。

---

## 5. Findings and Lowest-Boundary Decisions

### Finding A — List 已经具备 collection identity，缺口在 schema path boundary

Evidence:

- `ListNode<T>` 已要求 `keyOf(item) => string`；
- Read/Draft list access 已经有 `get / has / ids / move`；
- mutation recorder 已按 stable list key 记录 member/order change；
- `CollectionImpact` 的模型已经足够描述 list 的 added/removed/updated/orderChanged；
- 当前真正阻断 list observation 的地方是 `PathValue<ListNode>`、`pathProxy` 和 `compilePath(..., 'collection')` 只承认 table/map。

Domain fact:

> schema list 是一个“ordered keyed collection”，不是一个只能 whole-value 观察的数组。

Lowest wrong boundary:

> schema path compilation。

Final owner and representation:

> `schema.ts` 继续拥有 collection identity；Projection source 只消费 resolved `CollectionSelector`。

Deleted protocol:

> 不新增任何 list-specific observation protocol。

Invariant after change:

> 所有具有 schema-level stable key 的线性 collection 都通过一个 `CollectionSelector -> CollectionRead/Change` spine。

### Finding B — Group 的限制来自 leaf model，不是 processor/scheduler 能力不足

Evidence:

- scheduler 已支持一个 node 拥有多个 `OutputRecord`；
- `changedOutputs()` 已支持只调度实际变化的 leaf；
- group 已经按一个 processor / 一个 causal batch 原子 publish；
- 当前 `IncrementalGroupDefinition`、`CollectionGroupSpec`、`createCollectionGroup` 只是把所有 leaf 写死成 collection；
- standalone value node 已有完整 equality/revision/listener 语义。

Domain fact:

> group 是“一次 processor evaluation 产生多个命名 derived outputs”，leaf 可以是 value 或 keyed collection。

Lowest wrong boundary:

> group output descriptor + group materialization boundary。

Final owner and representation:

> 一个 group node；每个 leaf 使用现有 value/collection publication semantics。

Deleted protocol:

> singleton collection + downstream scalar derive glue。

Invariant after change:

> output kind 不改变 group 的 atomicity；它只决定该 leaf 使用 value publication 还是 collection publication。

### Finding C — 不应新增 ValueChange

scalar projection 的 downstream invalidation 只需要 revision/change notification；不存在 keyed patch 消费需求。

`CollectionChange` 的存在是因为 keyed processor 必须知道“哪些 key 变了以及 before/after 是什么”。scalar dependency 已经通过 value node revision 精确失效，再造 `ValueChange<T>` 只会形成第二套 value event contract。

最终：

- scalar dependency 的 `changes[index]` 继续是 `undefined`；
- scalar current value 继续从 `sources[index]` 读取；
- group 自己的 value output previous/next 属于 output draft 生命周期，不升级为公开 change protocol。

### Finding D — Observation kind 不应依赖异常控制流

当前 document projection materialization 会先尝试 collection selector，失败后再退回 value selector。list 扩展时不应继续扩大这种 try/catch classification。

目标态应该由 schema path compiler 一次解析 selector 的真实 kind：

```text
selected schema node
  ├─ map/table/list -> collection selector
  └─ everything else -> value selector
```

实现形式可以是内部 auto-compile helper 或等价的 discriminated result，但只能保留一个 authoritative schema path resolver。

不新增第二套 path parser。

---

## 6. Final Internal Model

### 6.1 Schema / path

`PathValue` 的最终分类：

```text
object / variant     -> structured value path
field                -> value path
map                  -> collection path
table                -> collection path
list(keyOf)          -> collection path
tree                 -> value/tree-specific access（本轮不并入 collection）
```

`CollectionPath` 的 entry node：

- map -> map.value；
- table -> table.value；
- list -> list.value；
- list key -> `string`，来自 `keyOf`。

plain field array 仍然是 field/value path。

### 6.2 Document source boundary

Document collection source 保持一个实现：

```text
Document commit
  -> CollectionImpact(selector)
  -> affected stable keys + orderChanged
  -> read only affected entries from current document
  -> compare against source baseline
  -> exact CollectionChange
  -> scheduler capture
```

list 不允许走全量 `beforeArray vs afterArray` diff。

首次 materialize 可以建立完整 baseline；之后普通 item update 必须只触碰受影响 key。move 可以读取 order，但不能重新 snapshot 每个 item value。

source 的 entry equality 由 schema entry node 决定：list 使用 `list.value`，继续复用 `equalValue(...)`。

### 6.3 Group leaf descriptor

group declaration 编译为 private descriptor list：

```ts
type GroupOutputSpec =
  | {
      kind: 'value';
      path: readonly string[];
      isEqual?: (previous: unknown, next: unknown) => boolean;
    }
  | {
      kind: 'collection';
      path: readonly string[];
      isEqual?: (previous: unknown, next: unknown) => boolean;
    };
```

这是内部 compiled representation，不公开导出。

static namespace compiler 只负责：

- 校验 namespace 是静态 plain object tree；
- leaf 必须来自当前 `define` callback；
- leaf 不可复用；
- 记录 leaf path 与 kind；
- 建立 output index；
- hydrate public projections / previous / next / outputs shape。

它不拥有 runtime state。

### 6.4 Group node

内部从 collection-only：

```text
createCollectionGroup
  -> CollectionNode[]
```

收敛为：

```text
createGroup
  -> (ValueNode | CollectionNode)[]
```

一个 group 仍然只有：

- 一组 dependency source records；
- 一个 processor instance；
- 一个 retained `state`；
- 一个 scheduler node；
- N 个 output records；
- N 个 leaf publication states。

不存在 per-leaf processor。

### 6.5 Leaf publication state

collection leaf 继续复用 `CollectionState`。

value leaf 应复用 ordinary value node 的 equality/revision/publish/listener 规则。长期最优实现是把 `value.ts` 里目前内嵌的 staged value publication 状态抽成 private value-state kernel，并让：

- `createValue(...)`；
- `createGroup(...)` 的 value leaf

共同使用。

这只是内部实现 kernel，不增加 public architecture concept，也不导出。

必须避免 group.ts 再手抄一套 value revision/equality/error semantics，否则两条 value spine 会再次漂移。

### 6.6 Atomic seal / publish

group 一次 evaluate 的严格顺序：

```text
1. begin all leaves
2. build borrowed previous/next/output tree
3. run processor once
4. if rebuild requested -> discard staged leaf state and rerun as reset
5. validate every leaf
6. seal every leaf, compute changed output records
7. only after every leaf sealed successfully -> group publish
8. publish all leaves as one generation boundary
9. enqueue downstream consumers of changed leaves only
10. external listeners run after graph settles
```

任何 processor throw、invalid order、missing value initialization 等错误：

- 本次所有 staged changes 都丢弃；
- 没有 leaf 先 publish；
- group fault/recovery 仍由现有 scheduler 统一处理。

### 6.7 Materialization

任意一个 leaf 首次 materialize：

```ts
runtime.get(scene.chrome);
```

仍然 materialize 整个 group。

这样一个 processor 永远只有一个 output generation，不会因为 leaf 被不同时间读取而分裂。

`runtime.get(...)` / `runtime.readable(...)` 不需要新增 group-aware API：

- value leaf 看起来就是普通 `Projection<T>`；
- collection leaf 看起来就是普通 collection projection。

### 6.8 Scope

`scope.incremental.group` 自动继承 mixed leaf 能力。

group ownership 仍然按整个 definition group 生命周期处理：

- scope owns all leaves；
- 任意 leaf materialize -> whole group materialize；
- scope dispose -> whole group retained state + all leaves 一起释放；
- 不允许 root/sibling scope 依赖 scoped leaf。

---

## 7. Structural Rules

以下作为实现不可违反的 invariant。

### Document collection rules

1. Stable identity 只来自 schema；list 必须使用 `keyOf`。
2. 不使用 array index 作为 Projection key。
3. map/table/list 共用 `CollectionSelector`、`CollectionImpact`、`CollectionRead`、`CollectionChange`。
4. list observation 不进行全量数组 diff。
5. entry `before/after` 必须来自真实 committed batch boundaries。
6. transaction 内多次写只发布最终 net transition。
7. pure move 不产生 fake `updated`。
8. value-only item update 不产生 fake order transition。
9. list key-changing replacement继续由 mutation layer 拒绝，Projection 不修复 canonical invalidity。

### Group rules

1. `define.value` 和 `define.collection` 是 leaf kind，不是两个 group runtime。
2. 一个 group 只有一个 processor instance 和一个 retained `state`。
3. 所有 output leaf 同 batch 原子 seal/publish。
4. unchanged leaf 不递增 revision、不通知、不调度其 downstream consumer。
5. initial/reset 时每个 value leaf 必须显式 set。
6. incremental update 未 touched value leaf 保留旧值。
7. value equality 属于 leaf，自定义 equality 不属于整个 group。
8. collection equality 继续是 per-entry equality。
9. borrowed previous/next/output 不能逃逸 processor callback。
10. 不允许 value leaf 通过 singleton collection 模拟。

### Public surface rules

1. 不新增 `observeList` / `observeOrder`。
2. 不新增 `ListChange` / `OrderChange` / `ValueChange`。
3. 不新增 `ValueDraft` public export；builder/processor context 可以通过结构类型推断。
4. 不新增 group runtime、output bus、manual commit。
5. 不新增 compatibility alias。
6. React API 不变。

---

## 8. Change-Surface Ledger

| Addition / change                | Role & owner                      | Lifecycle                   | Replaces / deletes                  | Required consumers               |
| -------------------------------- | --------------------------------- | --------------------------- | ----------------------------------- | -------------------------------- |
| list -> `CollectionPath`         | schema capability                 | schema lifetime             | list-as-value observation           | observe, impact, document source |
| collection compiler accepts list | resolved schema boundary          | selector compilation        | table/map-only check                | impact + projection source       |
| `define.value<T>(equality?)`     | advanced group declaration        | definition lifetime         | singleton collection scalar wrapper | group shape/type compiler        |
| value leaf descriptor kind       | private compiled group metadata   | definition lifetime         | collection-only metadata            | runtime materializer, group node |
| mixed `GroupSpec`                | internal graph processor contract | materialized group lifetime | `CollectionGroupSpec`               | graph/group/scheduler            |
| private value publication kernel | internal derived-state owner      | node/group lifetime         | duplicated inline value leaf logic  | ordinary value node + group      |

没有任何 addition 获得 canonical write authority。

---

## 9. Implementation Plan

### Phase 1 — Schema collection identity 收敛

修改 schema/path 层，先修最低边界：

- `PathValue<ListNode<...>>` 变成 `CollectionPath`；
- list collection key 类型固定为 `string`；
- entry node/value 正确指向 `list.value`；
- `pathProxy` 的 collection/member addressing 支持 list；
- `compilePath(..., 'collection')` 接受 map/table/list；
- `CollectionPath` / `CollectionId` / `CollectionNode` 类型推断覆盖 list；
- 增加 compile-time inference tests。

同时把 document observation 的 selector kind 判定收敛为 schema compiler 的 discriminated result，删除“先尝试 collection、catch 后回退 value”的异常控制流。

完成这一 phase 后，不应该还存在第二个判断“list 是否 collection”的地方。

### Phase 2 — Document source 支持 list

在现有 document collection source 上扩展 list：

- entry schema extraction 覆盖 list；
- baseline/value snapshot 使用 stable list key；
- `CollectionImpact` added/removed/updated/orderChanged 直接驱动 change derivation；
- move 只处理 order；
- item update 只 snapshot 受影响 key；
- insert/remove 不扫描全部 item value；
- reset 才允许完整 rebuild baseline。

不要创建 `list-source.ts`。

### Phase 3 — Public group type model 扩展

先改纯 definition/type 层：

- group descriptor 从 collection-only 改成 discriminated leaf；
- builder 增加 `define.value<T>(equality?)`；
- `GroupProjections` 支持 value leaf -> `Projection<T>`；
- `GroupReads` 支持 value leaf -> `T | undefined`；
- `GroupDrafts` 支持 value leaf -> `{ set(value: T): void }`；
- nested namespace compiler 同时接受两类 leaf；
- descriptor metadata 记录 `kind`；
- `IncrementalGroupDefinition` 不再把 projections 声明成 collection-only。

这一 phase 不引入 public `ValueChange`。

### Phase 4 — 抽取统一 value publication kernel

把 ordinary `createValue` 中以下事实收进一个 private value state owner：

- published value；
- staged next value；
- initialized sentinel；
- equality；
- revision；
- reset；
- listeners；
- begin/seal/publish/clear/release。

`createValue` 改为组合该 kernel。

先证明 standalone value node 行为完全不变，再让 group value leaf 复用它。

不要让 group.ts 自己维护第二套 scalar revision rules。

### Phase 5 — `CollectionGroup` -> mixed `Group`

重构内部 group boundary：

- `CollectionGroupSpec` -> `GroupSpec`；
- `createCollectionGroup` -> `createGroup`；
- 为每个 descriptor 创建对应 value/collection state；
- `previous/next/outputs` hydrate mixed tree；
- reset 时校验所有 value leaf 已显式初始化；
- seal 所有 leaves 后才允许 publish；
- `changedOutputs` 只返回真实变化 leaf；
- 返回 mixed `ValueNode | CollectionNode` handles；
- diagnostics 使用 output path，保留足够 identity，但不增加公开 name API。

### Phase 6 — Runtime materialization / scope 收敛

更新：

- group materialized node array 改成 mixed runtime node；
- `incremental-group-output` 根据 compiled leaf kind 注册正确 node handle；
- `runtime.get` / `readable` 继续走 ordinary value/collection logic；
- scope output tree ownership 同时识别 value leaf；
- group dispose 释放所有 mixed leaf states；
- downstream group/derive 可以直接依赖 value leaf。

不增加：

- `runtime.getGroup`；
- `runtime.subscribeGroup`；
- `runtime.commitGroup`。

### Phase 7 — 删除 wrapper 与旧命名

仓库和下游 in-scope code 全量搜索并删除：

- singleton collection scalar wrappers；
- fake `'scene'` key；
- `SceneFrame` 仅为承载多个 scalar 而存在的 collection；
- collection -> background/chrome/overlay/revision 的 derive glue；
- `CollectionGroupSpec`；
- `createCollectionGroup`；
- collection-only group metadata types；
- 任何新增过程中产生的临时 adapter/alias。

scene 最终应该直接暴露：

```text
scene.graph        collection
scene.background   value
scene.chrome       value
scene.overlay      value
scene.revision     value
```

### Phase 8 — Documentation surface

更新：

- `README.md`；
- `docs/projections.md`；
- `docs/architecture.md`（若涉及内部 graph/group ownership 描述）；
- `skills/doxum-runtime/references/projections.en.md`；
- `skills/doxum-runtime/references/projections.zh-CN.md`。

示例只展示最终 API，不展示兼容写法。

---

## 10. Test Plan

### 10.1 Keyed list observation

必须覆盖：

1. `observe(document, p => p.list)` 的类型推断为 keyed collection；
2. 初始 materialization；
3. `runtime.get` 的 iteration order 与 list order 一致；
4. item replace -> `updated { before, after }`；
5. insert -> `added`；
6. remove -> `removed`；
7. move -> `order.before/order.after`，且没有 fake updated；
8. insert + move / remove + move 的净 transition；
9. transaction 内多次操作 coalesce 成最终 change；
10. unrelated document commit 不触发 list processor；
11. `runtime.readable(list, x => x.get(id))` 不因另一个 id 更新而执行 selector；
12. React `useProjection(list, x => x.get(id))` 同样保持 keyed invalidation；
13. `path.list.item(id)` value addressing；
14. ordinary `field<Item[]>()` 仍然是 value observation；
15. list item key-changing replace 仍由 mutation layer 拒绝。

### 10.2 Performance regressions

大 list 场景必须证明：

- 单 item value update 不扫描所有 item；
- unrelated update 不建立 collection snapshot；
- pure move 不 snapshot 所有 item values；
- insert/remove 不因 `CollectionChange.order` 强制复制 before/after 全量 order；
- keyed selector 不因 sibling key change 执行。

### 10.3 Mixed group

必须覆盖：

1. collection + value leaf 同组初始 build；
2. nested namespace 混合 leaf；
3. initial value leaf 漏 `set` -> whole group fail；
4. `define.value<T | undefined>` 显式 `set(undefined)` 被视为已初始化；
5. incremental update 未触碰 value leaf -> 保持旧值；
6. equality 相等 -> value leaf revision/listener/downstream 不变化；
7. 一个 value leaf changed、另一个 unchanged；
8. collection changed + value changed 同 causal batch 下游只 settle 一次；
9. downstream `derive` 直接依赖 group value leaf；
10. downstream `incremental.group` 直接依赖 mixed upstream leaves；
11. processor throw -> 所有 output 不产生半提交；
12. rebuild -> all leaves 同一 reset generation；
13. invalid collection order -> value leaf 也不 publish；
14. scope ownership/dispose；
15. 首次读取任意 leaf -> whole group 只 build 一次；
16. listener ordering：processors settle before external listeners；
17. fault recovery 后所有 leaves 回到同一 generation boundary。

---

## 11. Performance Model

目标复杂度：

### List source

| Operation           | Expected work                                                              |
| ------------------- | -------------------------------------------------------------------------- |
| initial materialize | O(n) baseline build                                                        |
| update one item     | O(affected keys) item snapshot/equality                                    |
| insert/remove       | O(affected keys) values；order work 由 document ordered structure 自身决定 |
| move                | O(order transition)，不重读所有 item values                                |
| unrelated commit    | O(impact match)，不运行 downstream processor                               |

不能退化成：

```text
every document commit -> snapshot whole list -> diff whole list
```

### Group

一次 source causal batch：

- processor 只执行一次；
- 每个 collection leaf 成本与 touched keys 成正比；
- 每个 value leaf seal 为 O(1) + equality cost；
- downstream 只从 changed output records enqueue；
- listener 只对 changed leaves emit。

---

## 12. Explicit Non-Goals

本轮不做：

- tree 自动视作 linear collection；
- arbitrary array field 自动 keyed；
- index-based observation；
- list-specific runtime；
- group dynamic output names；
- runtime 中途新增/删除 group leaf；
- per-leaf processor；
- async processor；
- value change event protocol；
- compatibility overload。

tree 具有 parent/children topology，不应仅因为也有 ids 就被误塞进 linear `CollectionRead.ids()` 语义；未来若需要 tree incremental observation，应从 tree domain 自己的稳定结构语义出发设计。

---

## 13. Final Concept Surface

这次完成后，不需要给 Projection 用户新增新的核心名词。

### Public

- `Projection`
- `Input`
- `ProjectionRuntime` / scope
- `Readable`
- `CollectionChange`
- `incremental`
  - `incremental(...)`
  - `incremental.collection(...)`
  - `incremental.group(...)`
  - `define.collection(...)`
  - `define.value(...)`

`define.value` 是 group declaration capability，不是新的 runtime concept。

### Internal architectural spine

- schema path / selector
- source boundary
- value node
- collection node
- group node
- scheduler
- collection read/draft
- private value/collection publication state kernels

不再需要：

- list projection；
- order projection；
- singleton collection；
- scalar collection wrapper；
- value event/change；
- collection-only group runtime。

---

## 14. Completion Criteria

只有全部满足才算完成：

- [x] `observe(document, p => p.list)` 原生得到 keyed collection projection；
- [x] list identity 100% 来自 schema `keyOf`；
- [x] map/table/list 共用一个 `CollectionSelector -> CollectionChange` 流程；
- [x] list update 不做 whole-list value diff；
- [x] keyed selector 对 sibling item update 不执行；
- [x] `define.value<T>(equality?)` 可与 collection leaf 任意嵌套组合；
- [x] initial/reset value leaf 必须显式初始化；
- [x] unchanged scalar leaf 不 publish；
- [x] mixed leaves 原子提交；
- [x] processor failure 不产生半提交；
- [x] scope 可以完整释放 mixed group；
- [x] singleton collection wrapper 和 fake scalar key 全部删除；
- [x] `CollectionGroupSpec` / `createCollectionGroup` 等 collection-only 内部协议全部删除；
- [x] 没有 `ListChange` / `ValueChange` / compatibility alias；
- [x] README、projection docs、skill references 全部只描述最终 API；
- [x] repository search 不存在旧协议活跃引用；
- [x] `pnpm run check` 通过；
- [x] projection / collection 相关 bench 或 profile 无明显增量回归。

最终判断标准不是“两个 API 能用了”，而是：

> document keyed containers 只剩一个 collection boundary；processor 多输出只剩一个 group ownership model；value 和 collection 的区别只存在于 leaf publication semantics，不再制造额外架构层。
