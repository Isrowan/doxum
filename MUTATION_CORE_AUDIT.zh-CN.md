# Mutation 核心流程收敛记录

## 目标与范围

本轮沿 Draft / apply / history / local-sync 到 recorder、impact、订阅的完整调用链审查。
目标是降低理解一次写入所需跨越的模块与协议数量，同时保留原子回滚、精确净变化和按触及数据量工作的性能约束。
不保留旧 ChangeSet 或旧存储格式兼容层。

## 最终职责

| 模块                             | 唯一职责                                           | 消费者与生命周期                                                 |
| -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `runtime.ts`                     | canonical document、revision、写入排他、提交与通知 | 每个文档实例；只通过 session 写入                                |
| `access/scope.ts`                | Read/Draft、访问缓存、依赖收集与有效期             | 每次同步回调；不组织树编辑和 recorder capture                    |
| `address.ts`                     | schema 驱动的值、容器、成员解析                    | schema 布局共享；已解析 canonical 位置受 session generation 限制 |
| `mutation/session.ts`            | 完整修改操作：解析、验证、capture、安装            | 每个事务；Draft、apply、history 共用                             |
| `mutation/recorder.ts`           | 首次状态、覆盖吸收、回滚与最终差异                 | 每个事务；不保存逐写入正向/逆向日志                              |
| `mutation/state.ts`              | 成员及顺序的底层安装                               | 无独立状态；session 安装合法值，recorder 恢复已捕获值            |
| `mutation/anchor.ts`             | 有序键、锚点、list 索引失效                        | 正向操作和回滚共享                                               |
| `mutation/tree.ts`               | 树拓扑验证和树操作算法                             | session 调用；不依赖 access                                      |
| `mutation/changes.ts`            | unknown 解码、冲突验证、确定性发布                 | 边界模型；已验证对象依只读契约复用                               |
| `impact.ts` / `impact-target.ts` | 净变化查询、精确目标匹配                           | 只消费最终 ChangeSet；不重新解释 mutation 意图                   |

新增的 `state.ts` 从 recorder 移出安装函数与 CanonicalState 类型，不创建状态副本、管理器或第二写入入口。
新增 `resolveValue` 返回一次解析得到的 schema 和值，支持真实子树根；删除 resolver 已无调用者的成员定位入口。
session 的成员操作直接调用 resolver.container 构造已解析容器，避免中间值结果对象。

## 删除的重复流程

### 容器协议完整化

公开 Change 仅保留 `members`、`tree`、`reset`。成员和顺序共同表达一次容器状态过渡：

```ts
{
  kind: 'members',
  at: ['rows'],
  members: [{ key: 'b', kind: 'added', after: { n: 2 } }],
  order: { before: ['a'], after: ['b', 'a'] },
}
```

纯排序为 `members: []` 加 `order`。无成员也无顺序的空组、独立 order 记录、同地址拆分组均拒绝。
未知输入在解码时完成形状、重复、重叠验证；发布时将 recorder 的成员与顺序贡献合成同一组。
成员、树节点、顺序仍按逻辑变化数量计入 local-sync 限额，不能通过合并外层记录绕过限制。

apply 的主线现在是：

1. 解析一个容器。
2. 记录真实本地 before，写入该组成员。
3. 检查最终键集合并安装该组 order。
4. 处理下一组；全部成功后 seal 和 publish。

删除全局预处理、末尾 order 扫描、JSON 地址编码和待验证表 Map。
容器 order 与已有成员的后代字段变化可以共存；父级成员整体替换与后代事实仍不允许重叠。

### 操作与寻址归位

table create/remove 按批次解析容器，直接走公共成员写入逻辑，不再每条 entry 拼地址后重入 replace/remove。
list 操作复用已解析容器和索引。order/tree capture 接收当前已解析数据，不再在 recorder 内重复寻址。
tree remove/move 与 insert/set 一样由 session 提供完整操作；scope 不再跨层组合树算法与 capture 回调。
table/list get 一次读取当前值并定位成员，同时保留缺失成员的依赖订阅。

### recorder 生命周期显式化

子树吸收拆为重建 before 和释放已覆盖事实，直接使用真实 DocumentNode。
删除 `as ObjectNode`、伪文档包装和安装伪根成员的路径。
group、order、tree 的登记和删除统一维护事实集合、父对象注册表与覆盖索引。
固定成员用 schema slot，动态成员用 Map；这两种领域布局保留，不增加统一容器抽象。

### 访问有效期一致化

保存的集合方法会检查回调是否结束，以及当前地址是否仍对应取得方法时的 schema node。
同 schema 的值替换后继续通过逻辑地址工作；切换到不同 schema node 后，旧方法抛出 TypeError。
重新从 Proxy 读取方法即可取得当前 schema 的操作。普通异常离开 update 时仍完整回滚并原样抛出。
有效期检查函数在 scope 内共享，不为每次获取集合方法额外分配检查闭包。

## 有意保留的复杂度

- **先恢复成员，再恢复顺序**：被删除的成员必须先回来，order 才能正确安装。内部 OrderFact 是回滚基线，和已删除的公开 order 记录不同。
- **generation 与逻辑地址**：替换结构后，旧 Proxy 不能继续指向脱离文档的对象。固定路径缓存与动态键缓存各自保留在 scope 内。
- **惰性覆盖索引**：大量 scalar 写入不需要结构吸收；不能为缩短代码而每次构建全部成员地址。
- **结构复制**：快照和已发布 before/after 不能被后续 canonical 修改污染。仅复制可编辑 schema 结构，payload 继续依约定共享，不增加冻结或深 clone。
- **验证**：省略重复解析不等于省略值、键、order 集合或树拓扑验证。未知包不信任 before，undo 仍以实际本地旧值为准。
- **runtime 边界差异**：update 有返回值和 Draft 有效期，apply 有 expectedRevision 与解码，history 有批次旅行，replace 有整体替换策略。保留明确入口与现有公共 publish，不为消除少量 try/finally 重复增加通用回调框架。
- **schema-only 查询**：某些不存在数据的路径仍能解析 schema。scope 缺失后代访问所需的 schema 查询不强行替换成必须有数据的定位操作。

## 协议与文档

local-sync 使用 IndexedDB version 5、record format 3。上一代 version 4 / format 2 被明确拒绝，拒绝时保留原数据。
README、架构文档、AGENTS 和中英文 runtime 使用指南统一采用最终协议。

## 验证

新增 `core/test/mutation-flow.test.ts` 覆盖完整容器发布、解码、部分执行后回滚、undo/redo、精确 impact、纯排序通知、逻辑限额、批量寻址和访问有效期。
local-sync 覆盖新分组的持久化、在线 follower、重开回放与上一代格式拒绝。
现有大集合、随机事务、树边界、订阅与 React 测试继续作为整条链路的回归约束。

性能对比使用改动前独立 dist 与最终 dist，在相同 Node、相同公共工作负载下交替运行。
原始 `test.mjs` 不修改。运行结果和局限在完成验证后记录于下节。
