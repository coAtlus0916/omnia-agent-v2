# 删除元素 Connector Operation __FEATURE_VERSION__

Operation 包只声明固定 route、参数和 body mode，不提供自由 HTTP。Connector handler 是无状态执行器；完整删除图由 Feature Worker 编排。

`omnia.delete.scope.read.v1` 与 `omnia.delete.catalog.heavy-read.v1` 同时服务于首次 loading、用户手动重抓取和 mutation 全部终止后的最终权威 absence 验证。Connector 不推断成功；它只返回当前 Pack 真实目录，absence 比较与 Core Run 终态由 Feature Worker 掌控。

heavy-read 不把搜索索引当作 Workspace 终证。它先读取对象 detail；detail 精确证明对象位于请求安全范围外时才省略后续 Facet/blocker 请求，范围内对象仍完整读取。交互式 90 秒等待由 Feature Worker 管理，不改变 Connector Core，也不缩短 mutation 后的最终权威核验。

Omnia identity 只按规范、非零 .NET GUID 校验，不误加 RFC UUID version/variant 位限制。权威目录调用必须与当前 Connector Engagement 一致，Workspace scope 必须非空、唯一且合法；重复 Section/Workspace identity 失败关闭。

## Operation 组

- 权威目录：scope、Information collection、GRA `RiskFactorEvaluation` Work Item + `commonAccounts` 双索引与 assessment detail、Application/Infrastructure/ITTool search、对象 detail、Facet mapping、blocking relationships，以及 Tool→APP 的 `associatedWithITToolId + itElementType=Application` 搜索。Infrastructure/Network 规范化为 DCNO，保留精确 subtype 身份进入通用 IT Element 合同；明确的其他 Infrastructure subtype 仅被排除，缺失或模糊类型仍失败关闭。
- Information：preflight、softdelete、detail reconcile。
- APP/DB/OS/DCNO/TOOL：同一个参数化 IT Element preflight、softdelete、detail reconcile；DCNO 必须读回精确 Infrastructure/Network，不借用 OS subtype。
- GRA：v4 真实合同的 assessment detail、`RiskFactorEvaluation` Work Item relationship、`validate-riskfactor-evaluation?op=Delete`，加 create-associate 已验证的 Risk catalog、Control catalog、Risk detail；mutation 仍只有一次既有 `PATCH .../softdelete`，之后只做只读 reconcile。
- `InfrastructureApplication`：source 与完整、排序、去重的 APP 目标集合 identity/Workspace、source tab 602、逐目标双向 search、一次批量 `relation-disassociate`、逐目标双向 reconcile。
- `ItToolApplication`：Tool 与完整、排序、去重的 APP 目标集合 identity/Work Item/Workspace、Tool tab 802、一次批量 `relation-disassociate`、逐目标 Tool→APP authoritative search reconcile。

每类 mutation 只能由自己的 preflight Operation 发放一次性 permit。mutation payload 来自 Core 冻结 command，不从前端或 Connector 自由拼装。

## 严格读回

- IT Element / Information：精确 ID、类型、Workspace 与 deleted/absent；DCNO 还必须保持 Infrastructure/Network subtype。
- 关系组：精确 source、完整 `targetObjectIds` multiset、relation type；每个端点都必须 `associated=false`、`inconsistent=false`，部分删除不能代表整组完成。
- GRA：根 assessment 必须 deleted/absent；冻结的 Risk、Control、Risk-Control exact set 每一项必须由 active catalog/detail 证明 absent/deleted。返回 snapshot 保持冻结 identity、排序与 digest，仅给 child 增加一个状态字段。

mutation 返回不确定状态后 Operation 不会自动重试。Worker 只调用签名 reconcile，并把可信 receipt 交给 Core `projectVerifiedDeletionCascade` 或普通删除投影。

Python 调度器不属于 Connector Plane，也不能构造或调用 Operation；签名 Operation 的 operationId、effect、固定 route 与 payload 仍全部由 Feature Worker 按 Core 冻结 command 提交。

旧 0.3.14 pending 计划迁移只失效 Core Confirmation 并关闭 Run，Operation 调用数保持零增加。迁移结果仅由 Delete Feature Surface 显示为 `cancelled` / `skipped`；Operation 包和 Worker 都不生成 Comments 终态投影，历史卡由当前 activation head 的 `feature_version` 过滤。
