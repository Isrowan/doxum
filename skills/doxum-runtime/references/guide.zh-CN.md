# Doxum Runtime 使用指南

这是 Doxum 面向任务的公开使用指南。它说明如何借助 `doxum` 建模、读取、修改、观察和派生一个内存文档，以及如何通过 `doxum/react` 将这些读模型接入 React。

Doxum 有意保持本地化：它负责类型化文档状态、原子修改、历史记录、影响范围、订阅和派生视图。持久化、网络顺序、授权和冲突解决由应用负责。

## 先选择正确入口

| 目标                       | 使用方式                                              |
| -------------------------- | ----------------------------------------------------- |
| 定义文档结构               | `schema`、`field`、`object` 和集合构造器              |
| 创建 canonical runtime     | `createDocument`                                      |
| 一次性读取                 | `select(runtime, read => ...)`                        |
| 执行本地业务修改           | `runtime.update(tx => ...)`                           |
| 回放持久化或远端 operation | `runtime.apply(operations, options)`                  |
| 整体替换可信快照           | `runtime.replace(document, options)`                  |
| 监听一个 schema 位置       | `schema.value` + `runtime.subscribe`                  |
| 监听 table 或 map          | `schema.collection` + `runtime.subscribe`             |
| 维护映射后的集合数据       | `createCollectionView`                                |
| 维护聚合或索引             | `createMaterializedView`                              |
| 在 React 中读取            | `useDocumentSelector`、`useReadable` 或 `useReadable` |

不要再维护一份可写的文档副本。`createDocument` 是 canonical state 的唯一所有者。

## 从 schema 开始

schema 同时定义文档的 TypeScript 结构，以及 writer、operation、selector 和 subscription 共用的权威地址模型。只定义一次，并让它靠近所描述的领域。

```ts
import { createDocument, field, object, schema, table } from 'doxum';

const task = object({
  title: field<string>(),
  completed: field<boolean>(),
});

const taskSchema = schema({
  title: field<string>(),
  tasks: table(task),
});

const runtime = createDocument({
  schema: taskSchema,
  initial: {
    title: 'Launch Doxum',
    tasks: {
      ids: ['write-guide'],
      byId: {
        'write-guide': { title: 'Write the guide', completed: false },
      },
    },
  },
});
```

`table` 通过 `{ ids, byId }` 保留应用可见的顺序；`map` 存储无顺序的 id 索引实体。单个结构化实体用 `single`，标量键值数据用 `dict` 或 `record`，带应用稳定 key 的有序序列用 `list`，经过校验的单根层级结构用 `tree`。建模取舍见 [patterns.zh-CN.md](patterns.zh-CN.md)。

## 通过 reader 读取

runtime 不会暴露可变的 canonical document，应通过回调读取：

```ts
import { select } from 'doxum';

const openTitles = select(runtime, read =>
  read.tasks.ids().flatMap(id => {
    const task = read.tasks.get(id);
    return task && !task.completed.get() ? [task.title.get()] : [];
  })
);
```

reader 的形状由 schema 决定：

- field 使用 `get()`。
- table 或 map 使用 `ids()`、`has(id)` 和 `get(id)`。
- list 使用 `values()`、`length()` 和 `at(index)`。
- tree 使用 `rootId()`、`has(id)`、`value(id)`、`parent(id)` 和 `children(id)`。

结构化 reader 返回 snapshot。不要在 `runtime.update` 返回后保留 transaction reader；它只在该回调期间有效。

## 原子地修改

本地、类型化的领域行为使用 `runtime.update`。回调获得短生命周期的 `tx.read` 和 `tx.write`。writer 在一个原子 session 中产生 operation，而不是直接暴露 canonical state 的写入。

```ts
const result = runtime.update(tx => {
  const task = tx.read.tasks.get('write-guide');
  if (!task) {
    tx.reject({
      source: 'application',
      code: 'task-not-found',
      message: 'The requested task no longer exists.',
      address: ['tasks', 'write-guide'],
    });
  }

  tx.write.tasks.item('write-guide').completed.set(true);
  return task.title.get();
});

if (result.status === 'committed') {
  console.log(result.value, result.commit.revision);
} else if (result.status === 'rejected') {
  console.error(result.issues);
}
```

一次 update 是同步且原子的：

- writer 产生语义上无效的 operation 时，Doxum 回滚整个 session，并以 `MutationIssue` 返回 `status: 'rejected'`。
- `tx.reject(...)` 回滚并返回应用层的 `DocumentDiagnostic`。
- 普通 `throw` 同样回滚，但错误会继续抛给调用方。
- 净变化为零时，返回 `status: 'unchanged'`，且不会发布 commit。

非阻断的应用诊断使用 `tx.report(...)`。committed 与 unchanged 结果通过 `reports` 暴露它们；report 与诊断地址在发布前会被复制并冻结。

## 用 writer，而不是局部拼 operation

普通应用行为优先调用 writer API；它更清晰，也能保留 schema 的领域语义：

```ts
runtime.update(tx => {
  tx.write.title.set('Ship Doxum');
  tx.write.tasks.create(
    { id: 'release', value: { title: 'Publish the package', completed: false } },
    { after: 'write-guide' }
  );
  tx.write.tasks.item('release').title.set('Publish doxum');
  tx.write.tasks.move('release', { at: 'start' });
  tx.write.tasks.remove('write-guide');
});
```

table 支持 `create`、`item`、`remove` 和 `move`。map 与之相同，但没有 `move`，因为它无顺序。list 支持 `insert`、`move`、`remove` 与 `replace`；其身份来自 schema 中的 `keyOf`。完整的集合与 tree 模式见 [patterns.zh-CN.md](patterns.zh-CN.md)。

## 在边界回放 operation

来自持久化、网络适配器或其他外部边界的 operation batch 应通过 `apply` 回放。Doxum 会在 mutation code 看到数据前解码未知 operation payload，按 schema 解析每个地址，并原子地执行整个 batch。

```ts
const result = runtime.apply([{ type: 'field.set', at: ['title'], value: 'Restored title' }], {
  source: 'remote',
  history: false,
});

if (result.status === 'rejected') {
  // 文档与 revision 均保持不变。
  console.error(result.issues);
}
```

外部 operation 输入即便在 TypeScript 中看似合法，也应视作不可信。不要在 Doxum 之外再写一套 path parser，也不要以局部回放方式自行校验 operation。远端 commit 与每次 `replace` 都会建立新的基线，因此会使本地 undo/redo history 失效。

## 理解结果与 history

所有 mutation 入口都会返回三种状态之一：

| 状态        | 含义                                      |
| ----------- | ----------------------------------------- |
| `committed` | canonical state 已变化；结果含有 commit。 |
| `unchanged` | 净状态未变化；revision 不变。             |
| `rejected`  | 整个 batch 已回滚；检查 `issues`。        |

已提交的 operation 包含 forward operation、inverse operation、revision 和 `DocumentImpact`。本地与 system commit 默认会记录到 local history。使用 `runtime.history.undo()` 与 `runtime.history.redo()`；它们仍通过同一 mutation pipeline 回放 inverse 或 forward batch。

committed 结果中的 `observerErrors` 是 canonical state 和 history 已稳定后，processor、flush 或 listener 发生的失败。它们不是 mutation 失败，调用方不能因此重复写入。

## 通过 schema 所有的 target 订阅

从 schema 创建稳定 selector，再订阅 selector。这是整个 runtime 共用的 address 与 impact 模型。

```ts
const title = taskSchema.value(path => path.title);
const tasks = taskSchema.collection(path => path.tasks);

const stopTitle = runtime.subscribe(title, commit => {
  console.log('title changed at revision', commit.revision);
});

const stopTasks = runtime.subscribe(tasks, commit => {
  const change = commit.impact.collection(tasks);
  if (change.kind === 'incremental') {
    console.log(change.added, change.removed, change.updated, change.orderChanged);
  }
});

stopTitle();
stopTasks();
```

value selector 使用 `commit.impact.affects(target)`；table 或 map selector 使用 `commit.impact.collection(selector)`，它在增量更新时返回精确变更，在 replace 后返回 `reset`。不要在应用模块中重写 path 比较 helper。

## 构建派生读模型

`createCollectionView` 将一个 table 或 map 映射为稳定的 ids、缓存的 `item(id)` readable 和惰性 `all` 数组；在可能的情况下只更新受影响的条目。

```ts
import { createCollectionView } from 'doxum';

const taskTitles = createCollectionView({
  runtime,
  source: taskSchema.collection(path => path.tasks),
  map: (_id, task) => task.title.get(),
});

taskTitles.item('write-guide').current();
taskTitles.all.current();
```

需要自定义增量逻辑的索引或聚合使用 `createMaterializedView`。materialized view 是派生状态，不是由调用方手工同步的 cache；它只能依赖同一 runtime 中更早创建的 materialized view。每个 view 都要由所属功能在销毁时释放。

## React 集成

`doxum/react` 基于 `useSyncExternalStore` 与 Doxum 读取依赖。组件只会在 commit 可能影响其 selector 读取结果时重新渲染。

```tsx
import { useDocumentSelector } from 'doxum/react';

function OpenTaskCount() {
  const count = useDocumentSelector(
    runtime,
    read => read.tasks.ids().filter(id => !read.tasks.get(id)?.completed.get()).length
  );

  return <output>{count}</output>;
}
```

`Readable` 使用 `useReadable(view.all)`，单个 keyed value 使用 `useReadable(view.item(id))`，undo/redo state 与 action 使用 `useHistory(runtime.history)`。`core` 必须保持不导入 React；React 相关代码应属于 adapter 或应用层。

## 生命周期与所有权

- `createDocument` 启动时会克隆 initial document。
- 经由 operation 传入的结构化 payload 会转移到 canonical state。除非有意修改 canonical state，否则调用后不要再修改它。
- 已发布的 commit、history payload、diagnostic 和 selector address 都是不可变 snapshot。
- tree 的 replace snapshot 会经过校验并克隆，以维持结构完整性。
- runtime 不再使用时调用 `runtime.dispose()`；现有 subscription、history state 和 view 应随其所属对象一同 dispose。

决策规则与反模式见 [invariants.zh-CN.md](invariants.zh-CN.md)，可直接复用的实现模式见 [patterns.zh-CN.md](patterns.zh-CN.md)。
