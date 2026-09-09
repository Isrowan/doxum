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

position.x 细粒度赋值；stroke 整体替换；rows.replace(key, value) 按稳定键替换项。

## 含集合的整体替换

```ts
const model = object({
  entries: map(object({ rows: table(object({ title: field<string>() })) })),
});
const document = createDocument({ schema: model, initial: { entries: {} } });
document.update(draft => {
  draft.entries.put('a', { rows: { ids: ['x'], byId: { x: { title: 'First' } } } });
  draft.entries.get('a')!.rows.get('x')!.title = 'Updated';
});
```

map 条目使用 put。Draft 类型含集合方法的 object/variant 成员使用顶层 replace；
集合整体替换使用集合自身的 replace(next)，并经同一 mutation session 修改。

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

品牌类型贯穿 map/table 方法、符号路径和 collection impact。

## 顺序、History 与重放

table.create/remove/move 使用 { at: 'start' } 或 { before: id } 等 anchor。
tree.insert/move 接收 { parentId, index }，index 表示移除后的最终位置，
不能直接修改拓扑记录。

document.history.group() 开始分组，end() 分组已完成提交，cancel() 恢复起点；
undo/redo 原子重放完整 ChangeSet。外部 apply 必须提供 expectedRevision，
适配器还须校验传输顺序。remote commit 使本地 history 失效；
本地 revision 不是分布式时钟。

输入的成员变化共享所属容器地址：

```ts
document.apply(
  {
    changes: [
      {
        kind: 'members',
        at: ['tasks', 'a'],
        members: [
          { key: 'complete', kind: 'updated', before: false, after: true },
          { key: 'title', kind: 'updated', before: 'First', after: 'Done' },
        ],
      },
    ],
  },
  { expectedRevision: document.revision() }
);
```

每个容器只能有一组。added 仅携带 after，removed 仅携带 before；存在的 undefined
仍是一个值。不要展开成旧 value envelope，也不要将分组地址当作整个容器失效。

## 投影与 React

```ts
const titles = project(
  document,
  path => path.tasks,
  (_id, task) => task.title
);
const total = project({ titles }, ({ titles }) => titles.ids().length);
const zoom = input(1);
const scaled = project({ total, zoom }, ({ total, zoom }) => total * zoom);
const store = createProjectionStore({ onError: console.error });
store.get(scaled);
```

投影定义使用 `useProjection` 和一个 store，document.history 等既有 Readable
使用 `useReadable` 或 `useHistory`。自定义集合 processor 通过
writer.set/remove/order/replace 暂存输出，
previous/next 读取只在作用域内有效。candidates 汇总整个 batch，以最终状态派生输出。
React 追踪实际读取，但 processor 依赖仍显式声明。
