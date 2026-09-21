# Projection 参考

准确签名见 [API 参考](api.zh-CN.md)。这里说明 ownership、invalidation 与 recovery。

## Ownership 与基础声明

Projection definition 是惰性的。root definition 可跨多个 runtime 复用；scope definition
属于一个 `ProjectionScope`。公开 `Projection<T>` 本身不保存 materialized value、
retained state、subscription 或 disposal state。
`KeyedProjection<K,V>` 是对应的公开 keyed handle，也可以安全出现在下游 package
生成的声明中。

```ts
const tasks = observe(document, path => path.tasks);
const filter = input<'all' | 'open'>('all');
const visible = derive({ tasks, filter }, ({ tasks, filter }) =>
  filter === 'all' ? tasks : filterOpen(tasks)
);

const runtime = createProjectionRuntime({ onError: report });
runtime.read(visible);
```

`ProjectionRuntime` 是 materialization、retained state、source attachment、settlement、
publication 与 recovery 的唯一 owner。稳定 verb 为 `read`、`select`、overloaded
`update`、`batch`、`scope`、`dispose`。

`input(initial, equality?)` 是 scalar Runtime-local state；
`input.collection(initial?, equality?)` 是 keyed Runtime-local application/UI state。
两者都不进入 canonical document 的 history/persistence。

## Source boundary

`observe` 是唯一 source declaration 入口，可接入：

- whole `ReadonlyDocument` 或 schema-path selection；
- Doxum `Readable<T>`；
- 公开 external value/collection source contract。

Document 的 `map`、`table`、`list(field, { keyOf })` selection 会成为 keyed projection。
list identity 来自 schema `keyOf`；原子 array-valued field 仍是 scalar。

Tree 复用同一套 source model：

```ts
const rootId = observe(document, path => path.outline.rootId);
const nodes = observe(document, path => path.outline.nodes);
const node = observe(document, path => path.outline.nodes.item(nodeId));
```

`rootId` 是 scalar，`nodes` 是 keyed，`item(id)` 是单 node value。同一次 document
commit 影响的 source projection 会在同一个 Runtime causal batch 中 settle。

External collection impact 只是边界 invalidation hint。processor 看到之前，Runtime 会把
它归一化为精确 `CollectionChange`。

## Pure derive 与 keyed projection

`derive(dependencies, compute, equality?)` 始终使用 named dependency object。
definition 创建后依赖固定且显式。

一个 keyed driver 拥有 output membership/order 时使用 `derive.keyed`：

```ts
const fieldValues = derive.keyed(records, record => record.values[fieldId]);
```

只有受影响 driver entry 会执行 selector。per-entry equality 判定 selected value 相等时，
该 key 不发布 `updated`；added、removed、order 语义保持不变。

标准 keyed structure read 仍属于同一个 family：

```ts
const ids = derive.keyed.keys(records);
const all = derive.keyed.values(records);
const entries = derive.keyed.entries(records);
const active = derive.keyed.get(records, activeRecordId);
```

`keys` 只在 add/remove/order/reset 时变化，value-only update 保持已发布 array 的引用与
revision；`values` / `entries` 始终遵循 keyed collection 的正式顺序，`entries` 会复用
未变化 entry 的 tuple 引用。`get` 只绑定当前 scalar-selected key；即使 key 当前缺失，
binding 仍保留，因此以后 add 会正确触发 scalar result。

membership-changing derive 也作为正式 primitive，而不是让应用手写 incremental
collection patch：

```ts
const visible = derive.keyed.filter(fields, field => field.visible);
const ordered = derive.keyed.subset(fields, visibleFieldIds);
const content = derive.keyed.compact(cards, card => card.content);
const bySection = derive.keyed.groupBy(records, record => record.sectionId);
const activeCollection = derive.keyed.singleton(activeRecord, record => record.id);
```

`filter` 保留 source value 与 source-relative order。`subset` 使用
`orderedKeys ∩ source.keys`，顺序由 orderedKeys 决定；当前缺失的 requested key 保持
latent，后续 source add 时自动出现，duplicate ordered keys 非法。`compact` 将 selected
`undefined` 解释为 output absence，对 present value 使用可选 per-entry equality。
`filter` / `compact` 与普通 `derive.keyed` 共用 named global/dynamic keyed dependencies。
`groupBy` 是通用一对多 reverse-index primitive，bucket member 遵循 source 正式顺序；
`singleton` 将 optional scalar 转成 0/1 keyed projection。

Dynamic keyed lookup 仍使用同一个 API：

```ts
const cardContent = derive.keyed(
  items,
  {
    record: { source: records, key: item => item.recordId },
    related: { source: records, keys: item => item.relatedRecordIds },
    view: activeView,
    fields: visibleFields,
  },
  (item, itemId, { record, related, view, fields }) =>
    renderCard(itemId, item, record, related, view, fields)
);
```

普通 Projection dependency 变化时使 driver key set 失效。`{ source, key }` 声明
output-key → dynamic source-key dependency；Runtime 拥有 forward binding 和 reverse
invalidation。selected source entry 缺失时仍保留 binding，因此以后新增该 source key
会正确触发 dependent output key。`{ source, keys }` 将一个 driver key 绑定到一个有序、
无重复的 source-key 集合，dependency value 是按声明顺序包含当前存在 entry 的 readonly
map；source 仅 order 变化不会使 keyed lookup 失效。

这就是 keyed join 协议。不要再添加第二套 join abstraction、wildcard document path
grammar 或 processor 内 imperative dependency discovery。

## Runtime 读取、更新与 scope

```ts
const value = runtime.read(visible);
const selected = runtime.select(visible, rows => rows.get(rowId), equality);
const stop = selected.subscribe(listener);
const itemFamily = runtime.items(records);
const record = itemFamily.get(rowId);

runtime.update(filter, 'open');
runtime.update(selection, draft => {
  draft.set(rowId, true);
  draft.remove(previousRowId);
});

runtime.batch(run, { cause });
```

`select` 返回标准 `Readable`。keyed selector 追踪相关 key/structure 读取；只有发生
相关 invalidation 后才执行 selector，随后 equality 决定是否发布结果。

`runtime.items(keyedProjection)` 返回一个 Runtime-owned keyed Readable family：`keys`
表示正式有序 membership，`get(key)` 在一次 published membership generation 内保持
Readable identity。remove 会结束这一 generation；同 key 以后 re-add 会得到新 identity。
已订阅的 missing item 可以保持 latent，并在未来 add 时激活。`ProjectionScope.items`
使用相同语义，并随 scope disposal 一起结束。

`CollectionInputDraft` 提供 `get`、`has`、`set`、`remove`，同步 edit callback 返回后
失效。callback throw 时该次 edit 不应用。collection input equality 按 entry 比较，
默认 `Object.is`，并在接受的本地状态安装前完成；equality 抛错时，published value 与
下一次 draft 同样保持更新前状态。equal set 不替换存储值，也不发布。

```ts
const scope = runtime.scope();
const localFilter = scope.own(input<'all' | 'open'>('all'));
const local = scope.own(
  derive({ tasks, filter: localFilter }, ({ tasks, filter }) =>
    filter === 'all' ? tasks : filterOpen(tasks)
  )
);
scope.read(local);
scope.update(localFilter, 'open');
scope.dispose();
```

scope 与 parent Runtime 共享 scheduler/materialization owner。`scope.own` 为 projection
definition 或静态 nested projection tree 赋予 lifecycle。scoped definition 可以依赖
root definition；root 或 sibling scope 不能依赖 scoped definition，同一个 definition
也不能属于两个 scope。必须在 definition 首次作为 root materialize 之前确定 scope
ownership。

## 唯一的 collection change 协议

所有 keyed projection source/output 都使用：

```ts
type CollectionChange<K extends string, V> =
  | { kind: 'reset' }
  | {
      kind: 'incremental';
      added: readonly { key: K; after: V }[];
      updated: readonly { key: K; before: V; after: V }[];
      removed: readonly { key: K; before: V }[];
      order?: { before: readonly K[]; after: readonly K[] };
    };
```

advanced processor 需要显式标注该 transport type 时，从 `doxum/advanced` 导入
`CollectionChange`；root projection consumer 不需要从 package root 导入它。

`doxum/advanced` 的 `collectionChange.keys(change)` 接受 incremental change，按
added → updated → removed 惰性遍历 entry-transition keys。它不解释 reset，也不会把
order change 转成 entry change；这些语义由调用方显式决定。

initial materialization 和 source reset 对 advanced processor 报告 `reset`。
incremental transition 是 settle 后 batch 边界上的 exact net change。

## Advanced processor

只有 retained state、cross-key index 或直接 incremental output patch 无法用
`derive` / `derive.keyed` family 清晰表达时，才从 `doxum/advanced` 引入 `incremental`。

所有 advanced processor 都使用 named dependencies，并且 `process` 必需。只有确实需要
retained state 时才声明 `state()`：

```ts
const weights = incremental.collection(
  { tasks },
  {
    state: () => ({ initialized: false }),
    process: ({ values, changes, output, state, reset }) => {
      if (reset) {
        for (const [id, task] of values.tasks) output.set(id, task.weight);
        output.order([...values.tasks.keys()]);
        state.initialized = true;
        return;
      }

      const change = changes.tasks;
      if (!change || change.kind === 'reset') return;
      for (const entry of change.added) output.set(entry.key, entry.after.weight);
      for (const entry of change.updated) output.set(entry.key, entry.after.weight);
      for (const entry of change.removed) output.remove(entry.key);
      if (change.order) output.order([...values.tasks.keys()]);
    },
  }
);
```

`values`、`changes` 按 dependency 名称读取。scalar dependency 没有 collection change
metadata。collection processor 额外提供 keyed `previous`、`next` 和 borrowed
`output` draft。

每个 driver key 需要独立 retained state 时使用 `incremental.keyed`：

```ts
const totals = incremental.keyed(
  sections,
  { records: { source: records, keys: section => section.recordIds } },
  {
    state: () => ({ runs: 0 }),
    process: ({ dependencies, state }) => {
      state.runs++;
      return [...dependencies.records.values()].reduce((sum, record) => sum + record.score, 0);
    },
  }
);
```

driver 独占 output membership/order。普通 dependency 变化会 invalidate 当前所有 driver
key；singular/plural keyed dependency 通过 reverse routing 只运行真正受影响的 key。
driver 仅 order 变化不会执行 `process`。remove 释放该 key 的 state，re-add 建立新的
membership lifecycle；reset intersection 保留 state，processor fault recovery 重建全部
per-key state。process 只返回自身 output value，不暴露 collection draft。

多输出 processor 使用一个 closed group definition：

```ts
const render = incremental.group(
  { tasks },
  {
    output: define => ({
      shell: define.collection<RowId, Shell>(),
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, output, state }) => {
      state.runs++;
      for (const [id, task] of values.tasks) output.shell.set(id, makeShell(task));
      output.count.set(values.tasks.size);
    },
  }
);
```

`define.collection<K,V>(equality?)`、`define.value<T>(equality?)` 只存在于 `output`
callback 内。返回的静态 object tree 会映射为同一 producer 的 projection leaves：
collection 为 `KeyedProjection<K,V>`，value 为 `Projection<T>`。
initial build 和 Runtime recovery 必须建立每个 value leaf；普通 incremental run 中未触碰
value leaf 会保留已发布值。

普通 source reset 保留已声明的 retained state。processor fault 的恢复由 Runtime 完成：
重新创建已声明的 state 并执行 reset evaluation；stateless processor 走同一恢复路径但没有
state object。没有公开 rebuild token 或手工 recovery hook。

## React

`ProjectionProvider` 提供 Runtime 或 scope。`useProjection(projection, selector,
equality?)` 使用同一套 Core selector 语义；`useInput` 同时支持 scalar/collection input。
Document 读取独立使用：

```ts
const value = useDocumentSelector(document, selector, equality);
```

processor 先于 projection listener settle；processing/notifying 时禁止写。
listener failure 不会 rollback 已接受的 document commit。
