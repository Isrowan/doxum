# Runtime 不变量

1. createDocument 唯一拥有 canonical state；Draft、apply、replace 共用 MutationSession。
   runtime 统一执行、回滚、seal、发布边界，history 同样复用。
   mutation/operations 按 table/list/order/tree/replay 分类完整操作，session 持有写入内核。
   scope 经 session 绑定已解析事实，同 generation 复用 handle；这些均为内部实现边界。
2. 公共读写同步且有作用域，禁止重入写入。失败恢复之前全部工作；普通异常原样抛出，
   TransactionRejected 转换为 application issues。内部 readWith 返回借用 reader，
   reader、子 proxy 和 collection method 不得逃逸同步回调。
3. mutation/changes.ts 统一解析 unknown ChangeSet；schema 为寻址真值。
   拒绝父子重叠事实与同地址重复分组。逐容器安装成员及可选顺序，不接受独立 order 记录。
4. ChangeRecorder 按所属容器分组记录首次成员旧值，唯一拥有顺序基线和触及树节点。回滚不调用用户回调或
   校验器，seal 只发布净变化。
   capture、restore 和按域 seal 分离；当前顺序确实变化后才复制最终 order，净变化为零也保留执行期间的回滚基线。
5. 原子值按 Object.is 比较，canonical 结构依所有权契约保留原子引用；
   快照只复制结构，payload 与 commit、history 共享且只读，不做深复制或发布冻结。
   校验器直接读取原始输入，必须纯同步，成功返回值被忽略。
6. list 以稳定键标记身份，替换值必须保留键。anchor 拥有排序语义；
   tree 拥有双向一致、连通、无环、空树或单根的拓扑约束。
7. ObjectNode 拥有定义身份，runtime 拥有实例身份；共享路径 compiler 和
   impact-target 拥有寻址、身份、相等、分桶和精确匹配，React 也遵守此边界。
   通知直接匹配分组变化，不构建 commit impact 索引。
8. apply 要求 expectedRevision，记录本地真实旧状态。本地 reset 可撤销，
   remote commit 使 history 失效；group 在单个 session 中旅行。
9. projection 显式声明 source，先于监听结算。通知失败不撤销提交；
   batch 推迟投影发布，不推迟文档提交与文档监听。
10. local-sync 使用 Web Lock 领导权和连续 durable seq，先可见后异步持久化。
    版本 5 / 格式 3 拒绝旧数据库并保留原数据，附着期间禁止外部 replace 和 remote apply。
11. core 框架无关，公开导出需明确用途；根 dist 为构建产物。
12. 测试 malformed 输入、部分失败回滚、history、impact、dispose 和大集合工作量。
    删除旧 API 和平行协议。

网络意图、鉴权、协作撤销、先持久化后可见属于独立需求，不是隐藏 runtime 能力。
