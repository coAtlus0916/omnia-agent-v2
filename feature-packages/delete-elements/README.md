# 删除元素 Feature 包

当前源码版本：`0.3.32`

0.3.32 把 IT Element 删除预检从全 Pack Tool 扫描改为按 `getBlockingRelationships` 定向解析关系端点：每个关系 blocker 通过精确 partner detail + facet mapping 补全 `objectType`/`workspaceId`，不再随 Pack 内 Tool 数量线性变慢；并允许只选中关系一端（如仅 DB 或仅 APP）：解除关系并删除选中侧，未选中侧保留。Worker 为每次 Connector Operation 增加有界响应窗口，只读超时失败关闭、mutation 超时进入 `uncertain` 且绝不重放。反向 Tool 查询字段与真实 Omnia 合同仍需 canary 复核。

0.3.17 移除旧 0.3.14 pending 计划一次性迁移时最后残留的 Comments 终态投影。迁移仍精确调用一次 Core `returnRunToReview` 和一次 Run 关闭，不增加任何 Operation 调用，也不提交 mutation；action 只返回状态为 `cancelled`、进度为 `skipped` 的 Delete Feature Surface patch。历史 0.3.14 Comments 卡由 package-manager 的 activation-head `feature_version` join 过滤，不由 0.3.17 新写终态卡清理。

0.3.15 把新删除计划从 Comments 完整迁入 Delete Feature 卡片：冻结目标、图步骤、确认、receipt-backed 进度、只读核验和终态结果都由同一个声明式 Surface 投影。目录态禁用计划动作；计划态禁用刷新和重复创建；终态可用“刷新”返回最新真实目录。新计划不写 Comments；旧 0.3.14 pending Comments 计划只能执行一次可审计迁移取消，不会提交 mutation。对象/GRA 预检使用峰值 8 的有界并发且按冻结输入位置收集结果，156 项规模测试在 120 秒预算内完成。同一 `relationType + source` 的全部 APP 目标按 ID 排序去重后冻结为一个关系组，使用一个 source-tab token、一次批量 `disassociate`，并逐端点执行双向或单向读回；部分边、缺端点、跨 Workspace/type 或漂移全部失败关闭。

0.3.14 修复真实 GRA 预检把 Create & Associate 的 assertion 元数据误当作删除许可的问题。GRA cascade snapshot 只冻结并校验删除所必需的 Risk、Control 与 Risk-Control 精确远端身份；根删除后仍逐项证明冻结级联全部缺席。0.3.13 的 Connector sandbox 无 `require` 修复、0.3.12 的空租户与真实 DB/OS/Network 识别全部保留。

0.3.11 修复真实 Remote Workspace 的 `tenantOrOrgId` 合法为空时被 Delete Feature 误判为非法输入。空字符串不是缺失授权，而是当前 Connector binding 与安全锁共同冻结的精确 authority 值；本版允许它进入真实 scope/catalog 读取，并在确认、执行与读回阶段继续做逐字段一致性比较。Connector、Bridge 与 Shell 均未修改。

0.3.10 修复 0.3.9 的同范围重抓取假等待：一轮真实权威目录读取已经超过 90 秒但底层请求仍在收尾时，再次点击“权威重抓取”会立即显示 `DELETE.CATALOG_BUSY`，不会再挂满一轮 90 秒，也不会并发启动第二轮扫描；原请求真正结束后，下一次重抓取才会创建新的真实读取。

0.3.9 修复进入 Feature 后长期停在“正在读取权威目录”：目录仍从真实 Omnia 读取，但每个对象先读取权威 detail；若 detail 已精确证明对象属于安全锁外 Workspace，就不再继续读取该对象的 Facet mapping 与 blocker。安全锁内对象仍完整读取 mapping、blocker、关系与 GRA 信息，不能用索引或缓存冒充目录。交互式首次读取和手动重抓取统一采用 90 秒有界等待；超时进入可见 `error` 并保留真实“权威重抓取”入口，不再无限 loading，也不会启动第二轮不同授权范围的并行扫描。

0.3.8 修复 Core 终态真实性：若 `finishReturn(failed)` 的响应失败且 Core 当前状态也无法证明为 failed，Feature 不再吞错并显示假失败，而进入 `core_terminal` 待核验状态。此状态只能重试 Core Run 关闭或读取其终态，绝不会重放关系或元素 mutation；只有 Core 明确接受关闭或权威读回为 failed 后，本地卡片才进入失败终态。

0.3.7 修复混合 Infrastructure 目录稳定性：真实 Pack 若同时存在 Feature 未支持的明确 Infrastructure subtype，不再让 APP、DB、OS、DCNO、Tool 的整批权威目录读取失败；仅排除该明确不支持项。类型字段缺失或模糊时仍失败关闭，不能把未知对象伪装为支持类型。新增 TEST 六类混合计划合同，证明 GRA、APP、DB、OS、DCNO、Tool 在同一显式 Workspace 中生成关系优先、GRA、DB/OS/DCNO/Tool、APP 的单一参数化图与真实二次确认入口。

0.3.6 把 `Infrastructure/Network` 作为 `kind=DCNO` 参数接入现有单一 IT Element 删除能力，不新增 DCNO 专用调度器或复制回传流程。DCNO 与 DB/OS 共用已签名的 `InfrastructureApplication` source-tab 602 关系预检/解除/双向读回，再通过通用 IT Element softdelete 一次提交，以 Network subtype、精确 Workspace 与 deleted/absent 终态读回。真实 TEST Pack canary 完成前不得宣称已实机通过。

0.3.5 修复真实声明式目录合同：移除 Shell 不接受的 item 扩展字段，并将 `Infrastructure/Network` 权威识别为 DCNO。DCNO 会在真实 Section / Workspace / 类型目录及搜索结果中展示，但由于 v4 只证明 Database/Operating System Infrastructure 删除、尚无 Network mutation/关系解除/readback 实录合同，DCNO 类型和条目均真实禁用，Worker 与 Operation 双重拒绝其 plan/preflight。目录存在 DCNO 不再导致其他可删类型整批加载失败。

0.3.4 在图调度终止后再次校验当前 Connector binding、安全锁、authority 与真实 Pack catalog。所有已经步骤级 readback 证明删除的对象（包括独立选择或依赖派生的 GRA 根），还必须在最终目录中不再出现，Core Run 才能关闭为完成或部分失败。最终目录读取失败、authority/safety 漂移或已删对象重新出现时，计划进入可重试的只读 `final_catalog` 核验，不会重放任何 mutation。

0.3.3 修正 Omnia GUID 校验：只要求规范、非零 .NET GUID，不再错误要求 RFC version/variant 位。权威目录同时拒绝跨 Engagement、空/重复/非法 Workspace scope 与重复 Section/Workspace identity；Python 调度器拆分为输入、图、outcome 和依赖传播单责函数。确认批准后若 authority 校验失败，Worker 会可靠关闭 Run，不把已批准计划遗留为假等待状态。

0.3.2 对权威目录增加 Engagement、2000 项上限和重复/跨类型身份校验；冻结并展示 Core confirmation `expiresAt`。取消、过期、目录漂移或整图漂移必须经 `returnRunToReview` 原子失效 Confirmation 与 frozen intents 后关闭 Run；终态卡仅显示真实 outcome、对象 ID、错误码和原因。

0.3.1 在四 Plane 真实闭环中增加发布托管 CPython 3.13.14 纯调度器：Python 只读取冻结图与持久 outcome ledger，确定 ready、dependency skip 和 terminal；Feature Worker 仍独占 Core Run、确认、命令、签名 Operation、receipt、投影与只读 reconcile。没有 JS 调度回退。

## 真实功能范围

- 权威目录：Information、GRA、APP、DB、OS、DCNO、TOOL。GRA 目录复用 v4 已实跑的 `RiskFactorEvaluation` Work Item + `commonAccounts` 双索引并逐项读取 assessment detail；任一来源带回收站标记都会排除该 GRA。DCNO 以 `Infrastructure/Network` 精确身份进入同一参数化删除图。明确的其他 Infrastructure subtype 只从本 Feature 目录排除，不拖垮支持类型；类型缺失或歧义仍失败关闭。
- 关系：显式发现并冻结 `InfrastructureApplication` 与 `ItToolApplication`。同一 relationType/source 的完整 APP 目标集合是一个 Core 图步骤和一个签名 mutation；Tool→APP 使用 `ConcurrencyTabId=802`，Infrastructure→APP 使用 602。readback 对冻结集合中的每个 APP 分别证明边不存在，不能用任一端点代表整组。
- 图闭合：任一关系只选择一端时在创建 Core Run/Command 之前返回 `DELETE.GRAPH_INCOMPLETE`，全程零 mutation。
- GRA：既可独立选择，也可由所选 IT Element 依赖派生；两种入口合并为同一个 cascade step。preflight 先核对 assessment、Work Item relationship 与 Omnia `op=Delete` validator，再冻结 GRA、Risk、Control、Risk-Control 精确集合与 digest；确认前整图重验、提交前针对性重验后只提交一次既有 GRA soft delete。
- GRA 调和：逐项证明冻结子集 deleted/absent；缺少任一证明即进入 `uncertain`，后续只允许只读 reconcile，不重放 mutation。
- 固定顺序：`InfrastructureApplication + ItToolApplication → GRA cascade → DB/OS/DCNO/TOOL/Information → APP`。
- 投影：普通对象与关系使用 receipt-backed 删除投影；GRA 使用 Core `projectVerifiedDeletionCascade`，由 Core 自行比较冻结 intent baseline 与可信 readback receipt 后原子投影根及子集。
- 首次加载：声明式 Surface 的后台 action 自动执行一次真实权威目录读取，明确落到 `ready`、`empty` 或 `error`；手动“刷新”仍读取当前 Connector、Section、Workspace 与目录，不使用示例数据。
- 失败隔离：仅 mutation 提交前且结果明确的 preflight/command 准备失败可隔离到依赖子图，其余独立步骤继续。任何请求已标记 submitted 后的错误、commit/receipt/readback/projection 不确定都立即停批，只能只读调和且绝不重放 mutation。
- 确认失效：计划保存并展示 Core 冻结的 `expiresAt`。用户取消、确认过期、Connector/安全锁漂移或整图重验失败时，Worker 先调用 Core `returnRunToReview` 原子失效 pending Confirmation 与冻结 intents，再把 Run 关闭为 cancelled；不会留下仍可消费的旧确认。
- 结果投影：Delete Feature 内的冻结目标与步骤条目列出真实 outcome、对象 ID、错误码与原因；分组进度由 Core command/readback ledger 更新，不用 Comments 或 Renderer 本地状态推算。
- 最终权威目录：调度器终止后重新执行 scope + heavy catalog 读取，记录 catalog digest、时间与已证明 absent 的对象列表。只有终验通过才调用 `finishReturn`。

Workpaper、Control、Document 和 Deficiency 仍缺少完整独立删除合同，因此保持禁用，不提供假入口。DCNO 不借用 OS subtype：Operation 必须读回 `Infrastructure/Network` 才接受 `objectType=DCNO`。

GRA 合同证据来自 v4 的真实 TEST-Auto Run `4c07d5e8-a296-4f88-9de3-394318ae64a5`：40 个独立 GRA 全部写后验证删除，0 失败。`source/tests/fixtures/gra-delete-v4-live-contract.json` 固定了两份原始输出的 SHA-256、真实样例身份和 route/method/no-replay 契约；该夹具只用于合同验收，不作为生产目录数据。

## 安全边界

目标必须命中单一显式 Workspace 安全锁，关系两端必须在同一 Workspace。计划冻结完整图、两端 ID/类型/Work Item/Workspace、对象更新时间、关系 tab token、GRA cascade digest 与 Python schedule graph。确认提交给 Core 前完整重验一次图；每个步骤 mutation 前再执行针对性预检。任何漂移都会失败关闭。

同一 source 的多条 APP 边共享一个 tab token。0.3.15 只接受完整、排序且无重复的冻结目标集合，并将该集合一次性写入 Omnia `AssociatingEntityIds`；不再逐边消费同一个旧 token。写后必须对每个冻结端点读回，任何部分状态都进入只读核验且不重放 mutation。

## 发布规则

0.3.17 源码候选只允许由打包脚本生成新的 `sequence 26` 不可变 `.ofp`，不覆盖 0.3.16 或任何更早历史包；`minimumShellVersion` 保持 `0.4.15`。当前实际安装版本由主线程核对；真实 TEST Pack canary 必须以安装后权威目录、分组 mutation receipt、逐端点读回与最终目录 absence 为准。

## 当前平台合同缺口

- Shell 已能根据 Core Return ledger 向当前 Feature Surface 投影 receipt-backed 分组进度；Delete Worker 的所有 action 只返回 Surface patch，不生成 Comments 投影。Worker action 仍是有界调用，终态 Surface 会以持久 outcome ledger 收敛。旧版本 Comments 卡由当前 activation head 的 `feature_version` 过滤，不需要 Worker、Core 或 Shell 增加清理写入。
- Core `prepareReturnIntent`/`prepareDeletionCommand` 已能校验全局 Section 冻结成员，但 `freezeReturnEvidenceSpec` 仍只使用 `workspace_safety.workspace_ids_json`。因此本版本只读取并开放显式 Workspace 锁目录；在证据冻结、读回和投影全部接受同一 `allowedWorkspaceIds = workspaceIds ∪ globalWorkspaceIds` 前，不能安全开放仅由全局 Section 锁授权的成员。
