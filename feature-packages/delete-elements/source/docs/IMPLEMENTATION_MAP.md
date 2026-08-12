# 删除元素实现映射 __FEATURE_VERSION__

Final catalog closure is a durable read-only phase: before its first authoritative recapture, Worker saves `uncertain.final_catalog` plus the frozen `succeeded|failed` scheduler terminal. Restart recovery repeats only current authority/catalog absence and Core closure; it does not invoke mutation or projection again. GRA success closes only after both the receipt-backed cascade projection and final authoritative absence of the GRA root are verified.

| Plane | 实现 | 职责 | 禁止事项 |
|---|---|---|---|
| 前台 | `frontend/surface.json` + Shell `selectionBrowser` | 在同一 Feature 内展示真实目录、冻结目标、图步骤、确认、Core ledger 进度与终态；声明式固定底栏与双独立滚动目录列 | 不推断对象、关系或成功状态；新计划不写 Comments |
| 中台 | `middle/worker.cjs` + `middle/delete-elements-python-bridge.cjs` + `python/delete-elements-engine.py` | Worker 冻结完整图并掌控 Core/Operation/证据；托管 CPython 仅从冻结图与持久 ledger 决定 ready/skip/terminal | Python 不访问 Core/Store/Connector/网络；Worker 不重放不确定 mutation；无 JS 调度回退 |
| 后台 | Feature Store + Core Run/intent/command/receipt/projection | 持久化确认与证据；普通 tombstone、关系投影及 GRA 原子级联投影 | 不信任 Worker 自报 children，不接受无 receipt 完成 |
| Connector | `connector-capability/operation/handler.cjs` | 有限签名读取、preflight、单次 mutation、权威 reconcile | 不接受自由 URL/method/body，不持有业务流程状态 |

## 状态与图顺序

`createPlan(snapshot) → preparing(object batches → derived GRA batches → relation-group batches → finalizing) → pending_confirmation → confirm|cancel|invalidate → executing → final_catalog_verification → completed|failed|uncertain`

`preparing → retry current read-only batch | cancel(ready_for_review exact CAS) | reopen same checkpoint`

`uncertain → reconcile(read-only command|final catalog) → executing → completed|failed|uncertain`

`core_terminal` 是仅针对 Core Run 失败终态响应不确定的子状态：reconcile 只重试 `finishReturn(failed)` 或读取同一 Run，确认 Core 为 failed 后才关闭本地计划；它不进入 Python 调度图，也不调用 Connector mutation。

执行顺序固定为：

`InfrastructureApplication + ItToolApplication → GRA cascade → DB/OS/DCNO/TOOL/Information → APP`

目录读取成功后，Store 以 `catalog:${credentialDigest}` 保存两分钟有效快照；开始计划只读取并精确验证其 schema、Connector binding、安全锁 revision、expiry 和目标 identity，不再次调用 heavy catalog Operation。它先创建 Core `ready_for_review` Run 和 `omnia.delete-plan/v5` 的 `preparing` checkpoint。隐藏的 `continue-delete-plan-preparation` 是非 mutation background action，每个 Surface revision 只运行一次、每次只处理一种最多 8 项的对象、派生 GRA 或关系组 preflight。批次使用 all-settled 边界等待所有只读请求结束；只有全成功才一次保存结果和游标。失败只保存错误与原游标，显式 `retry-delete-plan-preparation` 重做同一批。最后单独一次 finalization 构造 graph/intent 并调用一次 `prepareReturnIntent`。mutation 执行仍固定并发 1。

确认提交 Core 前对 `{step key, full preflight, scheduleGraph}` 做 canonical digest 比较，之后每一步在 mutation 前执行针对性预检。pre-submit 已知失败只跳过其依赖后继，独立子图继续，任一 submitted/committed/readback/projection 不确定则立即停止整个批次。关系 readback 必须携带真实 `relationType/sourceObjectId/targetObjectIds`，逐端点证明完整冻结集合不存在；GRA readback 必须返回与冻结快照同一集合、同一排序和同一 digest。

Python 内部按 `scheduler_input → normalize_steps / normalize_outcomes → dependency_skips → schedule` 分责；所有可执行对象类型共享同一 `stepId/targetKey/operationId/effect/dependsOn` 形参合同，不为 Information、GRA、APP、DB、OS、DCNO、TOOL 复制调度或计划函数。DCNO 与其他对象一样进入同一个 Python schedule graph；对象类型差异只存在于 Worker 冻结的签名 Operation 参数。

Core `expiresAt` 与计划一同冻结。取消、过期、权威漂移或整图重验失败通过 `returnRunToReview` 失效 pending Confirmation 和 frozen intents，再关闭 Run，旧确认不可继续消费。Surface 状态修订与 Core confirmation 修订分别冻结，确认动作不会混用两种 revision。新计划只在 Feature 内逐步投影持久 outcome；旧 0.3.14 pending Comments 计划只能一次迁移取消，迁移 action 也只返回 `cancelled` / `skipped` Surface patch。历史 Comments 卡由 package-manager 的 activation-head `feature_version` join 过滤，Worker 不写新的终态卡。全局 Section 成员也暂不开放，因为 Core evidence freeze 尚未与 intent/command 一样接受 `workspaceIds ∪ globalWorkspaceIds`。

调度 terminal 不直接等于 Run terminal。Worker 还要重新执行 scope read 和 heavy catalog read，严格比较冻结 safety revision/membership，并证明所有已成功对象 identity 在新 catalog 中 absent。该读取只失败关闭，不会触发 mutation；重试也只重读 catalog 与完成 Core 终态。

混合 Infrastructure 目录只排除具有明确、非 Database/OperatingSystem/Network subtype 的条目；缺失或模糊 subtype 不会被静默忽略，而是失败关闭整个权威读取。该过滤发生在签名 Operation 的真实 detail 读取后，不使用名称猜测类型。

权威目录对整个 Engagement 取得索引后，先读取每个对象的真实 detail。只有 detail 本身精确返回单一、合法且处于安全锁外的 Workspace 时，Operation 才跳过该对象后续 Facet mapping 与 blocker 读取；不能仅根据搜索索引或名称跳过。锁内对象仍完整走 mapping、blocker、关系和 GRA 合同。Worker 对首次和手动目录读取实行同一 90 秒有界等待，超时投影为可重试 `error`。超时的底层请求尚未结束时，后续点击立即投影 `DELETE.CATALOG_BUSY`，不会再次等待 90 秒或启动并发扫描；底层请求结束后单飞槽才释放。

## 支持矩阵

| 类型 | 计划冻结 | mutation | readback / 投影 |
|---|---|---|---|
| Information | 身份、Work Item、Workspace、token、blocker | Information softdelete | detail deleted/absent；普通 tombstone |
| APP | 同上 + 所有 Tool/Infrastructure 边 + GRA | IT Element softdelete | detail deleted/absent；普通 tombstone |
| DB / OS / DCNO | 同上 + InfrastructureApplication + GRA；DCNO 必须是精确 Infrastructure/Network | 通用 IT Element softdelete | 精确类型与 Workspace 的 detail deleted/absent；普通 tombstone |
| TOOL | 同上 + 所有 ItToolApplication + tab 802 + GRA | IT Element softdelete | detail deleted/absent；普通 tombstone |
| 独立选择或派生 GRA | 双索引 + detail、assessment relationship、delete validator、Risk + Control + Risk-Control exact snapshot | 单次 GRA softdelete | exact deleted/absent set + 最终目录根缺席；`projectVerifiedDeletionCascade` |
| InfrastructureApplication | source 与完整排序 APP 集合 + source tab 602 | 一次 `itelement/disassociate`，`AssociatingEntityIds` 为全部冻结 APP | 每个 APP 双向 search 不存在；组 receipt-backed 投影 |
| ItToolApplication | Tool 与完整排序 APP 集合 + Tool tab 802 | 一次 `itelement/disassociate`，`AssociatingEntityIds` 为全部冻结 APP | 每个 APP 的 Tool→APP search 不存在；组 receipt-backed 投影 |
| 其他类型 | 禁用 | 无 | 无 |

## 重开生命周期

同一保留 Surface 的 `closed → open`（Shell 0.4.15+）调用 `refresh-on-reopen(read_only)`。有 `preparing` 计划时只精确重验当前 binding/safety 并立即投影同一 checkpoint，声明式 background action 从未完成游标继续；不重读目录、不新建 Run。有 `pending_confirmation|executing|uncertain` 时按既有合同重读当前 authority、安全锁和 Pack 目录后重新投影；没有活动计划时投影新目录。读取失败不创建、确认、执行、核验、丢弃或覆盖计划。
