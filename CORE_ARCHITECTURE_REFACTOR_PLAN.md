# Doxum Core 架构收敛与重构方案

状态：已按长期目标态实施完成（2026-09-19），不保留兼容层。

实施说明：本文前半部分保留的是重构前的审查证据与问题描述，因此其中会继续出现
旧文件名和旧协议名；它们不代表当前源码仍保留这些入口。最终源码已完成 P0、P1，
并执行了不引入新协议的 P2 document dirty routing 拆分。

最终验证：

- `pnpm run format`：通过。
- `pnpm run check`：通过，18 个测试文件 / 202 个测试全部通过，Projection surface guard 通过。
- `pnpm run build`：通过；构建入口仅保留 root、local-sync、react、advanced，不再生成 integration。
- `pnpm run bench`：通过。
- `pnpm run profile`：通过。
- `git diff --check`：通过。
- 删除协议/旧路径搜索：源码、测试、README、architecture、AGENTS、skills、package/build 配置均无残留。
- Runtime identity registry：Core runtime 中只剩 `runtime/context.ts` 的一个 WeakMap。

目标：审查整个 core，而不是只看 Projection。按长期目标态减少概念、helper、中间协议和错误依赖方向，让复杂算法有明确 owner，让状态生命周期有唯一 owner，让内部调用从命名上能看出所属领域。

## 1. 总结

当前 Core 的主干已经比较健康：

- createDocument 是 canonical document 的唯一写 authority。
- MutationSession 是事务写 kernel。
- ChangeRecorder 是 first-touch、rollback、final ChangeSet 的 owner。
- ProjectionRuntime 是 Projection materialized state 的唯一 owner。
- Projection 最近的 collection / output / graph / source / readable 分层已经明显清晰。
- 当前 core/src 没有 runtime import cycle。

因此，这轮不应该因为文件大就继续机械拆分。

真正值得做的结构性收敛主要有六件事：

1. 把通用 Readable<T> 和 document selector 从 Projection 域上移。
   runtime/contract.ts、local-sync 和 React 现在反向依赖 projection/readable/contract.ts；projection/select.ts 实际完全是 document runtime 能力。

2. 把一个 Document Runtime 被拆开的多套 side registry 收敛成一个 private RuntimeContext。
   当前 access、driver、notification 分别维护 WeakMap，并通过多组 bind/share/lookup 函数拼回同一个 runtime 生命周期。

3. 消除 doxum/integration 对 ImpactTarget、地址和 dependency tracking protocol 的泄漏。
   React 应消费一个 Core-owned tracked Readable，而不是自己管理 track -> targets -> subscribeDependencies -> sameTarget -> rebind。

4. 把 address.ts 中混在一起的几类算法边界分开，同时把 schema member layout 归还给 schema。
   address.ts 目前同时承担地址 identity、schema/document traversal、member layout、writable container resolution、relation 和 trie index。

5. 把跨域纯算法放回正确领域：tree topology、ordered sequence / anchor、record primitives。
   特别是 schema value 和 address 当前依赖 mutation/tree.ts，说明 tree topology 实际不是 mutation 私有概念。

6. 内部算法模块统一 owner-qualified namespace-style 调用；状态 owner 使用对象或类；公共 API 继续保持直接导出。
   这里的 namespace-style 指 ES module namespace import，例如 address.resolveValue，而不是 TypeScript namespace 声明。

如果只做一轮高收益重构，建议优先完成 P0 和 P1。暂时不要继续拆 ChangeRecorder、Projection Scheduler、Projection Runtime、Local Sync Session 这类已经有单一 owner 的大文件。

---

## 2. 当前规模与依赖证据

当前 core/src 约 10,385 行。

主要大文件：

| 文件                                 | 行数 | 判断                                                                |
| ------------------------------------ | ---: | ------------------------------------------------------------------- |
| access/scope.ts                      |  664 | 大，但多数复杂度来自一个 Proxy/access state machine；不能仅按行数拆 |
| address.ts                           |  555 | 职责确实过宽，应拆算法域                                            |
| mutation/recorder.ts                 |  510 | 大但 owner 清楚，优先保持                                           |
| projection/source/document.ts        |  470 | connection lifecycle + ChangeSet dirty routing 仍可再隔离           |
| projection/runtime.ts                |  454 | Runtime owner，保持                                                 |
| projection/graph/scheduler.ts        |  450 | Scheduler state machine，保持                                       |
| projection/advanced.ts               |  409 | public advanced API + group compiler，可低优先级隔离 compiler       |
| local-sync/session.ts                |  403 | 一个明确的 leader/follower state machine，保持                      |
| schema.ts                            |  398 | 大量是 type-level path grammar，不等于 runtime complexity           |
| projection/source/registry.ts        |  366 | source kind registry/composition，当前合理                          |
| projection/source/boundary.ts        |  357 | source lifecycle owner，当前合理                                    |
| projection/definition.ts             |  347 | public DSL + internal definition protocol，有一定混合但不是 P0      |
| schema-value.ts                      |  309 | validation/copy/equality/parse 同域，可归档并收窄 export            |
| projection/source/materialization.ts |  307 | pure structural sharing，当前 owner 正确                            |
| projection/output/collection.ts      |  304 | collection output lifecycle，当前 owner 正确                        |

高 fan-out 模块：

- runtime.ts：约 18 个内部依赖。
- projection/source/document.ts：约 16。
- access/scope.ts：约 15。
- projection/runtime.ts：约 12。
- integration.ts：约 10。
- mutation/recorder.ts：约 9。

高 fan-in 基础模块：

- schema.ts。
- runtime/contract.ts。
- projection/contract.ts。
- address.ts。
- changes.ts。
- schema-value.ts。
- ordered-key.ts。

当前没有 runtime import cycle。这说明目标不是修循环，而是减少错误领域依赖和隐式 side protocol。

---

## 3. 当前 Core 接口与函数清单

下面列当前跨文件可见 surface。module-local nested callback 不作为架构接口列出。

### 3.1 Schema

#### schema.ts

主要类型：

- DocumentAddress
- DocumentAnchor
- ReadonlyValue
- DocumentListConfig
- DocumentTreeNode
- DocumentTreeValue
- FieldNode
- OptionalNode
- ObjectShape
- ObjectNode
- VariantShape
- VariantNode
- TableNode
- MapNode
- ListNode
- TreeNode
- DocumentNode
- Infer
- EntitySchemaNode
- ValueSchemaNode
- TreeTarget
- CollectionSelector
- ValueSelector
- ImpactTarget
- SchemaPath
- PathPick
- CollectionPath
- CollectionId
- CollectionEntry
- PathValueOf

主要函数：

- collectionEntryNode
- field
- optional
- object
- variant
- table
- map
- list
- tree
- compilePath

结论：公共 schema DSL 和 symbolic path grammar 是稳定领域。这里不建议仅因为 398 行继续拆 type-level grammar。

#### schema-value.ts

类型 / error：

- Validator
- ParseIssue
- ParseError

函数：

- checkScalar
- checkKey
- checkValue
- checkTreePayload
- copyTreeNode
- equalTreeNode
- copyValue
- equalValue
- parse

其中 checkScalar 只有本文件自己调用，不应继续 export。

### 3.2 Address / Impact

#### address.ts

类型：

- AddressRef
- ResolvedAddress
- FixedMember
- CompiledMember
- FixedLayout
- MemberLayout
- ResolvedContainer
- ResolvedTreeContainer
- AddressIndex

函数：

- resolveAddress
- nodeAt
- readSegment
- read
- compiledShape
- resolveContainer
- resolveTreeContainer
- memberKey
- createAddressResolver
- resolveValue
- resolveLocated
- resolveChild
- contains
- overlaps
- debugKey
- same

readSegment 只在本文件内部使用，应该 private。

#### impact-target.ts

函数 / class：

- tree
- address
- id
- belongs
- same
- indexedAddress
- visitChangedLocations
- affected
- SubscriptionIndex

这是典型的算法 namespace 模块。

#### impact.ts

类型：

- CollectionImpact
- DocumentImpact

函数：

- createImpact
- affectsTarget
- collectionImpact

collectionImpact 当前没有生产 consumer；affectsTarget 只有测试 consumer。两者共同导致 impact.ts 为 public impact object 额外维护一个 private WeakMap implementation registry。

### 3.3 Access

#### access/dependency.ts

- DependencyTracker
- createDependencyTracker

#### access/scope.ts

公共 / 跨模块类型：

- Read
- Draft
- AccessContext
- CollectionAccess

函数：

- snapshot
- replace
- createAccess
- collectionAccess

collectionAccess 当前没有 consumer。

内部主体还包含：

- scope Target / Location。
- target refresh。
- child cache。
- dependency collection。
- map/table/list/tree method dispatch。
- Proxy handler。
- mutation operation dispatch。

这是一个大但相对单一的 state machine。

### 3.4 ChangeSet / Mutation

#### changes.ts

- ValueTransition
- MemberChange
- Change
- ChangeSet
- ChangeDirection

#### mutation/changes.ts

- sealChanges
- decodeChanges
- changeCount

它同时保存 validated ChangeSet identity，是唯一 unknown ChangeSet boundary。

#### mutation/issue.ts

- MutationIssueCode
- MutationIssue
- MutationRejected
- at
- fail
- invalidValue

#### mutation/session.ts

- MutationSession

核心方法：

- validate
- resolveContainer
- bind
- bindTree
- resolveTree
- replace
- assignMember
- removeMember
- definition
- writeMember
- invalidate
- finish
- rollback

#### mutation/recorder.ts

- ChangeRecorder

内部算法：

- first-touch member lookup/removal。
- member transition。
- member publication。
- subtree diff。
- restore/reconstruct。
- member/tree seal。
- coverage index。
- rollback。

这些算法围绕一个 recorder fact model 工作，不建议为了拆文件把 fact model 变成新的跨模块协议。

#### mutation/state.ts

- CanonicalState
- installMember
- orderOf
- installOrder

#### mutation/anchor.ts

- moveSelection
- index
- valid

#### mutation/tree.ts

- MutableTreeNode
- MutableTree
- TreePosition
- is
- validNode
- contains
- parent
- children
- validate

#### mutation/operations/*

- map：put / remove
- table：create / remove / replace
- list：insert / remove / replace
- order：move / reorder
- tree：insert / replace / remove / move
- replay：apply

operations 现在是完整 domain commands，不拥有 canonical state，这个边界应保留。

### 3.5 Ordered / Value primitives

#### ordered-key.ts

类型：

- KeyOrder
- OrderedKeys
- ListSequence

函数：

- equal
- keys
- indexedKeys
- toArray
- listSequence
- insert
- remove
- installKeys
- installList
- install
- matches

这是当前 namespace-style 使用最好的模块之一，多数 caller 已经使用 ordered.*。

#### value/ownership.ts

- isPlainObject
- isRecord

#### value/record.ts

- installOwn

两个文件都很小，而且语义都属于 safe record operations。

### 3.6 Runtime

#### runtime.ts

- createDocument

内部拥有：

- canonical state。
- revision。
- write lock / reentrancy。
- authorize。
- mutate。
- rollback。
- seal。
- publish。
- history。
- notification。
- public runtime object。

这条 lifecycle 应继续作为单一 owner，不建议抽成一串 prepare/execute/finalize helper。

#### runtime/contract.ts

主要类型 / error：

- Unsubscribe
- Synchronous
- CommitSource
- DocumentReentrancyError
- DocumentDisposedError
- DiagnosticInput
- DocumentDiagnostic
- DocumentProblem
- TransactionRejected
- DocumentCommit
- ObserverError
- TransactionResult
- OperationResult
- HistoryState
- LocalHistory
- CommitListener
- DocumentReadable
- DocumentRuntime

注意：这里目前反向 import projection/readable/contract.ts，仅为了 Readable<HistoryState>。

#### runtime/access.ts

- RuntimeAccessState
- bindRuntimeAccess
- accessOf
- readWith

拥有独立 WeakMap。

#### runtime/driver.ts

- RuntimeWriteIntent
- RuntimeWriteDriver
- RuntimeWriteDriverLease
- bindRuntimeDriver
- assertRuntimeWritable
- installRuntimeWriteDriver
- disposeRuntimeDriver

拥有另一套独立 WeakMap。

#### runtime/notification.ts

类型：

- ProjectionAttachment
- RuntimeNotification

函数：

- bindDocumentReadable
- documentReadableOwner
- createNotification
- shareNotification
- attachProjection
- subscribeRoot
- subscribeTargets
- notify
- subscribeDependencies
- disposeNotification

拥有：

- runtime -> notification WeakMap。
- readable -> owning document WeakMap。
- root listeners。
- target listeners。
- processor attachments。
- publish phase。

这是当前 Core 内部最典型的“一个 stateful owner 被表现成很多 free functions”的模块。

#### runtime/readable.ts

- asReadable

#### history.ts

- createHistory

只有一个 factory，内部闭包就是完整 history owner；无需为了 class 化而重构。

### 3.7 Document selector / Integration

#### projection/select.ts

- DocumentSelector
- read

它没有 Projection dependency，实际属于 document runtime/access。

#### integration.ts

- TrackedSelection
- track
- subscribeDependencies
- sameTarget
- ImpactTarget
- AddressRef
- contains
- overlaps
- debugKey
- readAddress
- resolveAddress

React 实际只使用：

- track
- subscribeDependencies
- sameTarget
- ImpactTarget

地址类 integration exports 在仓库中的 React adapter 没有 consumer。

### 3.8 Projection

#### Public spine

projection/definition.ts：

- Projection
- Input
- input
- observe
- derive
- OutputDefinition
- ValueOutputEvaluation
- CollectionOutputEvaluation
- ProcessorEvaluation
- Rebuild
- ProcessorInstance
- SourceDefinition
- ProcessorDefinition
- ProducerDefinition
- ProjectionRef
- projectionRef
- producerOf
- isProjection
- ownProjection
- defineProcessor

projection/runtime.ts：

- ProjectionRuntime
- ProjectionScope
- createProjectionRuntime

projection/advanced.ts：

- incremental
- value / collection / group processor context types
- group output declaration types

#### Internal domains

projection/collection/change.ts：

- createCollectionChange
- diffCollection
- collectionChangedKeys
- collectionHasStructuralChange
- collectionHasAnyChange

projection/collection/index.ts：

- PersistentKeyedIndex

projection/collection/view.ts：

- mapRead
- collectionView
- snapshotCollectionView

projection/output/value.ts：

- ValueOutputEvaluation
- ValueOutputState
- createValueOutput

projection/output/collection.ts：

- CollectionOutputEvaluation
- CollectionOutputState
- createCollectionOutput

projection/graph/processor.ts：

- createProcessor

projection/graph/scheduler.ts：

- OutputRecord
- SourceBoundaryRecord
- ProcessorRecord
- ProducerRecord
- Scheduler
- createScheduler
- assertSynchronous
- assertScope

projection/source/boundary.ts：

- KeyedInputDraft
- SourceWrite
- SourceMaterialization
- SourceMark
- CollectionMark
- ValueBoundary
- CollectionBoundary
- createValueBoundary
- createCollectionBoundary

projection/source/document.ts：

- createDocumentSourceRegistry

projection/source/materialization.ts：

- DocumentDirty
- createDocumentDirty
- clearDocumentDirty
- hasDocumentDirty
- markDocumentReplace
- markDocumentOrder
- markDocumentTree
- materializeDocumentValue

projection/source/registry.ts：

- createSourceRegistry

projection/readable/selection.ts：

- ProjectionReadableSource
- isMapLike
- createDirectReadable
- createSelectorReadable

projection/readable/contract.ts：

- Readable<T>

这里最大的 ownership 问题不是 Projection 自身，而是 Readable<T> 不应该归 Projection。

### 3.9 Local Sync

local-sync/contract.ts：

- LocalSync errors。
- LocalSyncState。
- LocalSync。
- AttachLocalSyncOptions。

local-sync/session.ts：

- attachLocalSync

内部 state machine：

- restore。
- queue。
- persist。
- record。
- leader claim / lease。
- follower restore。
- BroadcastChannel。
- dispose。

local-sync/timeline.ts：

- StoredDocument
- StoredCommit
- IndexedDbTimeline
- openIndexedDbTimeline

local-sync/json.ts：

- JsonValue
- JsonChangeLimits
- defaultJsonChangeLimits
- LocalSyncDataError
- json
- jsonChanges

Local Sync 当前大体是清楚的 boundary + state machine，不建议拆成 lock/channel/queue service。

---

## 4. 最终目标分层

建议最终 dependency direction 固定为：

    Core primitive contracts
      schema / Readable / ChangeSet
              |
              v
    Pure domain algorithms
      schema value/layout
      address
      order
      tree topology
      impact target
              |
              v
    Canonical access + mutation
      access
      MutationSession
      ChangeRecorder
      operations
              |
              v
    Document Runtime
      runtime context
      notification
      history
      document selection
              |
              v
    Derived / persistence capabilities
      ProjectionRuntime
      local-sync
              |
              v
    Framework adapters
      React

禁止的反向依赖：

- Runtime contract -> Projection。
- schema value -> mutation command layer。
- React -> ImpactTarget / AddressIndex / dependency tracker。
- public DocumentReadable -> internal AddressRef protocol。
- pure algorithms -> runtime registry/context。

---

## 5. P0：把 Readable<T> 提升为 Core primitive

### Evidence

当前：

- projection/readable/contract.ts 定义 Readable<T>。
- runtime/contract.ts 为 history import 它。
- local-sync/contract.ts 为 LocalSync state import 它。
- React 直接消费它。

### Lowest wrong boundary

Readable<T> 不是 Projection model。

它是 Core 最基础的外部 store/read publication contract：

    current()
    revision()
    subscribe()

### Final state

移动为：

    core/src/readable.ts

所有 runtime / projection / local-sync / react 直接依赖这个 Core primitive。

删除：

    projection/readable/contract.ts

Projection 仅保留：

    projection/readable/selection.ts

### Invariant

基础 runtime contract 永远不依赖 Projection。

---

## 6. P0：Document selector 从 Projection 移回 Runtime

### Evidence

projection/select.ts 只有：

- DocumentSelector。
- read(document, selector)。

依赖：

- schema。
- access scope。
- runtime contract。
- runtime access。

它没有任何 Projection graph/output/source dependency。

### Final state

移动为：

    runtime/select.ts

保留 one-shot：

    read(document, selector) -> value

同时让 tracked selector publication 也归这里，作为 integration 收敛的基础。

删除：

    projection/select.ts

### Invariant

读取 document 与定义 Projection 是两个领域。

---

## 7. P0：收敛 Document Runtime 的 side registries

### Evidence

同一个 runtime identity 当前分别注册到三组状态：

runtime/access.ts：

    WeakMap<runtime, RuntimeAccessState>

协议：

- bindRuntimeAccess
- accessOf

runtime/driver.ts：

    WeakMap<runtime, RuntimeDriverState>

协议：

- bindRuntimeDriver
- assertRuntimeWritable
- installRuntimeWriteDriver
- disposeRuntimeDriver

runtime/notification.ts：

    WeakMap<runtime, RuntimeNotification>
    WeakMap<readable, owning DocumentReadable>

协议：

- createNotification
- shareNotification
- bindDocumentReadable
- documentReadableOwner
- notificationOf

这些不是三个独立生命周期，而是在重建一个 Document Runtime 的 private identity context。

### Final owner

新增一个且只新增一个：

    runtime/context.ts

概念：RuntimeContext。

它只允许包含同一 document instance 生命周期内真正共享的事实：

- canonical state reference。
- canonical owning runtime。
- disposed / projection lock state。
- write-driver lease state。
- notification center。

它不是 service locator，禁止挂任意以后可能有用的 dependency。

全局只保留：

    WeakMap<DocumentReadable object, RuntimeContext>

asReadable(runtime) 只是把新 read-only capability object 绑定到同一个 context。

### Deleted protocol

删除：

- bindRuntimeAccess。
- bindRuntimeDriver。
- bindDocumentReadable。
- shareNotification。
- documentReadableOwner。
- access/driver/notification 各自的 identity WeakMap。

替换为：

- bindContext。
- contextOf。

这两个函数就是 runtime identity boundary，不再继续抽象。

### Invariant

一个 Document instance 只有一个 internal context identity。

---

## 8. P0：Notification 从 free-function protocol 变成一个状态 owner

### Evidence

runtime/notification.ts 有 10 个 exported function，大多数都把同一个 RuntimeNotification state 当第一个参数，或通过 registry 找回。

### Problem

这让生命周期分散成：

    create
    bind
    share
    subscribe root
    subscribe targets
    attach projection
    notify
    dispose

caller 必须理解 notification 内部拼装顺序。

### Final owner

runtime/notification.ts 只 export 一个 factory 和必要 contract：

    createNotificationCenter(...)

返回一个有明确生命周期的 capability，概念上：

    subscribe(...)
    subscribeTargets(...)
    attachProjection(...)
    publish(...)
    dispose()

实际名称可在实施时按最终调用点收敛，但语义必须是一个 owner，而不是继续增加 free functions。

NotificationCenter 存进 RuntimeContext。

### Deleted protocol

删除：

- createNotification。
- subscribeRoot。
- subscribeTargets。
- notify。
- disposeNotification。

这些能力被 owner 方法吸收。

### Invariant

通知状态、候选集、processor attachment、notify phase 和 cleanup 都只能由同一个 center 修改。

---

## 9. P0：删除低层 doxum/integration 协议

### Evidence

React 当前自己维护：

    track(runtime, selector)
      -> value + ImpactTarget[]

    subscribeDependencies(runtime, targets, listener)

    sameTarget(...)

    targets changed
      -> unsubscribe
      -> resubscribe

这意味着：

- React 知道 Core 的 ImpactTarget。
- React 知道 dependency set 会动态变化。
- React 自己维护 selector cache / target equality / subscription rebinding。
- Core 已经有 Projection readable selector tracking，但 document selector 又维护另一套 consumer protocol。

另外 integration.ts 还公开：

- AddressRef。
- address resolve/read/relation helpers。

而仓库中的 React adapter 完全不使用这些地址 API。

### Final API

让 Core runtime 提供一个 tracked selector readable：

    select(document, selector, equality?) -> Readable<TResult>

这里的 select：

- 初次执行 selector。
- Core 内部记录 dependency targets。
- commit 时只在相关 target 命中后重新执行。
- dependency 改变时 Core 内部 rebind。
- equality 只过滤 selector result。
- 对调用者只暴露标准 Readable<TResult>。

React 最终只做：

    select(...) -> useReadable(...)

React 不再认识：

- ImpactTarget。
- DependencyTracker。
- subscribeDependencies。
- sameTarget。
- address internals。

### Final action

删除：

    core/src/integration.ts
    package export "./integration"

以及：

- TrackedSelection。
- track。
- subscribeDependencies public adapter protocol。
- sameTarget public adapter protocol。
- AddressRef integration export。
- integration address helpers。

如果未来需要第三方 framework adapter，稳定 adapter contract 应该是：

- Readable<T>。
- DocumentReadable。
- select(...)。
- ProjectionRuntime.readable(...)。

而不是内部 target/address primitives。

### Related simplification

DocumentReadable.address 当前仓库里只有测试直接使用。

长期目标建议从 DocumentReadable 删除：

- address.resolve。
- address.read。
- address.contains。
- address.overlaps。
- address.debugKey。

地址是内部 runtime fact，不应该是 document public capability。

### Invariant

Framework adapter 永远不做 Core dependency tracking。

---

## 10. P1：重新划分 Address 内部算法边界

### Evidence

address.ts 当前同时包含：

1. AddressRef/path identity registry。
2. schema/document traversal。
3. read。
4. compiled member layout。
5. resolved writable container。
6. address relation。
7. AddressIndex trie。

并且：

- schema-value.ts 依赖 address.compiledShape。
- recorder 依赖 layout。
- projection materialization 依赖 layout。
- impact-target 只需要 AddressIndex。

### Final structure

不保留新的 address barrel/facade。

    core/src/address/
      resolve.ts
      relation.ts
      index.ts

#### address/resolve.ts

拥有：

- AddressRef。
- resolveAddress。
- nodeAt。
- read。
- resolveValue。
- resolveLocated。
- resolveChild。
- ResolvedAddress。
- ResolvedContainer。
- ResolvedTreeContainer。
- resolveContainer。
- resolveTreeContainer。
- memberKey。
- createAddressResolver。

readSegment 变 private。

#### address/relation.ts

拥有：

- contains。
- overlaps。
- debugKey。
- AddressRef equality，如果最终仍需 same。

如果 AddressRef 完全不再 public，same 也只保留真正 internal consumer 所需的最小形式。

#### address/index.ts

只拥有：

- AddressIndex。

这是独立的 prefix trie algorithm，可被 ChangeSet normalization、impact 和 notification target index 复用。

### Move out of Address

以下不是 address fact：

- FixedMember。
- CompiledMember。
- FixedLayout。
- MemberLayout。
- compiledShape。

它们是 schema-derived member layout，移动到：

    schema/layout.ts

### Invariant

Schema value copying/validation 不应依赖地址模块才能知道 schema shape。

---

## 11. P1：Schema value/layout 收敛

### Final structure

保留：

    schema.ts

作为：

- schema node definition。
- public schema DSL。
- symbolic path grammar/compiler。

新增内部：

    schema/
      layout.ts
      value.ts

schema/layout.ts 拥有：

- compiled fixed member facts。
- fixed slots。
- dynamic entry layout。
- compiledShape。

schema/value.ts 由当前 schema-value.ts 直接迁移，拥有：

- validation。
- parse issue/error。
- copy。
- equality。
- tree payload validation。

内部 caller 统一 owner-qualified 调用：

    schemaValue.check(...)
    schemaValue.copy(...)
    schemaValue.equal(...)
    schemaValue.checkTreePayload(...)

public package 仍然直接 export：

- parse。
- ParseError。
- ParseIssue。
- Validator。

不要把用户 API 改成 schemaValue.parse。

### Export shrink

checkScalar 改为 private。

Validator<T> 建议最终归 schema definition contract，而不是 value implementation，因为它直接决定 field/table/map 的 public schema signature。

### Invariant

Public API 保持易用；namespace-style 只约束 internal code。

---

## 12. P1：Tree topology 从 Mutation command 层下沉成 pure domain

### Evidence

mutation/tree.ts 被以下模块共同依赖：

- schema-value.ts。
- address.ts。
- access/scope.ts。
- ChangeSet decoder。
- recorder。
- replay。
- tree operations。

它自身不依赖 MutationSession，也不写 canonical state。

### Final structure

    tree/
      topology.ts

拥有：

- MutableTree。
- MutableTreeNode。
- TreePosition。
- is。
- validNode。
- validate。
- contains。
- parent。
- children。

mutation/operations/tree.ts 仍然是 tree mutation commands。

内部统一：

    import * as tree from "../tree/topology"

### Invariant

Schema validation 不依赖 Mutation command namespace。

---

## 13. P1：Order 形成一个共享算法域

### Current

ordered-key.ts 已经是 pure shared algorithm。

mutation/anchor.ts 也是 pure anchor/move planning，但物理位置放在 mutation。

### Final structure

    order/
      sequence.ts
      anchor.ts

order/sequence.ts 对应当前 ordered-key.ts：

- keyed list cache。
- order equality。
- list sequence。
- insert/remove/install。
- permutation membership。

order/anchor.ts 对应当前 mutation/anchor.ts：

- anchor validation。
- insertion index。
- bulk move planning。

mutation operation 只负责：

    validate command-specific rules
      -> order algorithm
      -> one canonical install
      -> one invalidate

内部调用：

    sequence.*
    anchor.*

禁止重新出现：

- getOrderIndex。
- findAnchor。
- moveKeysHelper。
- transaction-local parallel order representation。

---

## 14. P1：合并 tiny record helper

当前：

    value/ownership.ts
      isPlainObject
      isRecord

    value/record.ts
      installOwn

这三个能力都属于 safe JS record semantics。

最终只保留：

    value/record.ts

包含：

- isRecord。
- isPlainObject。
- installOwn。

删除：

    value/ownership.ts

这是减少 helper 文件的正确场景：同一稳定低层概念，没有独立 lifecycle。

---

## 15. P1：Impact 删除无 consumer 的 private implementation protocol

### Evidence

impact.ts：

- collectionImpact 无 consumer。
- affectsTarget 只有测试使用。
- 为支持这两个函数维护 WeakMap<impact object, ImpactQueries>。

而 public DocumentImpact.affects / collection 本身已经能直接 closure-capture implementation。

### Final action

删除：

- collectionImpact。
- affectsTarget。
- queries WeakMap。

测试：

- public impact semantics 通过 DocumentImpact.affects / collection 测。
- target matching 算法直接测试 impact/target.ts。

impact-target.ts 移到：

    impact/target.ts

impact.ts 继续作为 public impact owner。

内部使用：

    import * as target from "./impact/target"

---

## 16. P1：内部 namespace-style 规范

### 原则

不是使用 TypeScript namespace 声明。

而是把算法族所属领域体现在 import 和调用名：

    import * as address from "../address/resolve"
    import * as relation from "../address/relation"
    import * as schemaValue from "../schema/value"
    import * as tree from "../tree/topology"
    import * as sequence from "../order/sequence"
    import * as anchor from "../order/anchor"
    import * as issue from "./issue"
    import * as changeSet from "./changes"
    import * as target from "../impact/target"

调用：

    schemaValue.copy(...)
    address.resolveValue(...)
    relation.contains(...)
    sequence.install(...)
    anchor.moveSelection(...)
    issue.fail(...)
    changeSet.decode(...)
    target.affected(...)

### 适用

满足任一条件就优先 namespace-style：

- 一个内部 module export 4 个以上同行为函数。
- 函数名本身很泛，例如 read / resolve / install / valid / same / remove。
- 多个 caller 同时 import 该领域 2 个以上函数。
- 所属领域名能显著提高 call-site 可读性。

### 不适用

以下仍直接 named import：

- 类型。
- 单一 factory，例如 createHistory。
- 单一 class，例如 MutationSession。
- 公共用户 API。
- 一眼没有命名碰撞的独立 capability。

### Public API

继续直接：

- field。
- object。
- table。
- createDocument。
- read。
- select。
- input。
- observe。
- derive。
- createProjectionRuntime。

不要把用户 API 改成 schema.field、projection.derive、runtime.create。

内部 ownership 清晰和公共 ergonomics 是两件事。

---

## 17. P1：收窄 accidental exports

当前至少这些 function 没有跨模块 consumer：

- access/scope.ts::collectionAccess。
- address.ts::readSegment。
- schema-value.ts::checkScalar。
- impact.ts::collectionImpact。
- projection/source/materialization.ts::hasDocumentDirty，只在同文件使用。

另外：

- impact.ts::affectsTarget 只有测试调用。

最终：

- 能 private 的 private。
- test 不得成为 internal export 存在的唯一理由。
- 测试应从真正 owner 的 final API 或 pure algorithm entry 测。

---

## 18. Access：保持一个 owner，不为了 664 行制造 AccessKernel

access/scope.ts 是最大的文件，但本轮不建议激进拆。

原因：

- Target、child cache、generation refresh、Proxy handler、collection method 共享同一个 scope lifetime。
- 如果把 map/table/list/tree method factory 拆到 4 个文件，通常需要导出 Target、resolve callback、address callback、mutable callback、dependency callback、container binding callback。
- 最终会制造新的 AccessKernel/helper protocol，只是为了让文件短。

允许的收敛：

- 删除 collectionAccess。
- algorithm imports 改 namespace-style。
- schema layout 从 address 移出后，scope 直接依赖 schema/layout。
- 继续让完整 mutation commands 位于 mutation/operations/*。

明确不做：

- 不加 access/utils.ts。
- 不加 AccessManager。
- 不把每种 collection method 做成独立 service。
- 不创建第二套 read/write target model。

---

## 19. Mutation：大文件保留，重点收窄 module surface

### MutationSession

保持。

它是唯一 write kernel，当前方法表达稳定 mutation capability，不是 helper collection。

### ChangeRecorder

保持。

虽然约 510 行，但：

- fact type。
- first-touch。
- coverage。
- restore。
- seal。
- rollback。

共享一个 state model。

把 diffMember / sealMembers / restore 强行拆出去，会要求暴露 MemberGroup / TreeFact / RestoreFact，反而增加中间协议。

### 推荐调用风格

mutation/changes.ts：

    changeSet.decode
    changeSet.seal
    changeSet.count

mutation/state.ts：

    state.installMember
    state.installOrder
    state.orderOf

mutation/issue.ts：

    issue.fail
    issue.invalidValue

### 不做

- 不把 session 每个 method 再转成 operation object。
- 不把 recorder pure functions 做成 ChangeBuilder 中间层。
- 不合并 ChangeSet 和 Projection CollectionChange。
- 不创建 generic transaction pipeline abstraction。

---

## 20. Projection：现有方向基本正确，只做两类小收敛

Projection 当前已经是 Core 中分层最明确的一块之一。

必做：

1. 删除 projection/readable/contract.ts，改用 Core readable.ts。
2. 删除 projection/select.ts，document selector 移 runtime。

可做但不急：

projection/source/document.ts 仍然包含两部分：

- Document connection / subscription lifecycle。
- ChangeSet -> dirty location routing。

如果后续继续降低 document source 的认知复杂度，可新增：

    projection/source/dirty.ts

只拥有：

- pending dirty representation。
- value/collection ChangeSet routing。
- merge/reset/clear。

source/materialization.ts 仍只做：

    previous + canonical current + dirty
      -> structurally shared next

source/document.ts 只做：

    connection + binding + read source

这是一个真正的算法隔离，而不是为了拆文件。

暂时不拆：

- graph/scheduler.ts。
- projection/runtime.ts。
- source/boundary.ts。
- source/registry.ts。

这些都有明确 state owner。

Advanced：

advanced.ts 中 group shape compile/hydrate 是一块独立纯算法。

只有当 advanced API 继续增长时，再抽：

    projection/advanced/group.ts

当前不是 P0/P1。

---

## 21. Local Sync：不要为了拆 session 再造 transport/service 层

local-sync/session.ts 虽然约 403 行，但它本质上是一个完整 state machine：

- restore。
- leader/follower。
- write guard。
- append。
- broadcast。
- queue。
- flush。
- dispose。

这部分保持在一个 owner 更好。

保留：

- session.ts：orchestration/state machine。
- timeline.ts：IndexedDB persistence boundary。
- json.ts：JSON/ChangeSet admission boundary。
- contract.ts：public contract。

只做命名收敛：

内部可以：

    import * as json from "./json"
    import * as timeline from "./timeline"

必要时将内部非 public helper 从 json/jsonChanges 收敛成：

    json.value(...)
    json.changes(...)

但不需要为 Web Locks / BroadcastChannel 新建 manager/service。

---

## 22. 最终文件结构

目标不是目录越多越好，而是 public spine 在根层，复杂 internal algorithm 才进入稳定子域。

    core/src/
      index.ts
      readable.ts
      schema.ts
      changes.ts
      impact.ts
      history.ts
      runtime.ts
      profile.ts

      schema/
        layout.ts
        value.ts

      address/
        resolve.ts
        relation.ts
        index.ts

      value/
        record.ts

      order/
        sequence.ts
        anchor.ts

      tree/
        topology.ts

      impact/
        target.ts

      access/
        dependency.ts
        scope.ts

      mutation/
        changes.ts
        issue.ts
        recorder.ts
        session.ts
        state.ts
        operations/
          map.ts
          table.ts
          list.ts
          order.ts
          tree.ts
          replay.ts

      runtime/
        context.ts
        contract.ts
        access.ts
        driver.ts
        notification.ts
        readable.ts
        select.ts

      projection/
        advanced.ts
        contract.ts
        definition.ts
        runtime.ts
        collection/
          change.ts
          index.ts
          view.ts
        graph/
          processor.ts
          scheduler.ts
        output/
          collection.ts
          value.ts
        readable/
          selection.ts
        source/
          boundary.ts
          document.ts
          materialization.ts
          registry.ts

      local-sync/
        contract.ts
        index.ts
        json.ts
        session.ts
        timeline.ts

只有在 Projection document dirty routing 继续明显增长时，才增加 projection/source/dirty.ts。

删除旧 owner 文件：

- core/src/integration.ts。
- core/src/schema-value.ts。
- core/src/address.ts。
- core/src/ordered-key.ts。
- core/src/impact-target.ts。
- core/src/value/ownership.ts。
- core/src/mutation/anchor.ts。
- core/src/mutation/tree.ts。
- core/src/projection/select.ts。
- core/src/projection/readable/contract.ts。

这些是 owner 迁移，不保留 internal compatibility barrel。

---

## 23. 最终 public surface 建议

### 保持直接 public exports

Schema：

- field。
- optional。
- object。
- variant。
- table。
- map。
- list。
- tree。
- schema types。
- parse / ParseError / Validator / ParseIssue。

Document：

- createDocument。
- asReadable。
- read。
- select，新增 tracked selector Readable。
- snapshot。
- replace。

Projection：

- input。
- observe。
- derive。
- createProjectionRuntime。
- Projection / Input / ProjectionRuntime / ProjectionScope。

Advanced：

- incremental。

Local Sync：

- attachLocalSync。
- LocalSync contracts/errors。

### 删除 public surface

- doxum/integration 整个 subpath。
- DocumentReadable 中的低层 address capability。

### 统一 React mental model

Document：

    select(document, selector, equality?)
      -> Readable<R>

Projection：

    runtime.readable(projection, selector?, equality?)
      -> Readable<R>

React adapter 最终都只需要 useReadable，不再分别理解 Core 内部 dependency protocols。

---

## 24. Representation / Ownership Ledger

| Concern                      | Current representation                | Current owner                  | Problem                              | Final owner/action                                                                 |
| ---------------------------- | ------------------------------------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Canonical document           | CanonicalState / RuntimeAccessState   | runtime + mutation state types | type ownership 分散                  | RuntimeContext 持 canonical reference；mutation 只消费最小 CanonicalState contract |
| Generic readable             | projection/readable/contract          | Projection                     | 被 runtime/local-sync/React 反向依赖 | Core readable.ts                                                                   |
| Document selector            | projection/select.ts                  | Projection path                | 实际无 Projection 依赖               | runtime/select.ts                                                                  |
| Runtime identity             | 3+ WeakMap registries                 | access/driver/notification     | 同一 lifecycle 多协议                | single RuntimeContext registry                                                     |
| Notification                 | RuntimeNotification + many free funcs | notification.ts                | state owner 暴露成函数协议           | NotificationCenter capability                                                      |
| Framework tracked dependency | ImpactTarget[]                        | integration/React              | adapter 理解 Core target protocol    | Core select(...) -> Readable                                                       |
| Address resolver             | address.ts                            | address                        | resolver/relation/index/layout 混合  | address subdomains                                                                 |
| Member layout                | compiledShape in address              | address                        | schema-derived fact 放错 owner       | schema/layout.ts                                                                   |
| Tree topology                | mutation/tree.ts                      | mutation                       | pure topology 被 schema/address 依赖 | tree/topology.ts                                                                   |
| Ordered sequence             | ordered-key.ts                        | root helper                    | owner 名称弱                         | order/sequence.ts                                                                  |
| Anchor planning              | mutation/anchor.ts                    | mutation                       | pure order algorithm                 | order/anchor.ts                                                                    |
| Record primitive             | ownership.ts + record.ts              | value                          | 过度碎片                             | 合并 value/record.ts                                                               |
| Impact implementation lookup | WeakMap queries                       | impact.ts                      | 只服务 dead/test API                 | 删除                                                                               |
| ChangeSet decoder            | mutation/changes.ts                   | mutation boundary              | owner 正确                           | 保持；namespace-style                                                              |
| Mutation recorder            | ChangeRecorder                        | recorder                       | 大但 cohesive                        | 保持                                                                               |
| Projection graph             | scheduler/processor                   | projection graph               | owner 正确                           | 保持                                                                               |
| Local Sync orchestration     | attachLocalSync closure               | local-sync session             | 大但 single state machine            | 保持                                                                               |

---

## 25. Change-Surface Ledger

永久新增概念必须有删除对。

| Addition               | Role                                 | Replaces / deletes                                          |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------- |
| readable.ts            | generic Core Readable contract       | projection/readable/contract.ts                             |
| runtime/context.ts     | one runtime identity binding         | access/driver/notification 多套 WeakMap/bind protocol       |
| NotificationCenter     | notification state owner             | notification free-function lifecycle                        |
| runtime/select.ts      | one-shot + tracked document selector | projection/select.ts + integration tracking                 |
| select(...)            | Core-owned tracked Readable          | track + subscribeDependencies + sameTarget adapter protocol |
| schema/layout.ts       | compiled schema member layout        | address 内 layout responsibility                            |
| schema/value.ts        | schema value algorithm namespace     | schema-value.ts                                             |
| address/resolve.ts     | address resolution                   | resolver portion of address.ts                              |
| address/relation.ts    | address relations                    | relation portion of address.ts                              |
| address/index.ts       | prefix index                         | AddressIndex portion of address.ts                          |
| tree/topology.ts       | pure tree topology                   | mutation/tree.ts                                            |
| order/sequence.ts      | ordered keyed sequence               | ordered-key.ts                                              |
| order/anchor.ts        | anchor/move planning                 | mutation/anchor.ts                                          |
| merged value/record.ts | record predicates + install          | value/ownership.ts                                          |

如果实施时提出的新 abstraction 不在这个表里，又没有删除现有概念，就默认拒绝，除非出现真正的新产品能力。

---

## 26. 实施顺序

### Phase 0：锁定基线

- [ ] pnpm run check
- [ ] pnpm run build
- [ ] pnpm run bench
- [ ] pnpm run profile
- [ ] 保存 architecture/profile benchmark 基线
- [ ] 记录 package exports

### Phase 1：Core primitive ownership

- [ ] 新建 root readable.ts。
- [ ] runtime/local-sync/projection/react 全部直接使用。
- [ ] 删除 projection/readable/contract.ts。
- [ ] 移 projection/select.ts -> runtime/select.ts。
- [ ] root exports 更新。

验收：

- Runtime contract 不 import Projection。
- document selector 不存在于 Projection 目录。

### Phase 2：RuntimeContext

- [ ] 定义最小 RuntimeContext。
- [ ] runtime create 时只 bind 一次。
- [ ] asReadable alias 到同一 context。
- [ ] access 使用 contextOf。
- [ ] driver 使用 contextOf。
- [ ] notification 使用 contextOf。
- [ ] projection document source 通过 context 找 canonical owner。
- [ ] 删除旧 WeakMaps/bind/share owner lookup APIs。

验收：

- 搜索 Core，runtime identity WeakMap 只剩一个。
- context 不成为 service locator。

### Phase 3：Document tracked selector

- [ ] 把 dependency tracking/rebinding 移入 runtime/select.ts。
- [ ] 新增 select(document, selector, equality?) -> Readable。
- [ ] React useDocumentSelector 只组合 select + useReadable。
- [ ] 删除 React 的 target arrays/sameTargets/rebind protocol。
- [ ] 删除 integration exports。
- [ ] 删除 core/src/integration.ts。
- [ ] 删除 package ./integration。
- [ ] 删除 DocumentReadable.address。

验收：

- React 不 import ImpactTarget。
- React 不 import Core internal adapter package。
- public DocumentReadable 不暴露地址 internals。

### Phase 4：Pure algorithm domains

- [ ] schema-value.ts -> schema/value.ts。
- [ ] schema layout 从 address 移到 schema/layout.ts。
- [ ] address 分 resolve/relation/index。
- [ ] mutation/tree.ts -> tree/topology.ts。
- [ ] ordered-key.ts -> order/sequence.ts。
- [ ] mutation/anchor.ts -> order/anchor.ts。
- [ ] 合并 value record primitives。

验收：

- schema value 不 import mutation command namespace。
- schema value 不为了 layout import address resolver。
- address index consumer 不加载 resolver implementation concept。

### Phase 5：namespace-style 与 export shrink

- [ ] address family namespace-style。
- [ ] schemaValue namespace-style。
- [ ] tree namespace-style。
- [ ] sequence/anchor namespace-style。
- [ ] issue/changeSet/state/target namespace-style。
- [ ] 删除 dead/test-only export。
- [ ] readSegment/checkScalar/hasDocumentDirty private。
- [ ] 删除 collectionAccess。
- [ ] 删除 impact query WeakMap。

验收：

- generic function name在 caller 上有 owner prefix。
- internal module 不因为 test 暴露额外 API。

### Phase 6：Projection document source，可选 P2

- [ ] 评估 source/document.ts 的 dirty routing 是否独立成 source/dirty.ts。
- [ ] 只有当新模块不引入新 protocol 才执行。
- [ ] materialization 继续 pure。

### Phase 7：完整验证

- [ ] pnpm run format
- [ ] pnpm run check
- [ ] pnpm run build
- [ ] pnpm run bench
- [ ] pnpm run profile
- [ ] git diff --check
- [ ] 搜索所有删除 symbol/path
- [ ] 更新 docs/architecture.md
- [ ] 更新 README/package exports
- [ ] 更新 AGENTS ownership 描述

---

## 27. 明确不做的重构

为了防止这轮重构再次长出中间层，以下明确不做：

1. 不创建 core/utils、helpers、common。
2. 不创建 RuntimeManager、ProjectionManager、MutationManager。
3. 不把 MutationSession 方法包装成 command objects。
4. 不把 ChangeRecorder facts 做成另一个公开/internal protocol。
5. 不把 NotificationCenter 再包一层 event bus。
6. 不把 Local Sync Web Locks/BroadcastChannel 拆成 generic transport service。
7. 不因为 scheduler/recorder/session 文件大就拆文件。
8. 不建立 internal barrel index 只为了缩短 import。
9. 不保留旧路径 compatibility re-export。
10. 不用 TypeScript namespace 模拟 module；namespace-style 只指 ES module owner-qualified call。
11. 不把 Projection CollectionChange 与 canonical document ChangeSet 合并。
12. 不把 schema path、address、ImpactTarget 再统一成一个万能路径对象。

---

## 28. 完成标准

最终应能回答下面的问题，而且每个答案只有一个：

### Canonical write 谁拥有？

createDocument -> MutationSession。

### ChangeSet unknown boundary 谁拥有？

mutation/changes.ts。

### ChangeSet first-touch/rollback/seal 谁拥有？

ChangeRecorder。

### Generic Readable contract 谁拥有？

Core root readable.ts。

### Document selector tracking 谁拥有？

Runtime selector layer。

### Runtime identity 谁拥有？

一个 RuntimeContext。

### Notification state 谁拥有？

一个 NotificationCenter。

### Schema member layout 谁拥有？

schema/layout.ts。

### Address traversal 谁拥有？

address/resolve.ts。

### Address prefix index 谁拥有？

address/index.ts。

### Tree topology 谁拥有？

tree/topology.ts。

### Ordered sequence 与 anchor 谁拥有？

order/sequence.ts / order/anchor.ts。

### Projection materialized state 谁拥有？

ProjectionRuntime。

### React 需要知道 ImpactTarget 吗？

不需要。

### internal algorithm 调用能否从名字看出 owner？

应该能，例如：

    schemaValue.copy
    address.resolveValue
    relation.contains
    sequence.install
    anchor.moveSelection
    tree.validate
    changeSet.decode
    issue.fail
    target.affected

如果实施完以后仍需要 caller 手工拼装多个 owner 的隐式协议，说明最低层边界还没有修正确。

---

## 29. 最终优先级

### P0：直接降低概念数和跨层耦合

1. Readable<T> 上移 Core。
2. document selector 移出 Projection。
3. RuntimeContext 合并多套 side registry。
4. NotificationCenter 收敛 lifecycle。
5. Core-owned tracked selector Readable。
6. 删除 doxum/integration 和低层 target/address adapter protocol。

### P1：算法 ownership 与 module surface

7. address 分 resolve/relation/index。
8. compiled layout -> schema/layout。
9. schema-value -> schema/value。
10. tree topology 下沉。
11. order sequence/anchor 归域。
12. 合并 value record tiny helpers。
13. impact dead protocol 删除。
14. internal namespace-style。
15. accidental exports 收窄。

### P2：只有认知复杂度仍然高时再做

16. Projection document dirty routing 独立。
17. Advanced group compiler 独立。

不建议再继续对 Mutation recorder、Projection scheduler、Projection runtime、Local Sync session 做纯文件尺寸驱动的拆分。
