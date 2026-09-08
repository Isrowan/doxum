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
Draft 和内部 readWith 是同步回调内的借用视图，不得逃逸。预期拒绝抛 TransactionRejected；普通异常完整恢复后
原样抛出。正常返回 false/undefined 是业务结果，不表示拒绝。

object 暴露可编辑成员；field 是原子值，包括对象和数组。Infer 与作用域内原子值深只读；
输入、快照、commit 和 history 共享 payload 引用，删除后也不能通过任何别名修改它。
object/variant 结构只接受 schema 声明的自身属性及 variant 判别字段；额外的字符串、Symbol 和不可枚举属性都会被拒绝。
动态键使用 map，任意对象内部数据使用 field；这个限制不检查 field 的 payload 内部。
snapshot 只复制 schema 结构；snapshot(rawPayload) 返回原始只读引用。
发布数据不做运行时冻结，不再支持字段 copier。需要可修改副本或序列化时由应用边界显式处理。

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

校验器是纯同步函数或 Standard Schema v1，直接接收原始引用且不得修改它。
成功返回值被忽略，不复制输入，也不深度检查转换；数据转换在进入 Doxum 前完成。
parse(model, unknown) 复制校验后的结构并共享只读 payload；严格解析要求原子字段具备校验器。品牌键贯穿 map/table 访问、
符号路径和 impact。路径回调描述地址，包括缺失键，订阅注册时解析。
React useDocumentSelector 追踪实际读取，并在选择分支改变时更新依赖。

## 变化与消费者

commit 包含 revision/source/changes/impact。ChangeSet 按所属容器分组，成员以
added/removed/updated 携带直接 before/after，不使用 Presence 包装。
顺序变化放在同一 members 分组的可选 order.before/after 中；纯排序的 members 为空。
不接受独立 order 记录或同地址重复分组，apply 逐组完成成员与顺序安装。
tree 保留拓扑语义，reset 显式表达整体根过渡；根成员分组仍是增量变化。
净零事务不发布。
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
附着期间禁止外部 replace 和外部标记 remote 的 apply。版本 5 / 格式 3 拒绝旧存储，
保留数据且不迁移。适配器仅接收 JSON 值，变化数量限制统计逻辑成员和树节点，不能按外层分组数绕过。
限额仅约束新产生的本地提交；减小当前限额不影响既有持久化提交的读取。
整个已发布 ChangeSet 都必须只读，其身份可复用结构校验结果，但不跳过本地 revision、schema 和真实 before 检查。
