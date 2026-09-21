# Keyed Composition：`derive.keyed.from` 与 `derive.keyed.merge` 设计与实施方案

> 状态：已实施并验证  
> 目标版本：`0.1.30` 之后的下一轮 Projection API 演进  
> 范围：`doxum` root projection API、Core 内部 keyed composition owner、测试/基准、README/docs、`skills/doxum-runtime`

## 1. 结论

这一轮只新增两个正式 primitive：

```ts
derive.keyed.from(...)
derive.keyed.merge(...)
```

不新增 `union` / `overlay` 别名，不把能力放入 `doxum/advanced`，也不增加第二套 keyed diff、缓存或依赖协议。

两者分别补齐 keyed projection algebra 中两个缺失的形状：

```text
ordered scalar/static values
        │
        ▼
derive.keyed.from
        │
        ▼
KeyedProjection<K, V>

KeyedProjection<K, V> × N
        │
        ▼
derive.keyed.merge
        │
        ▼
KeyedProjection<K, V>
```

再与现有 primitive 组合：

```text
scalar V | undefined ── singleton ──▶ 0/1 keyed
readonly V[]         ── from      ──▶ N keyed
N keyed sources      ── merge     ──▶ 1 keyed
keyed                ── get       ──▶ scalar selected value
keyed                ── subset    ──▶ externally ordered keyed subset
keyed                ── groupBy   ──▶ reverse index
```

内部新增一个明确 owner：

```text
core/src/projection/keyed/composition.ts
```

它负责“不是由一个 keyed driver 独占 output membership/order”的 keyed composition：

- `from`：scalar/static ordered values → keyed；
- `merge`：multiple keyed → keyed；
- 将现有 `singleton` 一并迁入该 owner，形成完整的 collection construction/composition 边界。

`projection/keyed/transform.ts` 继续只拥有“一个 keyed driver 决定 output membership/order”的生命周期，不扩展成 generic composition framework。

所有最终 publication 继续只由现有 `CollectionOutput` 负责：exact `CollectionChange`、per-entry equality、order、revision、stable published state 都不增加第二个 owner。

---

## 2. 设计目标

### 2.1 `from`

正式解决：

```text
Projection<readonly V[]> / static readonly V[]
        ↓ keyOf(value)
KeyedProjection<K, V>
```

必须满足：

- array formal order 就是 keyed formal order；
- `keyOf` 产生唯一 string key；
- duplicate key 是明确错误，不做覆盖或去重；
- ordinary update 中 same key + equality-equivalent value 不发布 `updated`，且继续保留已发布 value identity；
- reorder-only 只产生正式 order 变化，不伪造 value update；
- 定义保持 lazy/reusable；
- static array 不因调用方之后修改外层数组而改变 definition 语义。

### 2.2 `merge`

正式解决：

```text
[S0, S1, ... Sn] where Si: KeyedProjection<K, V>
        ↓
membership union + explicit value conflict policy + deterministic formal order
        ↓
KeyedProjection<K, V>
```

必须满足：

- membership 是所有 source membership 的 union；
- value conflict policy 必须显式；
- formal order 只有一条标准规则；
- add/remove/update/order/reset 均通过现有 projection graph 增量传播；
- value-only change 只重新计算受影响 key，不扫描所有 source ids；
- structural/order change 可以重建正式 merged order，但不重新计算无关 value；
- winner/contribution 改变时，只要 merged key 仍存在，就保持同一个 merged membership lifecycle；
- 应用层不再维护 `Set` / `Map` / affected keys / `output.order()`。

---

## 3. 明确不做的事情

这一轮不做：

- 不增加 `derive.keyed.union`；
- 不增加 `derive.keyed.overlay`；
- 不给 `merge` 增加可配置 order policy；
- 不允许 `merge` 直接混收 `Map`、array、object、entries 等静态形状；这些先经 `from` / `singleton` 转成 `KeyedProjection`；
- 不允许 Runtime 中动态改变 merge 的 source 列表或 source priority；producer dependencies 仍然是 definition-time static DAG；
- 不做 heterogeneous-source generic aggregation framework；P0 只处理共同 `K, V`；
- 不在 resolver 内支持 imperative `runtime.read()` dependency discovery；
- 不建立持久 `key -> winner source`、`key -> source bitset` 等第二份 derived truth；先用当前 source reads 作为唯一语义依据；
- 不把 `from` / `merge` 实现成 `incremental.collection` 的公开包装；它们属于 root `derive.keyed` family。

---

## 4. 最终公共 API

### 4.1 `derive.keyed.from`

最终建议采用两个 overload，共享同一行为：

```ts
derive.keyed.from<K extends string, V>(
  source: Projection<readonly V[]>,
  keyOf: (value: NoInfer<V>) => Synchronous<K>,
  equality?: (previous: V, next: V) => boolean
): KeyedProjection<K, V>;

derive.keyed.from<K extends string, V>(
  source: readonly V[],
  keyOf: (value: NoInfer<V>) => Synchronous<K>,
  equality?: (previous: V, next: V) => boolean
): KeyedProjection<K, V>;
```

不向 `keyOf` 传 `index`。

原因：key 是 member identity。允许 index 参与 key 计算会鼓励 order-dependent identity，使 reorder 变成 remove/add，破坏 keyed primitive 的核心语义。确实需要 index key 的调用方应先把稳定 id 建进 value。

`equality` 默认 `Object.is`，语义是“同 key 的 output value 是否真的变化”。

### 4.2 `derive.keyed.merge`

最终 API 只保留 `merge`，source list 是固定 definition-time source order：

```ts
derive.keyed.merge<K extends string, V>(
  sources: readonly KeyedProjection<K, V>[],
  options:
    | {
        readonly conflict: 'error' | 'first' | 'last';
        readonly equality?: (previous: V, next: V) => boolean;
      }
    | {
        readonly conflict: 'resolve';
        readonly resolve: (
          contributions: readonly {
            readonly sourceIndex: number;
            readonly value: V;
          }[],
          key: NoInfer<K>
        ) => Synchronous<V>;
        readonly equality?: (previous: V, next: V) => boolean;
      }
): KeyedProjection<K, V>;
```

`conflict` 没有默认值。即使当前业务认为 sources 不重叠，也必须明确选择 `error` / `first` / `last` / `resolve`。

推荐调用：

```ts
const synthetic = derive.keyed.from([{ id: 'title', kind: 'title' }], field => field.id);

const fields = derive.keyed.merge([synthetic, dataFields], {
  conflict: 'error',
});
```

overlay 场景：

```ts
const effective = derive.keyed.merge([base, overrides], {
  conflict: 'last',
});
```

真正需要聚合冲突值时：

```ts
const effective = derive.keyed.merge(sources, {
  conflict: 'resolve',
  resolve: (contributions, key) => resolveConflict(key, contributions),
  equality: domainEqual,
});
```

### 4.3 为什么不提供 `union` / `overlay`

这两个名字把某一种 policy 固化到了 API 名上：

- `union` 容易暗示“不会重叠”或“值不重要”；
- `overlay` 天然暗示 later source wins；
- 最终还会出现 `merge` / `union` / `overlay` 三套几乎重复的 surface。

`merge(..., { conflict: ... })` 已经完整表达所有 P0 语义，并且 conflict policy 在 call site 可见。

如未来大量代码稳定重复 `conflict: 'last'`，可以基于真实使用数据再决定是否增加 convenience API；当前不预埋别名。

---

## 5. `derive.keyed.from` 正式语义

令输入 array 为：

```text
A = [v0, v1, ... vn]
ki = keyOf(vi)
```

要求所有 `ki` 唯一且为 string。

则输出：

```text
membership = { k0, k1, ... kn }
formal order = [k0, k1, ... kn]
value(ki) = vi
```

### 5.1 Duplicate key

duplicate 是 processor evaluation error：

```text
keyOf(v0) = x
keyOf(v1) = x
=> invalid keyed construction
```

不做：

- first wins；
- last wins；
- silent dedupe；
- 自动把 index 拼入 key。

错误必须在该次 evaluation 中阻止任何 publication。已 materialize 的 projection 保持上一次正式 publication；错误进入现有 Projection processor failure/recovery 路径。

### 5.2 Static input ownership

对于：

```ts
derive.keyed.from(staticValues, keyOf);
```

在 definition 创建时 snapshot 外层 array：

- 已冻结 array 可以复用；
- 普通 readonly array 复制并冻结；
- 元素本身不 clone；
- `keyOf` 不在 declaration 阶段执行，仍在 lazy materialization 时执行。

这样 definition 可跨 Runtime 复用，且调用方之后对原 array 的 push/reorder 不会改变 definition。

### 5.3 Projection input

对于：

```ts
Projection<readonly V[]>;
```

每次该 scalar projection 正式变化时必须扫描当前完整 array。

这是形状转换的固有成本：scalar source 没有 per-entry `CollectionChange`，无法知道哪些元素变化。

因此：

- `from` 每次 scalar update 是 O(n) key scan；
- 输出仍发布 exact keyed delta；
- 如果业务需要高频单-key edit，应直接使用 `KeyedProjection` / `input.collection`，而不是先聚合成 scalar array 再 `from`。

### 5.4 Equality 与 identity

对同一个 key：

```text
equality(previousPublishedValue, nextValue) === true
```

则：

- 不发布 `updated`；
- 不替换 `CollectionOutput` 中已发布 value；
- 保留 previous published identity。

因此 array 自身 identity 改变、甚至其中 value object 是新对象，都可以通过显式 equality 折叠为 no-op。

reorder-only：

- 所有 key/value 仍 equality-equivalent；
- 只改变 formal order；
- `CollectionChange` 不伪造 `updated`。

### 5.5 Present `undefined`

如果 `V` 本身包含 `undefined`，它仍是合法 present value。membership 只由 array/keyOf 决定，不以 `value !== undefined` 判断存在性。

---

## 6. `derive.keyed.merge` 正式语义

设固定 sources：

```text
S = [S0, S1, ... Sn]
```

source list 顺序在 definition 创建时固定并 snapshot；它同时定义：

- `first` / `last` conflict 的 source order；
- merged formal order 的拼接顺序；
- resolver `sourceIndex`。

Runtime 中 source 数量或 source list 顺序不动态变化。

### 6.1 Membership

```text
M = union(membership(S0), membership(S1), ... membership(Sn))
```

即：

```text
merged.has(k) ⇔ ∃ i: Si.has(k)
```

必须使用 `has(k)` 判断 contribution 存在；不能使用 `get(k) !== undefined`，因为 present `undefined` 是合法值。

### 6.2 Formal order

正式 order 固定为：

```text
stableUnique(
  S0.ids()
  ++ S1.ids()
  ++ ...
  ++ Sn.ids()
)
```

示例：

```text
S0 = [a, c]
S1 = [b, a, d]
S2 = [c, e]

merged order = [a, c, b, d, e]
```

重复 key 永远只占“第一次正式出现”的位置。

这条位置语义与 value conflict policy 完全正交。

例如 `conflict: 'last'` 时：

```text
a 的位置仍来自 S0 的第一次出现
a 的 value 可以来自 S1
```

不提供 winner-position / last-position / custom-order policy。

如果调用方需要另一种输出顺序，应在 composition 之后通过现有 order primitive（例如 `subset` + ordered keys projection）表达，而不是扩张 `merge`。

### 6.3 Contribution model

某个 key 的当前 contributions：

```text
C(k) = [
  { sourceIndex: i, value: Si.get(k) }
  for every i where Si.has(k)
]
```

严格按 source list 顺序排列。

### 6.4 `conflict: 'error'`

```text
|C(k)| = 0 => absent
|C(k)| = 1 => pass through the only value
|C(k)| > 1 => processor error
```

这是“不允许 source overlap”的正式 policy。

冲突在已 materialize 后出现时：

- 当前 evaluation 不 publish；
- 上一次 merged publication 保持不变；
- 使用现有 ProjectionError / processor recovery；
- 后续 source 恢复到无冲突状态后，通过 reset recovery 重建。

### 6.5 `conflict: 'first'`

取最小 `sourceIndex` 的 contribution。

### 6.6 `conflict: 'last'`

取最大 `sourceIndex` 的 contribution。

### 6.7 `conflict: 'resolve'`

只有真实冲突（`|C(k)| > 1`）才调用 resolver。

如果只有一个 contribution，直接复用该 source value，不调用 resolver。

这是刻意设计：`merge` 只负责 union + conflict resolution，不顺便成为 value transform primitive。

如果调用方要对所有 merged values 做转换，应组合：

```ts
const merged = derive.keyed.merge(...);
const transformed = derive.keyed(merged, value => transform(value));
```

resolver：

- 同步；
- key-local；
- 只能看到该 key 的 current contributions；
- contributions 按 source order；
- 不进行 imperative Runtime read；
- 可以返回任意 `V`，也可以 throw；
- 返回 Promise/thenable 按现有 synchronous processor rule 拒绝。

### 6.8 Membership lifecycle

只要 union membership 中 key 持续存在，就保持同一个 merged membership lifecycle。

例如：

```text
before: key k only in S0
after:  key k removed from S0 but still in S1
```

merged 语义是：

- membership 不 remove/re-add；
- value 根据 conflict policy fallback/recompute；
- 如果 value 变化，发布 `updated`；
- `runtime.items(merged).get(k)` 的当前 membership identity 不应因为 winner 切换而被重建。

只有所有 source 都不再含 `k` 时才发布真正的 merged remove。

### 6.9 Equality

`options.equality` 比较最终 effective merged value，默认 `Object.is`。

因此：

- shadowed source update 可以被完全折叠；
- winner 切换但两个 value equality-equivalent 时不发布 `updated`；
- resolver 返回新对象时可以用 domain equality 保留 previous published identity。

---

## 7. 增量传播规则

### 7.1 Value-only source update

若 source change 只有 `updated`：

1. 收集 changed keys；
2. 每个 key 只重新计算一次 effective merged value；
3. 不扫描任何 source `ids()`；
4. 不重建 merged order；
5. 最终是否发布 `updated` 由 `CollectionOutput` equality 决定。

复杂度：

```text
O(affectedKeys × sourceCount)
```

source 数量通常远小于 collection size，这比维护第二份 winner/reverse index 更简单可靠。

### 7.2 Add/remove

对 added/removed key：

- 重新计算该 key union membership / effective value；
- merged key 可能 added、updated、removed 或 no-op；
- 因为“第一次正式出现”可能变化，标记 `orderDirty`；
- 本轮结束时重建一次 merged formal order。

### 7.3 Source reorder

source 的 order-only change：

- 不重新计算任何 merged value；
- 只重建 merged formal order；
- `CollectionOutput` 自己判断 common-member order 是否真的改变；
- 如果重建后的 order 等价，不发布无意义 order change。

### 7.4 Reset / processor recovery

任何 dependency reset，或 processor fault recovery：

- 从 current source reads 完整重建；
- 不信任旧 winner/cache；
- 最终以 `CollectionOutput` reset semantics publish。

---

## 8. 内部架构

### 8.1 新 owner

新增：

```text
core/src/projection/keyed/composition.ts
```

建议只导出内部 factory：

```ts
createKeyedFrom;
createKeyedMerge;
createKeyedSingleton;
```

不把它做成公共 barrel，也不增加 generic composition manager/class。

`core/src/projection/derive/keyed.ts` 继续是 public `derive.keyed` family assembly owner：

```ts
export const keyedDerive = Object.assign(createKeyedDerive, {
  keys,
  values,
  entries,
  get,
  from,
  merge,
  groupBy,
  singleton,
  subset,
  filter,
  compact,
});
```

现有 `createKeyedSingleton` 从 `derive/keyed.ts` 移入 `keyed/composition.ts`，不改变公开行为。

### 8.2 Owner 保持清晰

最终 owner 应是：

| Concern                                    | Owner                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| lazy Projection definition / static DAG    | `projection/definition.ts`                                      |
| one keyed driver lifecycle                 | `projection/keyed/transform.ts`                                 |
| dynamic keyed dependency binding           | `projection/keyed/dependency.ts`                                |
| forward/reverse keyed relation             | `projection/keyed/relation.ts`                                  |
| scalar/static/keyed collection composition | `projection/keyed/composition.ts`                               |
| reverse index `groupBy`                    | 当前 `projection/derive/keyed.ts`，未来有真实复杂度再独立 owner |
| exact staged/published keyed output        | `projection/output/collection.ts`                               |
| scheduling/recovery/publication ordering   | `projection/graph/*`                                            |

不在 composition module 内保存第二份 published keyed state。

### 8.3 `CollectionOutput` 不修改公共协议

当前 `CollectionOutput` 已经拥有：

- `set/remove/order` staging；
- per-entry equality；
- stable published values；
- exact add/update/remove；
- exact common-member reorder；
- reset；
- publication revision。

`from` / `merge` 只负责计算本轮 semantic intent，并调用现有 output draft。

不新增：

- merge-specific `CollectionChange`；
- merge-specific published Map；
- application-visible winner cache；
- 手工 revision/publication protocol。

### 8.4 Change-surface ledger

这一轮允许新增的永久概念只有下面这些；实施时不得为了局部方便再长出第二套 helper、cache、policy 或 compatibility surface。

| Addition                             | Role / owner                                                                                                                             | Lifecycle                                                           | Replaces / deletes                                                                               | Required consumers                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `derive.keyed.from`                  | public keyed construction primitive；surface owner 为 `projection/derive/keyed.ts`，实现 owner 为 `projection/keyed/composition.ts`      | lazy definition，可跨 Runtime materialize                           | 替代业务层 `scalar array -> incremental.collection` 手工 reconciliation；不保留同义 public alias | Dataview/Whiteboard/应用 keyed composition 调用方，README/docs/skill/public fixtures |
| `derive.keyed.merge`                 | public multi-keyed composition primitive；surface owner 为 `projection/derive/keyed.ts`，实现 owner 为 `projection/keyed/composition.ts` | lazy definition；固定 source DAG，每个 Runtime 独立 materialization | 替代业务层 `Set + Map + affected keys + output.order()` 合并协议；不新增 `union` / `overlay`     | 所有多 keyed source composition 调用方，README/docs/skill/public fixtures            |
| `projection/keyed/composition.ts`    | keyed construction/composition 内部 owner                                                                                                | module lifetime；不持有跨 Runtime 全局状态                          | 从 `derive/keyed.ts` 移走 `createKeyedSingleton`，并承载 `from` / `merge` factory                | `derive/keyed.ts` family assembly                                                    |
| `derive.keyed` skill inventory guard | tooling owner 为 `scripts/check-runtime-skill.mjs`                                                                                       | CI/check-time                                                       | 删除当前“nested family 可静默漂移”的检查盲区                                                     | `skills/doxum-runtime/references/public-api.md`、`pnpm run check`                    |

刻意不新增永久类型：

- 不公开 `MergePolicy` / `MergeContribution` 等仅服务一个调用点的命名类型；优先让 discriminated options 保持在 `merge` 签名附近；
- 不新增 `KeyedCompositionRuntime` / manager / cache class；Runtime owner 仍是现有 projection graph/materialization；
- 不新增新的 collection diff/result 表示；继续只使用 `CollectionChange` 与 `CollectionOutput`。

### 8.5 替换与删除关系

实施完成后的最终结构必须满足：

1. `createKeyedSingleton` 的实现只存在于 `projection/keyed/composition.ts`，`derive/keyed.ts` 只负责 public family assembly 与仍属于该文件的 keyed primitives；
2. `from` / `merge` 不通过 `incremental.collection` 暴露一层 wrapper，也不保留 prototype/helper 版本；
3. 不引入 `union`、`overlay`、`mergeFirst`、`mergeLast` 等同义入口；
4. 不保留第二份 winner、membership、merged order 或 published value mirror；
5. Skill 文档加入 `derive.keyed` family inventory 后，checker 必须双向验证“实现有而 skill 没写”和“skill 写了但实现不存在”两种漂移；
6. 全部 public fixtures、README、docs、skills 直接使用最终 `from` / `merge` API，不保留迁移示例或兼容调用方式。

这轮没有需要兼容保留的旧 public API：`from` / `merge` 是新增能力，`singleton` 只是内部 owner 迁移，公开签名与行为保持不变。

---

## 9. `from` 内部算法

### 9.1 Definition compile

创建 definition 时：

1. 如果 `source` 是 Projection：确认它是 scalar output；dependencies = `[source]`；
2. 如果是 static readonly array：snapshot/freeze 外层 array；dependencies = `[]`；
3. 保存 `keyOf` 与 equality；
4. 不执行 `keyOf`；
5. 输出定义为一个 collection output。

### 9.2 Evaluation

概念流程：

```text
values = current scalar array or captured static array
seen = Set<K>
order = K[values.length]

for each value in values in array order:
    key = keyOf(value)
    assert synchronous
    assert typeof key === 'string'
    reject duplicate key
    seen.add(key)
    order.push(key)
    output.set(key, value)

for previousKey of output.previous.ids():
    if !seen.has(previousKey):
        output.remove(previousKey)

output.order(order)
```

依赖现有 staged output 保证：

- `keyOf` 中途 throw；
- duplicate；
- output equality throw；

都不会形成 partial publication。

不需要 retained Map。

### 9.3 Allocation

每次 dynamic scalar array evaluation 必需：

- 一个 duplicate/membership `Set<K>`；
- 一个最终 order array。

这两个容器有真实算法职责，不为了追求表面 zero-allocation 换成 O(n²) 查重或重复扫描。

---

## 10. `merge` 内部算法

### 10.1 Definition compile

1. snapshot source projection array，固定 source order；
2. 每个 source 必须是 keyed collection output；
3. 解析并冻结 conflict policy，不保留可变 options bag；
4. `conflict: 'resolve'` 必须有同步 resolver function；其他 policy 不允许 resolver；
5. equality 默认 `Object.is`；
6. dependencies 就是固定 sources。

允许空 source array：其正式结果是稳定 empty keyed projection。这样 generic composition 有自然 identity；类型无法推导时调用方需要显式 `K,V`。

单 source 也合法，但不做“直接返回 source”的 identity shortcut，因为：

- custom equality 属于 merge output；
- scope ownership / producer identity 应保持正常；
- 避免 source count 改变时 API 行为分叉。

### 10.2 Processor instance state

只保留：

```text
sourceRevisions: number[sourceCount]
```

用于判断本次 evaluation 哪些 source 真正变化。

不持久保存：

- winnerByKey；
- membershipBySource；
- mergedOrder index；
- key -> contributing sources；
- output value mirror。

current source reads + `CollectionOutput.previous` 是权威事实。

### 10.3 Incremental affected-key collection

对 revision 变化的每个 source：

- `reset` / unavailable exact change → full rebuild；
- `added` / `updated` / `removed` keys 加入 evaluation-local `affected` Set；
- added/remove/order → `orderDirty = true`；
- order-only 不加入 affected keys。

必须始终执行每个 source 的 change processing，再单独 OR boolean flag；禁止写有副作用的：

```ts
orderDirty ||= processSource(...)
```

避免重现此前 `groupBy` 因 `||=` 短路而漏处理同一 commit 后续 member 的问题。

### 10.4 单 key effective value

`first` / `last` / `error` 都可以一遍 source scan 完成，不分配 contribution array。

`resolve` 使用 lazy allocation：

1. 第一个 contribution 只保存在局部变量；
2. 第二个出现时才创建 contributions array；
3. 后续 append；
4. 只有真实 conflict 才调用 resolver。

因此常见无冲突 key 不为 resolver 模式额外分配数组。

### 10.5 Full rebuild

reset/recovery 不建议采用：

```text
for every unique key:
    scan all sources
```

因为会退化到 `O(uniqueKeys × sourceCount)`。

完整 rebuild 应以 source order 单次扫描为主：

```text
seen = Set<K>
order = []
duplicates = Set<K> only when resolver policy needs it

for source i in source order:
    for key in source.ids():
        if first occurrence:
            seen.add(key)
            order.push(key)

        first policy:
            output.set only on first occurrence

        last policy:
            output.set on every occurrence; staging Map naturally retains last

        error policy:
            throw on second occurrence

        resolve policy:
            output.set raw value on first occurrence
            mark key duplicate on second/later occurrence

for duplicate key under resolve:
    recompute that key's contributions and output.set(resolved)

remove previous keys not in seen when this is a defensive non-reset full reconcile
output.order(order)
```

复杂度：

```text
O(total source memberships + conflictingKeys × sourceCount)
```

### 10.6 Order-only / structural order rebuild

当 `orderDirty`：

```text
seen = Set<K>
order = []
for source in source order:
    for key of source.ids():
        if unseen:
            seen.add(key)
            order.push(key)
output.order(order)
```

这是正式 sequence 语义，本来就需要建立新的 order snapshot。

不为了把该路径包装成“局部更新”而引入复杂 order tree。

---

## 11. 复杂度与性能边界

### `from`

| 场景                           | 复杂度                     |
| ------------------------------ | -------------------------- |
| static initial materialization | O(n)                       |
| scalar array ordinary update   | O(n)                       |
| reorder-only                   | O(n)，最终只 publish order |
| duplicate validation           | O(n) expected，使用 Set    |

scalar input 没有 entry delta，因此 O(n) 是正式能力边界，不视为实现缺陷。

### `merge`

设 source 数量 S，总 source membership occurrence 数 M，单次 affected merged keys 数 A。

| 场景               | 复杂度                                     |
| ------------------ | ------------------------------------------ |
| value-only update  | O(A × S)，不扫描 ids                       |
| add/remove         | O(A × S + M)（value 增量 + order rebuild） |
| order-only         | O(M)，不重新计算 values                    |
| reset/full rebuild | O(M + conflicts × S)                       |

持久附加内存仅 O(S) revisions；其余 Set/array 是 evaluation-local。

只有 benchmark 证明大量 source（几十/上百）导致 `A × S` 成为真实瓶颈后，才在 composition owner 内考虑 winner/contribution index；不得提前把它变成第二份 derived state 协议。

---

## 12. 测试方案

建议新增专用：

```text
core/test/projection-composition.test.ts
```

不要继续把全部 composition 行为塞入已经很大的 `projection-keyed.test.ts`。

### 12.1 `from` 行为矩阵

必须覆盖：

1. static readonly array → keyed，formal order 正确；
2. `Projection<readonly V[]>` → keyed；
3. static 外层 array 在 definition 创建后被调用方修改，projection 不受影响；
4. reorder-only：只改变 order；
5. same key value update：只发布该 key `updated`；
6. custom equality：新 object 但 equality-equivalent，不发布 update、保留 previous identity；
7. key change：旧 key removed、新 key added；
8. membership add/remove；
9. initial duplicate key 明确失败；
10. 已 materialize 后 duplicate 出现，不产生 partial publication；
11. 后续恢复为合法 array 后按标准 processor recovery 重建；
12. `keyOf` throw / non-string / Promise-like 返回；
13. present `undefined` value；
14. `__proto__` / `constructor` 等特殊 string key；
15. scope ownership/disposal；
16. 多 Runtime 复用同一个 static definition。

### 12.2 `merge` 行为矩阵

必须覆盖：

1. 0 source → empty；
2. 1 source → 同 membership/order/value；
3. 多 source union membership；
4. `error` 无冲突正常；
5. `error` initial conflict；
6. `error` 已 materialize 后引入 conflict：last good publication 保留；
7. conflict 后解除可 recovery；
8. `first`；
9. `last`；
10. `resolve` 收到按 source order 排列且含 `sourceIndex` 的 contributions；
11. unique key 不调用 resolver；
12. resolver throw / Promise-like；
13. formal order = stableUnique(source-order concatenation)；
14. value winner 与 formal position 正交；
15. earlier source 新增已有 key，可移动 merged formal position；
16. earlier source 删除但 later source 仍有 key：membership 不断开，只 fallback value/order；
17. source reorder-only：不调用 resolver/不发布 value update；
18. shadowed source value update在 `first` 下不产生最终 update；
19. `last` winner update；
20. custom equality 折叠 winner switch；
21. 同一 Runtime batch 多 source 同 key 同时变化，只根据最终 current reads 计算一次；
22. 同一 batch 多个不同 key 同时变化，全部处理，不出现 boolean short-circuit 漏项；
23. source reset；
24. present `undefined` contribution；
25. `runtime.items(merged)` 在 winner switch 但 membership 持续时保持 item lifecycle；
26. unrelated merged key value/reference 不变；
27. scope ownership/disposal。

### 12.3 Public types / portability

更新：

```text
fixtures/public-api.ts
fixtures/declaration-portability.ts
```

至少导出/编译：

```ts
export const portableFrom = derive.keyed.from(...);
export const portableMerged = derive.keyed.merge(...);
export const portableResolvedMerge = derive.keyed.merge(... conflict: 'resolve' ...);
```

确保下游声明只出现稳定 `KeyedProjection<K,V>`，不会泄露 private implementation brands。

---

## 13. 性能回归方案

建议新增：

```text
core/bench/projection-composition.bench.ts
```

而不是继续扩大 unrelated bench。

场景：

### `from`

- 10k scalar array initial materialization；
- 10k array one value change；
- 10k reorder-only；
- 10k array全部 identity 相同但 outer array 新引用，确认 no-op publication 成本。

### `merge`

- 3 × 10k sources，one winning value update；
- 3 × 10k，shadowed update；
- 3 × 10k，one add/remove（需要 order rebuild）；
- 3 × 10k，source reorder-only；
- conflict resolver：少量冲突与高冲突率两组。

关键验收不是追逐某个绝对 ops/s，而是锁定 work shape：

- value-only update 不扫描所有 ids；
- order-only 不执行 value resolver；
- ordinary no-conflict resolver 模式不创建 contribution array；
- 不出现 collection-size 级 persistent mirror。

必要时在 `optimization.test.ts` 用 callback count/profile counter 锁定这些 bounded-work 语义。

---

## 14. 文档与 Skill 修改方案

公共行为变更必须与实现同一批落地。

### 14.1 `README.md`

在 `derive.keyed` family 示例加入：

```ts
const synthetic = derive.keyed.from(...);
const allFields = derive.keyed.merge([synthetic, fields], { conflict: 'error' });
```

简明解释：

- `from`：ordered scalar/static → keyed；
- `merge`：keyed union；
- conflict 必须显式；
- merge order = stableUnique source-order concatenation；
- 没有 `union` / `overlay` 第二套 API。

### 14.2 `docs/projections.md`

加入正式语义：

- `from` duplicate/equality/order/lazy static snapshot；
- `merge` membership/conflict/formal order；
- winner switch 的 membership lifecycle；
- value-only / structural / reset 的增量边界；
- resolver 只处理真实 conflict；
- source list 是 definition-time static DAG。

### 14.3 `docs/architecture.md`

记录新的内部 owner：

```text
projection/keyed/composition.ts
```

明确：

- composition 只算 semantic intent；
- `CollectionOutput` 仍是唯一 published keyed state/change owner；
- `transform.ts` 不扩张为 multi-source composition；
- 不维护 parallel winner/membership cache；
- static source definition 与 Runtime materialization 分离。

### 14.4 `skills/doxum-runtime/SKILL.md`

更新 “Default API decisions”：

- ordered scalar/static values → `derive.keyed.from`；
- multiple keyed sources → `derive.keyed.merge`；
- synthetic fixed entry + dynamic keyed source 用 `from + merge`；
- 不要为这些场景手写 `incremental.collection + Set + Map + output.order()`。

### 14.5 `skills/doxum-runtime/references/public-api.md`

加入精确签名与 option contract：

- 两个 `from` overload；
- `merge` conflict discriminated options；
- resolver contributions shape；
- equality；
- formal order。

### 14.6 `skills/doxum-runtime/references/projections.md`

在 primitive decision table 中加入：

```text
ordered scalar/static -> keyed : from
multiple keyed -> keyed        : merge
```

写完整生命周期、错误、order 与增量语义。

### 14.7 `skills/doxum-runtime/references/recipes.md`

新增至少两个 recipe：

1. synthetic title field + dynamic fields：`from + merge(conflict:error)`；
2. base + overrides：`merge(conflict:last)`。

### 14.8 Skill/public surface guard

当前 `check-runtime-skill.mjs` 只自动核对 package exports，不能发现 `derive.keyed` family member 漂移。

本次应扩展 skill contract：

- 从 `keyedDerive = Object.assign(...)` AST 读取正式 family members；
- 在 `public-api.md` 增加 `derive.keyed` surface inventory marker；
- 双向校验实现 family 与文档 inventory；
- 这样后续新增/删除 `from`、`merge` 或其他 keyed primitive 时，skill 不会静默过期。

同时更新 `fixtures/public-api.ts`，让 TypeScript public fixture 锁定真实调用形态。

---

## 15. 实施顺序

### Phase 1：建立 composition owner

1. 新增 `core/src/projection/keyed/composition.ts`；
2. 先把现有 `createKeyedSingleton` 原样迁入；
3. `derive.keyed.singleton` public behavior 不变；
4. focused tests 证明纯结构迁移无回归。

目的：先建立最终 owner，再向其中添加新能力，不把临时实现堆进 `derive/keyed.ts`。

### Phase 2：实现 `from`

1. static/projection source compile；
2. static outer array snapshot；
3. key/string/duplicate validation；
4. output reconciliation；
5. equality/identity；
6. fault/recovery tests；
7. public type + portability fixture。

### Phase 3：实现 `merge`

1. source definition snapshot/validation；
2. explicit conflict options；
3. source revision tracking；
4. affected-key incremental recompute；
5. formal order rebuild；
6. optimized full rebuild；
7. resolver lazy contribution allocation；
8. reset/fault recovery；
9. membership lifecycle + runtime.items tests。

### Phase 4：公共 surface 与文档

同步完成 README/docs/skills/fixtures/skill checker，不留“代码先落、文档以后补”的窗口。

### Phase 5：性能与完整验证

运行：

```sh
pnpm run format
pnpm run check
pnpm run build
pnpm run profile
pnpm run bench
git diff --check
```

并运行新增 composition benchmark。

---

## 16. 验收标准

### API

- `derive.keyed.from` 同时支持 scalar array projection 与 static readonly array；
- duplicate key 永不静默覆盖；
- `derive.keyed.merge` 只有一个正式 API；
- conflict policy 必填；
- 不存在新增 `union` / `overlay` alias；
- order policy 只有 stable-first-occurrence 一条。

### Semantics

- `from` formal order 与 array 一致；
- `merge` membership 是 union；
- merge position 与 conflict value policy 正交；
- equality suppress no-op 且保留 previous published identity；
- winner switch 不错误触发 remove/add lifecycle；
- reset/fault 不产生 partial publication。

### Architecture

- composition 有一个明确 internal owner；
- `transform.ts` 仍然只解决 single keyed driver；
- `CollectionOutput` 仍是唯一 published keyed state/change owner；
- 无 persistent application-style winner/reverse routing Map；
- 无第二套 change protocol；
- 无 imperative dependency discovery。

### Performance

- merge value-only update 不扫描所有 source ids；
- merge order-only 不重新计算 values/resolver；
- from 的 O(n) scalar scan 被明确接受且没有额外 O(n²) 行为；
- resolver contributions 只在真实 conflict 时分配；
- structural order rebuild 是一次 O(total memberships) stable-unique scan。

### Documentation

- README、`docs/projections.md`、`docs/architecture.md` 同步；
- runtime skill 的 SKILL/public-api/projections/recipes 同步；
- skill checker 能检测 `derive.keyed` family surface 漂移；
- 使用方无需阅读 `core/src` 才能正确选择与使用 `from` / `merge`。

---

## 17. 最终设计原则

这两个 primitive 不应被实现成“方便调用的 helper”，而应成为 keyed projection 的正式 composition algebra：

```text
from      owns shape construction
merge     owns multi-keyed composition
transform owns one-driver mapping
groupBy   owns reverse indexing
output    owns publication/change semantics
runtime   owns materialization/lifecycle/recovery
```

这样 Dataview、Whiteboard、synthetic fields、base/override layers 等业务都只声明数据关系，不再拥有 Doxum 本应统一负责的 membership、conflict、order、affected-key routing 与 output patch 状态。

这是本轮实施时应保持的最终边界。
