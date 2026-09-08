# Doxum 常见模式

## 原子值与结构

```ts
const point = object({ x: field<number>(), y: field<number>() });
const model = object({
  position: point,
  stroke: field<readonly { x: number; y: number }[]>(),
  rows: list(field<{ id: string; label: string }>(), { keyOf: row => row.id }),
});
```

position.x 细粒度赋值；stroke 整体替换；rows.set(key, value) 按稳定键替换项。

## 含集合的整体替换

```ts
const model = object({
  entries: map(object({ rows: table(object({ title: field<string>() })) })),
});
const document = createDocument({ schema: model, initial: { entries: {} } });
document.update(draft => {
  assign(draft.entries, 'a', { rows: { ids: ['x'], byId: { x: { title: 'First' } } } });
  draft.entries.a!.rows.get('x')!.title = 'Updated';
});
```

TypeScript 映射属性不能分别指定读写类型。assign 校验对应 Infer 数据，
经同一 mutation session 修改。

## 领域键

```ts
type PersonId = string & { readonly __person: unique symbol };
const personId = (value: unknown): PersonId => {
  if (typeof value !== 'string' || !value.startsWith('person:')) throw new Error('Person ID');
  return value as PersonId;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('String required');
  return value;
};
const model = object({ people: map(object({ name: field(text) }), { key: personId }) });
const initial = parse(model, { people: { 'person:1': { name: 'Ada' } } });
```

品牌类型贯穿索引、table 方法、符号路径和 collection impact。

## 顺序、History 与重放

table.create/remove/move 使用 { at: 'start' } 或 { before: id } 等 anchor。
tree.insert/move 接收 { parentId, index }，index 表示移除后的最终位置，
不能直接修改拓扑记录。

document.history.group() 开始分组，end() 分组已完成提交，cancel() 恢复起点；
undo/redo 原子重放完整 ChangeSet。外部 apply 必须提供 expectedRevision，
适配器还须校验传输顺序。remote commit 使本地 history 失效；
本地 revision 不是分布式时钟。

## 投影与 React

```ts
const projection = createProjectionRuntime({ onError: console.error });
const titles = projection.map(
  projection.document(document).collection(path => path.tasks),
  (_id, task) => task.title
);
const total = projection.value({ titles }, ({ titles }) => titles.ids().length);
const zoom = projection.input(1);
const scaled = projection.value(
  { total, zoom: zoom.source },
  ({ total, zoom }) => total.value * zoom.value
);
```

投影值、ids、all、item(id) 使用 useReadable，document.history 使用 useHistory。
自定义集合 processor 通过 writer.set/remove/order/replace 暂存输出，
previous/next 读取只在作用域内有效。candidates 汇总整个 batch，以最终状态派生输出。
React 追踪实际读取，但 processor 依赖仍显式声明。
