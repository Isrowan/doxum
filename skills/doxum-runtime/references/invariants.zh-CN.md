# Runtime 不变量

1. createDocument 唯一拥有 canonical state；Draft、apply、replace 共用 MutationSession。
2. 读写同步且有作用域，禁止重入写入。失败恢复之前全部工作；普通异常原样抛出，
   TransactionRejected 转换为 application issues。
3. mutation/changes.ts 统一解析 unknown ChangeSet；schema 为寻址真值。
   拒绝父子重叠事实，先安装值和拓扑，再安装最终顺序。
4. ChangeRecorder 唯一记录首次旧值、顺序基线和触及树节点。回滚不调用用户回调或
   校验器，seal 只发布净变化。
5. 原子值按 Object.is 比较，canonical 结构依所有权契约保留原子引用；
   快照独立复制，结构按 schema 比较。
6. list 以稳定键标记身份，替换值必须保留键。anchor 拥有排序语义；
   tree 拥有双向一致、连通、无环、空树或单根的拓扑约束。
7. ObjectNode 拥有定义身份，runtime 拥有实例身份；共享路径 compiler 和
   impact-target 拥有寻址、身份、相等和分桶，React 也遵守此边界。
8. apply 要求 expectedRevision，记录本地真实旧状态。本地 reset 可撤销，
   remote commit 使 history 失效；group 在单个 session 中旅行。
9. projection 显式声明 source，先于监听结算。通知失败不撤销提交；
   batch 推迟投影发布，不推迟文档提交与文档监听。
10. local-sync 使用 Web Lock 领导权和连续 durable seq，先可见后异步持久化。
    版本 3 / 格式 1 拒绝旧数据库并保留原数据，附着期间禁止外部 replace 和 remote apply。
11. core 框架无关，公开导出需明确用途；根 dist 为构建产物。
12. 测试 malformed 输入、部分失败回滚、history、impact、dispose 和大集合工作量。
    删除旧 API 和平行协议。

网络意图、鉴权、协作撤销、先持久化后可见属于独立需求，不是隐藏 runtime 能力。
