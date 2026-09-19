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
const document = createDocument({
  schema: model,
  initial: {
    entries: {
      a: { rows: { ids: ['x'], byId: { x: { title: 'First' } } } },
    },
  },
});
document.update(draft => {
  const entry = draft.entries.get('a')!;
  replace(entry, 'rows', {
    ids: ['y'],
    byId: { y: { title: 'Replacement' } },
  });
});
```

Draft 类型含集合方法的 object/variant 成员使用顶层 `replace(parent, key, value)`；
map membership 仍使用 `put`/`remove`。当集合本身就是 mutation target 时，整体替换
使用集合自身的 `replace(next)`。

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

品牌键类型贯穿 map/table 方法、符号路径和 collection impact。

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
const rows = observe(document, path => path.rows);
const metadata = observe(document, path => path.metadata);
const density = input<'compact' | 'comfortable'>('comfortable');

const labels = derive.keyed(rows, row => row.label);
const decorated = derive.keyed(
  rows,
  [{ source: metadata, key: row => row.metadataId }, density],
  (row, _rowId, meta, density) => formatRow(row, meta, density)
);
const count = derive([labels], labels => labels.size);
const runtime = createProjectionRuntime({ onError: console.error });
runtime.get(decorated);
runtime.get(count);
```

React 使用 `ProjectionProvider` 提供 Runtime，再用 `useProjection` 读取 Projection，单键读取写成
`useProjection(projection, selector)`；`useInput` 返回值和 setter。`derive.keyed`
负责保持 key 的 selector 与声明式 dynamic keyed lookup，reverse dependency index
由 Runtime 拥有；结果是聚合值或不存在可保留的逐 key identity 时使用 tuple
`derive`。需要自定义 retained/cross-key 算法时再从 `doxum/advanced` 引入高级
collection processor，在同步 callback 中使用 `output.set/remove/order` 与
previous/next。Processor 依赖仍显式声明，React selector 追踪只属于消费端。
