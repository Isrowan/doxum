# Doxum Projection 参考

设计、实现或审查 projection 时使用本文。[公开完整契约](../../../docs/projections.md)
提供完整 join 示例；正常应用开发不应再要求阅读运行时源码。

## 选择定义形式

| 依赖关系                       | API                                               |
| ------------------------------ | ------------------------------------------------- |
| 整个文档作为 source            | `project(document)`                               |
| 只关注指定文档路径             | `project(document, [pick, ...])`                  |
| 一个文档集合 source            | `project(document, pick)`                         |
| 一个 source 键映射到同名输出键 | `project(collection, mapper)`                     |
| 当前 source 值纯计算出一个值   | `project(sources, compute)`                       |
| 有状态增量 value               | `project({ kind: 'value', sources, build })`      |
| 多 source 或跨键集合计算       | `project({ kind: 'collection', sources, build })` |
| 应用输入                       | `input(initial)` 与 `store.set(input, value)`     |
| 既有 `Readable`                | `project(readable)`                               |

定义是惰性、可复用的描述。`createProjectionStore({ onError })` 拥有一个物化图。
同一定义在不同 store 内分别拥有发布值、revision、input、订阅、processor 实例和闭包索引。

普通 mapper 的契约有意限制为：

```text
source 键 K 变化 -> 输出键 K 可能变化
```

它在 reset 时重建并跟随 source 顺序，但不会追踪 mapper 内的读取。不要在 mapper
里读取另一个集合并假定它自动成为依赖；应改用 advanced processor，并显式声明所有 source。

## Source Event 契约

advanced processor 接收 event，而不只是当前值：

```ts
type ValueEvent<T> = {
  value: T;
  previous: T;
  changed: boolean;
  revision: number;
  reset: boolean;
};

type CollectionEvent<K extends string, V> = {
  get(key: K): V | undefined;
  has(key: K): boolean;
  ids(): readonly K[];
  change: CollectionImpact<K> | undefined;
  revision: number;
  reset: boolean;
};

type DocumentEvent<S> = {
  read: Read<S>;
  revision: number;
  commits: readonly DocumentCommit<S>[];
  reset: boolean;
};

type DocumentCollectionEvent<S, N, K extends string> = {
  read: CollectionAccess<K, N>;
  revision: number;
  commits: readonly DocumentCommit<S>[];
  reset: boolean;
  candidates: { keys: readonly K[]; orderDirty: boolean };
};
```

投影集合的 `change` 可能是 incremental（`added`、`removed`、`updated`、
`orderChanged`）、reset 或 undefined。文档集合的 candidates 是一个 store batch
内所有相关 commit 的并集。后续 commit 即使抵消早先变化，也不会移除候选键。
必须用最终 `read` 状态计算输出。需要维护关系索引时，用
`commit.impact.collection(pick)` 取得每次 commit 的精确变化。

batch 中 value event 的 `previous` 是 batch 前的值，`value` 是最终值。
单个净零文档事务不会产生 commit 或 candidates。

## Advanced Value Processor

```ts
const value = project({
  kind: 'value',
  sources,
  build: events => ({
    value: buildValue(events),
    update: events =>
      needsRebuild(events)
        ? { kind: 'rebuild' }
        : changed(events)
          ? { kind: 'changed', value: updateValue(events) }
          : { kind: 'unchanged' },
  }),
});
```

除非保留状态能避免有意义的工作，否则优先使用 `project(sources, compute)`。

## Advanced Collection Processor

```ts
const result = project({
  kind: 'collection',
  sources,
  name: 'optional diagnostic name',
  isEqual: Object.is,
  build: ({ sources, previous, next, writer }) => {
    // 构建完整输出和 store 局部索引。
    return {
      update: ({ sources, previous, next, writer }) => {
        // 只暂存受影响的键，或返回 { kind: 'rebuild' }。
      },
    };
  },
});
```

首次物化、source reset、显式 `store.rebuild`、update 请求 rebuild 以及 fault
恢复时会调用 `build`。build 从已清空的输出开始，必须写出完整结果。
其闭包状态只属于一个 store，并且必须能完全由 sources 重建。

任一已声明 source 参与结算时调用 `update`。返回 `{ kind: 'rebuild' }` 会丢弃
本次 update 暂存的写入，并执行全新 build。所有回调同步执行；Promise 和 thenable
会被拒绝。processing 或 notification 中的读取和写入不得重入 source 或 document。

`previous`、`next`、source reader 和 `writer` 都只在当前同步回调内有效：

- `previous` 只看到已发布输出。
- `next` 立即看到当前暂存的写入。
- `writer.set(key, value)` 暂存存在值。
- `writer.remove(key)` 暂存缺失；删除不存在的键是 no-op。
- 同一键多次操作以最后一次为准。
- `writer.order(ids)` 提供完整 next 顺序，每个输出键必须恰好出现一次。
- `writer.replace(entries)` 清空并按 entries 顺序替换全部输出，键不能重复。

暂存输出原子发布。相等判断默认使用 `Object.is`，相等的 set 保留旧引用。
净零输出不增加 revision，也不通知 listener。

## 跨集合 Join 模式

不要增加通用 join 抽象。缺失引用、基数、重连、删除、顺序和结果键策略都属于领域逻辑。
应使用带显式 sources 和索引的 advanced collection 表达 join。

例如 route 由 `edges(from, to)` 和 node 几何信息计算，维护：

```text
endpoints: edgeId -> [fromNodeId, toNodeId]
adjacency: nodeId -> Set<edgeId>
```

build 时扫描一次 edges，填充两个索引并写出全部 routes。edge 变化时：

1. 从每个 commit 的 collection impact 读取精确变化的 edge id。
2. 将每个变化 id 从旧 endpoints 中解绑。
3. 读取最终 edge 状态；绑定其最终 endpoints，或删除其正向索引。
4. 将该 edge id 加入受影响输出集合。

node 集合变化时，把 added/updated/removed node id 通过 `adjacency` 映射为相邻
edge，并只将这些 edge 加入受影响集合。最后读取当前 endpoint 几何信息，对每个
受影响 route 执行 set 或 remove。任一 source reset 都应 rebuild。

edge 重连后，旧 node 不得再选中它；删除 edge 必须同时移除正向和反向索引。
endpoint 缺失时的行为由领域显式定义。除非集合规模已知且权衡明确，不要在每次
node 变化时扫描全部 edges。

闭包索引不属于 writer 的 staged transaction。未捕获的 processor 失败会触发 fresh
build 恢复，但 processor 如果自行捕获失败后继续执行，其索引修改会保留。先完成可能
失败的工作再修改活动索引，或在临时状态上暂存索引变化并在成功后提交，或请求完整 rebuild。

## Batch、Fault 与生命周期

`store.batch` 只推迟 projection 结算和 projection listener；文档 commit 和文档
listener 仍同步执行。batch 内读取返回上次发布值，最外层 batch 结束后根据最终
source 状态结算。不提供跨文档回滚。

processor 或 writer 校验失败不会发布部分输出。runtime 可以用新 build 重试；
持续失败会使该 projection fault，并阻塞下游，独立分支仍继续工作。此时读取抛
`ProjectionError`。后续 source 更新或 `store.rebuild(projection)` 可以恢复。
`onError` 还接收 source、blocked 和 listener 失败。listener 失败不会撤销已发布
projection 状态或已接受的文档 commit。

`store.release(projection)` 释放可独立释放的物化结果；仍被已物化下游使用的节点
不能释放。`store.dispose()` 使整个图失效并解除其全部订阅。

## 审查清单

- 所有能改变结果的 source 都已声明。
- 候选选择覆盖 add、update、remove、reconnect 和缺失引用。
- batch 逻辑读取最终状态，而不是模拟中间状态。
- reset 和显式 rebuild 能重建完整输出、顺序和索引。
- build 不依赖旧输出或旧 processor 闭包。
- 使用 `writer.order` 时提供完整且有效的顺序。
- 相等结果保留引用；无关变化不产生输出 revision。
- update 抛错不会悄悄破坏闭包索引。
- 测试覆盖无关 commit、动态依赖、稳定引用、reset、batch、恢复和 disposal。
