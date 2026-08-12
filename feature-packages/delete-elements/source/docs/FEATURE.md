# 删除元素 Feature __FEATURE_VERSION__

状态：官方签名独立 Feature 源码；Connector 只执行签名 Operation，Worker 负责删除图编排，Core 负责确认、证据与投影。

## 用户交互

声明式 `selectionBrowser` 载入后通过一次性后台 action 真实读取 Omnia 权威 Section → Workspace → 元素类型，并明确进入 `ready`、`empty` 或 `error`。`fixed_footer_split` 仅是通用 Surface 布局声明：底部固定显示同一后端投影的目录状态、已选数和真实 action；中部“所在部分”与“当前权威目录”各自纵向滚动，窗口收窄时上下重排但仍各自滚动。它不引入前端状态或 Feature ID 特判。交互式读取最长等待 90 秒；超时显示真实错误和“权威重抓取”，不无限停留在 loading，也不回退缓存。若底层读取超时后仍在收尾，同一或不同安全范围的再次重抓取会立即显示 busy，不再挂满第二轮等待，也不并发扫描；旧读取真正结束后才能开始新的真实读取。成功读取会保存两分钟有效、精确绑定 Connector、session、Pack、安全锁 revision 与显式 Workspace 的权威目录快照。创建计划只消费这份刚保存的快照，缺失、过期、绑定或安全锁不一致时明确要求先“权威重抓取”，不会在创建 action 内再次启动 heavy-read。搜索、折叠、多选和批量选择均作用于该真实目录快照；新计划的冻结目标、图步骤、确认、执行进度、只读核验与终态结果全部投影在 Delete Feature 内，不写 Comments。目录态禁用计划动作；计划态禁用重抓取和重复创建；终态“权威重抓取”返回最新真实目录。旧 0.3.14 pending Comments 计划只允许一次迁移取消，不提交 mutation。Omnia 未返回真实所属 Section 的 Workspace 保持禁用，不推断分组。

Information、GRA、APP、DB、OS、DCNO、TOOL 可进入选择。Infrastructure/Network 以 `DCNO` 进入同一个真实权威目录、搜索、计划和通用 IT Element 删除图；它不是 OS subtype，也不新增 DCNO 专用调度器。Operation 必须把对象读回为精确的 `Infrastructure/Network`，并沿既有 `InfrastructureApplication` 合同冻结与解除 DCNO→APP 关系。明确的其他 Infrastructure subtype 仅从本 Feature 目录排除；类型缺失或歧义仍使读取失败关闭，不能误归类。GRA 由真实 Risk Assessment 双索引和 assessment detail 进入目录；独立选择的 GRA 与 IT Element 派生的同一 GRA 合并为唯一 cascade step。

创建 action 先快速创建 Core `ready_for_review` mutation Run 与私有 `preparing` 计划，随后由声明式隐藏 background action 分批冻结。每个 action invocation 只执行一种最多 8 项的只读批次：选中对象 preflight、派生 GRA preflight 或 relation-group preflight；批次内所有请求都结束且全部成功后，Worker 才一次保存该批结果、精确游标、checkpoint revision 与递增的 Surface revision。失败批次不保存部分结果、不推进游标，并停用自动续作；Surface 显式提供“重试当前冻结批次”，只重做同一只读批次。全部对象、GRA 和关系组 preflight 完成后，单独一次 finalization 才构造完整 graph、调用一次 `prepareReturnIntent` 并进入 `pending_confirmation`。任何关系只选一端都会以 `DELETE.GRAPH_INCOMPLETE` 停在可审计的冻结失败状态，且确认前签名 mutation、command 和远端写入均为 0。156 项不再占用一个 120 秒 action，而是通过 20 个对象批次和最终冻结 revision 持续投影真实进度。

## 删除图

固定顺序为：

1. 解除 `InfrastructureApplication` 与 `ItToolApplication`。同一 relationType/source 的完整 APP 目标集合冻结为一个图步骤、一个 source tab token 和一次批量 mutation；写后逐端点以精确 search 证明全部不存在。
2. 对每个独立选择或依赖派生的 GRA 提交一次 soft delete；preflight 已冻结 assessment relationship、delete validator 和完整 Risk、Control、Risk-Control 子集。
3. 删除 DB、OS、DCNO、TOOL、Information。
4. 最后删除 APP。

每个对象、GRA 或关系组步骤都有独立 Core intent、command、Operation receipt 与 readback。关系组读回出现部分边、单/双向冲突或缺端点时不算完成；GRA readback 缺少任一冻结子项的 deleted/absent 证明时也不算完成。两者都进入 `uncertain`，只读 reconcile 可继续核验，但绝不会再次发送 mutation。

全部图步骤终止后，Worker 必须再次读取当前 Connector authority 与真实 Pack catalog，并证明所有 `succeeded` 对象不再出现。终验保存时间、catalog digest 和 absent identity 列表；矛盾、读取失败或 authority/safety 漂移会进入 `final_catalog` 只读核验状态，不会重放已提交 mutation。

发布托管 CPython 3.13.14 只对冻结 `scheduleGraph` 与持久 outcome ledger 做确定性调度，输出 ready step、dependency skip、计数和 terminal。Worker 以实际并发预算 1 串行提交 Core command 和签名 Operation；Python 不访问网络、Store、Core 或 Connector，也没有 JS 调度回退。Python 缺失、握手失败、超时或返回非法决策时 Feature 明确失败或禁用。

## 安全不变量

- 只接受 Connector 权威目录返回的规范、非零 Omnia .NET GUID；不附加 RFC UUID version/variant 位要求，名称仅用于展示。
- 目录请求必须绑定当前 Engagement 和 1–2000 个唯一、合法的显式 Workspace；权威 Section/Workspace identity 重复时整次读取失败关闭。
- 所有对象及关系两端必须命中当前安全锁和同一 Workspace。
- 计划冻结 Connector、session generation、Pack、完整对象图、两端身份、关系 token 与 GRA cascade digest。
- `preparing` 只接受当前 Surface revision 的续作/重试；关闭重开后从同一私有 checkpoint 继续，不新建 Run、不重复已完成批次。
- `preparing` 取消只允许 Core Run 仍为 `ready_for_review`，并以当前 `state_revision` 精确 CAS 到 `cancelled`；不创建 confirmation、intent、command 或 mutation。
- 用户确认提交 Core 前重验整张图；每个 mutation 前再重验该步骤。
- 只有 mutation 提交前的已知失败可按冻结依赖隔离；任何 submitted/committed/unknown/uncertain 状态立即停批。
- Confirmation 已批准后若当前 Connector/safety authority 校验失败，Worker 会关闭 Core Run 并返回真实失败卡，不把已批准计划继续显示为等待确认。
- 关系一定先于对象删除；不允许靠对象级联推测关系已删除。
- mutation 响应不确定后不重放，只允许 receipt-bound 只读 reconcile。
- GRA 级联投影只调用 Core `projectVerifiedDeletionCascade`；Worker 不提供可伪造的 children 列表。
- 独立选择的 GRA 不生成第二个通用 object step；同一 root 在整个冻结图中只有一个 `omnia.delete.gra.direct.v1` mutation intent。
- Core Run 只能在最终 scope/catalog 权威重抓与 absence 比对通过后终态关闭。
- Core 失败终态写入无法确认时必须进入 `core_terminal` 只读核验；只允许重试 Core 关闭或读取 Run 状态，不得把本地计划提前标成失败，也不得重放 mutation。
- 没有真实 Operation/readback 的类型保持禁用。
- DCNO 只能由权威目录的 `Infrastructure/Network` 进入计划；必须命中显式 Workspace、安全锁、blocker、完整 DCNO→APP 关系图和精确 Network 终态读回，任何缺失均失败关闭。

## 平台边界

Shell 从 Core Return ledger 生成 receipt-backed 分组进度并投影到当前 Feature Surface。Worker action 仅返回冻结目标、步骤和终态 ledger 的 Surface patch，不生成任何 Comments 投影。旧 0.3.14 pending 计划的一次性迁移仍通过 Core 精确失效确认并关闭 Run，但迁移结果只显示为 Feature Surface 的 `cancelled` / `skipped`；历史 Comments 卡由 package-manager 的 activation-head `feature_version` join 过滤，不通过新写终态卡清理。

当前 Core 的 intent/command 已识别全局 Section 冻结成员，但证据冻结仍只接受显式 `workspaceIds`。本版本因此只开放显式 Workspace 锁目录；仅由 `globalWorkspaceIds` 授权的目录在 Core evidence/readback/projection 统一使用安全并集前保持关闭。

## 版本说明

__VERSION_NOTE__

## Managed Python preparation compiler

Version 0.3.19 invokes the release-managed CPython 3.13.14 capability `compile_delete_preparation` only after all bounded object preflights have been frozen. Its input is limited to at most 200 Worker-validated targets and their exact object-preflight evidence. Its deterministic output contains only `graSeeds`, `derivedGraSeeds`, `relationDescriptors`, `dependencySkeleton`, and `compilationDigest`.

The Worker independently verifies the complete identity set, Work Item and Workspace bindings, relation directions and endpoints, deterministic ordering, bounds, dependency coverage, and digest before saving the checkpoint. An unavailable, failed, or tampered compiler fails closed and has no JavaScript fallback. Operation IDs and payloads, Store/CAS, Core intent and confirmation, mutation, receipt, readback, projection, and reconcile remain in the Worker/Core planes.

The v4 implementation is reused only for single-flight process control and bounded pure scheduling. Its mutation concurrency is intentionally not migrated: remote mutation remains serialized and receipt-bound, and Python has no access to Connector, Core, Store, or network.

## Restart-safe final authoritative verification

Before the first final `scope read → heavy catalog read`, the Worker persists an auditable `final_catalog` checkpoint with the frozen Python terminal decision. A read failure or Worker restart can therefore retry only authoritative absence and Core terminal closure. It never replays an already verified object, relation, or GRA cascade mutation, and never repeats a verified cascade projection. Completion still requires every succeeded object and GRA root identity to be absent from the fresh authoritative catalog.

## 重开生命周期

Shell 0.4.15+ 中，同一保留 Delete Surface 仅在 `closed → open` 时调度已签名、隐藏的 `refresh-on-reopen` 只读动作。若私有计划为 `preparing`，它先精确核对当前 Connector/safety 与冻结 binding，立即投影同一 checkpoint 并恢复声明式 background 续作，不重抓目录、不新建 Run、不丢弃已完成批次。没有 preparing 计划时，它复用 `scope read → heavy catalog read`，针对当前 Connector authority、安全锁和 Pack 读取，绝不把历史目录快照作为当前目录结果展示。若持久计划为 `pending_confirmation`、`executing` 或 `uncertain`，读取成功后仅重新投影该冻结计划；读取失败仍保留审计与冻结目标并失败关闭，其中 preparing/pending 仅保留本地取消。生命周期绝不确认、执行 mutation 或启动只读 reconcile。首次打开、聚焦、停靠、分离和最小化均不会触发。
