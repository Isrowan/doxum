# Doxum 使用指南

## 定义、修改与读取

```ts
import { createDocument, field, map, object, select, snapshot, type Infer } from 'doxum';

const task = object({ title: field<string>(), done: field<boolean>() });
const model = object({ tasks: map(task) });
type DocumentValue = Infer<typeof model>;
const document = createDocument({
  schema: model,
  initial: { tasks: { a: { title: 'Write', done: false } } },
});
document.update(draft => {
  const task = draft.tasks.a;
  if (task) task.done = !task.done;
  draft.tasks.b = { title: 'Review', done: false };
  return { warnings: [] };
});
const done = select(document, state => state.tasks.a?.done);
const tasks = select(document, state => snapshot(state.tasks));
document.subscribe(
  path => path.tasks.item('a').done,
  commit => console.log(commit.changes)
);
```

根 object 是定义身份，runtime 拥有状态与 revision。事务同步且原子，修改立即可读。
结构作用域在回调结束后失效。预期拒绝抛 TransactionRejected；普通异常完整恢复后
原样抛出。正常返回 false/undefined 是业务结果，不表示拒绝。

object 暴露可编辑成员；field 是原子值，包括对象和数组。作用域内原子值深只读；
canonical 复制保留原子引用，调用方必须遵守所有权边界，不能继续修改已传入的 payload。
snapshot 返回独立值。需要使用字段 copier 时对所属结构取快照；
单独原子值没有 schema 信息，只进行通用复制。

Infer 保留 optional 属性和扁平 variant 联合。Read/Draft 带集合方法；
含 table/list/tree 数据的整体替换使用 assign(scope, key, inferValue)。

## 容器与校验

| 声明                             | 数据          | Draft 方法                                                    |
| -------------------------------- | ------------- | ------------------------------------------------------------- |
| map(valueSchema, { key }?)       | record        | 索引、赋值、delete                                            |
| table(objectOrVariant, { key }?) | ids/byId      | get/has/ids/create/remove/move                                |
| list(field, { keyOf })           | 普通数组      | get/has/ids/insert/set/remove/move/replace                    |
| tree(field)                      | rootId?/nodes | get/has/rootId/parent/children/insert/set/remove/move/replace |

Read 只暴露读取方法。map 支持 field/object/variant。list 替换项必须保持寻址键。
简单数组与笔画可作为一个原子 field。optional 支持 field/variant/map/list/tree，
缺失与存在的 undefined 不同。variant tag 只读，通过整体替换切换分支。

校验器支持同步、不转换值的函数与 Standard Schema v1。parse(model, unknown)
返回独立校验值；严格解析要求原子字段具备校验器。品牌键贯穿 map/table 访问、
符号路径和 impact。路径回调描述地址，包括缺失键，订阅注册时解析。
React useDocumentSelector 追踪实际读取，并在选择分支改变时更新依赖。

## 变化与消费者

commit 包含 revision/source/changes/impact。ChangeSet 只包含最终值/存在性、
顺序与触及树节点事实，净零事务不发布。
apply(changes, { expectedRevision }) 拒绝缺失或不匹配的本地基线；来包 before
不作为本地 undo 真值，记录真实旧状态。history 重放完整 ChangeSet，分组原子旅行。
本地 replace 是可撤销根重置，remote commit 使 history 失效。
observerErrors 属于已提交结果。

集合映射使用 projection.document(document).collection(path => path.tasks)
和 projection.map。纯派生值使用 projection.value(sources, compute)；
有状态算法使用 value spec 或 projection.collection<T>()(spec)，sources 显式声明。
input/fromReadable 接入外部边界值。随所属服务 dispose。
batch 推迟投影结算与通知，但不推迟文档提交和文档通知；内部读取上次发布值，
不提供跨文档回滚。

doxum/local-sync 附着 IndexedDB 和 Web Lock 领导权，只有 leader 写入，
follower 连续重放 durable seq。先可见后异步落盘，flush 等待持久化。
附着期间禁止外部 replace 和外部标记 remote 的 apply。版本 3 / 格式 1 拒绝旧存储，
保留数据且不迁移。适配器仅接收 JSON 值。
