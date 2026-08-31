# Doxum 模式参考

实现 Doxum 应用代码时阅读本页。它按能保持 runtime 模型正确的决策组织，而不是机械穷举所有导出符号。

## 按修改语义建模数据

| 需求                 | Schema node                | Canonical value     | Writer 行为                                  |
| -------------------- | -------------------------- | ------------------- | -------------------------------------------- |
| 一个标量或不可变叶子 | `field<T>()`               | `T`                 | `set`；optional field 还可 `clear`           |
| 命名的嵌套字段       | `object({ ... })`          | object              | 子 writer                                    |
| 带 tag 的结构分支    | `variant('kind', { ... })` | tagged object       | `replace` 完整分支值                         |
| 一个结构化实体       | `single(entity)`           | object              | 子 writer                                    |
| 有序实体             | `table(entity)`            | `{ ids, byId }`     | `create`、`item`、`remove`、`move`           |
| 无序实体             | `map(entity)`              | id record           | `create`、`item`、`remove`                   |
| 标量 record          | `record<Id, T>()`          | 完整 record         | `set`、`delete`、`replace`                   |
| 稀疏标量字典         | `dict<Key, T>()`           | partial record      | `set`、`delete`、`replace`                   |
| 有序标量/结构条目    | `list({ keyOf })`          | array               | `insert`、`move`、`remove`、`replace`        |
| 单根层级             | `tree<T>()`                | `{ rootId, nodes }` | `insert`、`move`、`remove`、`set`、`replace` |

当顺序对产品可见时使用 table。不要用 map 加另一份 ids array 表示顺序：这会产生两套 mutation protocol 和两个顺序来源。list 只适合每个条目都有稳定、唯一应用 key 的情形；不能把当前 index 当作 `keyOf`。

table/map 的 entry reader 与 writer 直接由 entry schema node 推导。结构化 entry 会保留
自己的 tree、list、dict、variant 等专用 access，而不会从运行时 value 反推成普通对象或
产生 value union。optional field 以及 optional 的 variant、dict、list、tree 结构叶子额外
提供 `clear()`，并可在缺失状态通过 `replace()` 初始化；object、table、map 仍使用各自的
子 writer 或集合操作。

```ts
import { field, list, map, object, schema, table, tree } from 'doxum';

type Tag = { id: string; name: string };

const note = object({ body: field<string>() });
const documentSchema = schema({
  notes: table(note),
  tags: list<Tag>({ keyOf: tag => tag.id }),
  collaborators: map(object({ name: field<string>() })),
  outline: tree<{ title: string }>(),
});
```

## 本地领域命令：读取、校验、写入

所有修改要么全部成功、要么全部失败时，将领域命令放进同一个 transaction。业务规则依赖当前状态时，先读取再产生 operation；阻断型业务规则调用 `tx.reject`。

```ts
function completeTask(id: string) {
  return runtime.update(tx => {
    const task = tx.read.tasks.get(id);
    if (!task) {
      tx.reject({
        source: 'application',
        code: 'task-not-found',
        message: `Task '${id}' does not exist.`,
        address: ['tasks', id],
      });
    }
    if (task.completed.get()) return { changed: false };

    tx.write.tasks.item(id).completed.set(true);
    tx.report({
      source: 'application',
      code: 'task-completed',
      message: 'Task marked complete.',
      address: ['tasks', id],
    });
    return { changed: true };
  });
}
```

`tx.report` 不会拒绝 transaction，适合 warning、审计反馈或伴随合法 commit 的应用消息。`tx.reject` 会中止 transaction，并让外层调用者得到 rejected result。两者都不能替代 malformed operation 的处理：引擎失败由 Doxum 提供的 `MutationIssue` 表示。

## 在一个边界应用外部 operation

将序列化、授权、网络排序和冲突策略集中在应用 adapter 中。adapter 判断一个 batch 可以应用后，再把完整 batch 交给 Doxum。

```ts
async function receiveRemote(batch: unknown) {
  // 在这里执行认证、排序、去重和冲突策略。
  const result = runtime.apply(batch, {
    source: 'remote',
    history: false,
  });

  if (result.status === 'rejected') {
    logRejectedOperations(result.issues);
    return;
  }
  if (result.status === 'committed') reportObserverErrors(result.observerErrors);
}
```

上面的断言只应存在于真正接受未知运行时输入的动态边界；不要把 operation type 放宽到整个应用。Doxum 仍会在发布 commit 前校验 malformed envelope 与语义错误。

`replace` 只用于新的、可信的 canonical snapshot。它会产生 reset impact 并使 local history 失效，不是表达微小变更的便捷写法。

## 用 Anchor 放置有序条目

table 与 list 共用同一套 `DocumentAnchor` 词汇：

```ts
{
  at: 'start';
}
{
  at: 'end';
}
{
  before: 'other-id';
}
{
  after: 'other-id';
}
```

不要在应用代码中计算 index，而应使用 anchor。它表达领域位置，让 Doxum 校验缺失的引用，并让 table、list 与 operation replay 语义保持一致。

```ts
runtime.update(tx => {
  tx.write.tasks.create({ id: 'review', value: newTask }, { before: 'publish' });
  tx.write.tags.insert({ id: 'urgent', name: 'Urgent' }, { at: 'start' });
  tx.write.tags.move('urgent', { after: 'planning' });
});
```

## 将 tree 视为一个整体不变量

Doxum tree 要么为空，要么存在唯一且连通的 root。`nodes` 必须维护双向 parent/child 关系、无重复 child、全量可达与无环。root replace 会校验完整 snapshot；本地 writer 会以增量方式维持该不变量。

```ts
runtime.update(tx => {
  tx.write.outline.insert('root', { title: 'Project' });
  tx.write.outline.insert('plan', { title: 'Plan' }, 'root');
  tx.write.outline.move('plan', 'root', 0);
  tx.write.outline.set('plan', { title: 'Plan release' });
});
```

只有在 tree 为空时，才能不传 `parentId` 创建 root。root 已存在后，每个新节点都必须有已存在的 parent。不要将非 root move 到 `undefined`，不要重新挂载 root，也不要在经过校验的 `tree.replace` 或 runtime `replace` snapshot 之外直接编辑 `{ rootId, nodes }`。

## 通过领域 target select 与 subscribe

从所属 schema 创建 selector 一次。这为 subscription 与 impact 解释建立稳定的公共契约。

```ts
const notes = documentSchema.collection(path => path.notes);
const body = documentSchema.value(path => path.notes.item('a').body);

const unsubscribe = runtime.subscribe([notes, body], commit => {
  if (commit.impact.affects(body)) refreshTitleUI();

  const change = commit.impact.collection(notes);
  if (change.kind === 'incremental' && change.updated.has('a')) refreshRow('a');
});
```

只有需要将两个 impact target 当作值比较时，使用 `target.same(left, right)`。应使用 `target.address`、`target.id`、`target.belongs` 与 `target.bucket`，不要在 framework adapter 或局部 helper 中复制它们的解释逻辑。

## 用 CollectionView 构建映射行

当一个 table 或 map 需要可复用 read model 时，使用 collection view。mapping callback 可以读取 entry 的类型化字段；`isEqual` 允许 view 在重新映射出的 row 语义不变时保留旧值。

```ts
const notes = documentSchema.collection(path => path.notes);

const noteSummaries = createCollectionView({
  runtime,
  source: notes,
  map: (id, note) => ({ id, preview: note.body.get().slice(0, 80) }),
  isEqual: (left, right) => left.id === right.id && left.preview === right.preview,
});

const stop = noteSummaries.item('a').subscribe(() => rerenderRow('a'));
const all = noteSummaries.all.current();
```

不要让调用方把变更推入 view。它会监听声明的 source 并从 runtime state 重新计算。`noteSummaries` 和 `stop` 应随所属 UI 或 service 一起 dispose。

## 用 MaterializedView 构建聚合或索引

当你拥有可以根据 commit 增量更新的 aggregate 时，使用 materialized view。`update` 期间通过传入的 `impact` 对象检查影响范围；这会记录真实依赖，使之后无关的 commit 可以跳过此次 update。

```ts
const notes = documentSchema.collection(path => path.notes);

const noteCount = createMaterializedView(runtime, {
  build: ({ read }) => ({
    value: read.notes.ids().length,
    update: ({ impact, read }) => {
      const change = impact.collection(notes);
      if (
        change.kind === 'incremental' &&
        change.added.size === 0 &&
        change.removed.size === 0 &&
        change.updated.size === 0 &&
        !change.orderChanged
      ) {
        return { kind: 'unchanged' };
      }
      return {
        kind: 'changed',
        value: read.notes.ids().length,
        change,
      };
    },
  }),
});
```

局部增量逻辑无法安全处理一个 commit 时，返回 `rebuild`。后创建的 view 可以在 `sources` 中声明更早创建的 view；Doxum 会按创建顺序处理该图，并在外部 listener 看到 commit 前将其 flush 完成。

## 在 React 中绑定读模型

直接读取 document 时使用 `useDocumentSelector`。它会跟踪每次 selector 执行中读取的 path 和 collection entry，包括动态依赖。

```tsx
function Note({ id }: { id: string }) {
  const body = useDocumentSelector(runtime, read => read.notes.get(id)?.body.get());
  return <p>{body ?? 'Missing note'}</p>;
}
```

已有 read model 则使用更窄的 hook：

```tsx
function NoteRow({ id }: { id: string }) {
  const summary = useReadable(noteSummaries.item(id));
  return <p>{summary?.preview}</p>;
}

function UndoButton() {
  const history = useHistory(runtime.history);
  return (
    <button disabled={history.undoDepth === 0} onClick={() => history.undo()}>
      Undo
    </button>
  );
}
```

selector 应保持纯粹：读取 Doxum state 并计算结果即可；不要在 selector 执行中写入、手动订阅或发起 I/O。

## 测试真正发生变化的行为

mutation 改动应覆盖成功 commit、部分 batch 的 rejected rollback、inverse/history 结果，以及相关 impact 或 subscription 行为。projection 改动应覆盖无关 commit、动态依赖、应当稳定的引用和 dispose。大型 table、list 与 tree 应增加回归测试，证明无关数据没有被复制或遍历。
