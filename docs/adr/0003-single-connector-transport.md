# ADR-0003：单一 ConnectorTransport 与单 active lease

状态：Accepted  
日期：2026-07-30  
决策来源：v5 已收敛产品与架构约束

## Context

v5 是单一 Local 产品：首次使用本地 Connector，用户可在设置切换 Remote 并沿用上次有效值。Local/Remote 如果形成两套业务实现，会在确认、幂等、错误、Artifact 和 uncertain 上漂移。故障时静默 fallback 可能导致命令在另一工作站/Session 重复执行。

Connector 还必须保持 Core 稳定，业务能力通过签名 Operation Module 扩展，不能用任意 HTTP 代理换取“无需改 Core”。

## Decision

- 定义唯一版本化 `ConnectorTransport`；`LocalTransport` 与 `RemoteBridgeTransport` 实现同一 pair/bind/negotiate/submit/progress/artifact/cancel/reconcile/health 合同。
- 任一时刻只有一个 `active transport lease`，使用单调 generation/fencing。
- 首次启动为 `local`；切换成功后才持久化上次有效值。
- 切换时冻结新 Connector effect；有非终态 mutation、Connector Artifact 上传、未解决 `uncertain`、无法判断状态，或只读命令无法按合同取消/完成时阻断。
- 候选 Transport 完成地址、身份、配对、健康和 capability 验证后原子切换；故障不静默 fallback。
- Transport 只处理拓扑和传输，不改变业务命令 Schema/状态。
- Connector Core 只做 Transport/Session/Gate/Module Host；业务 Operation 在签名受限进程中运行。
- 禁止任意 URL/method/header/body HTTP 或系统命令后门。

Remote Bridge 的部署位置、身份产品、TTL 和 SLA 未决定，保持 Proposed。

## Consequences

正面：

- Local/Remote 共享安全语义和测试；
- 防止双 active、错 Session 和故障重复写；
- 新业务通常不需要升级 Connector Core。

成本：

- 需要 lease/fencing、事件重放、Remote 顺序/TTL、切换状态机；
- Remote 故障时用户必须显式处理，不能追求“无感”；
- Operation Module SDK/沙箱/签名体系需建设。

## Alternatives

| 方案 | 结论 |
|---|---|
| Local/Remote 各自业务 API | Rejected；语义漂移和重复维护 |
| Remote 失败自动用 Local | Rejected；身份/作用域/重复 mutation 风险 |
| Local 与 Remote 同时 claim | Rejected；违反单 owner 和幂等边界 |
| Connector 任意 HTTP 代理 | Rejected；等同把 Omnia Session 变成后门 |

## Verification

- 同一 canonical fixture 通过 Local/Remote 合同套件；
- 并发启动/崩溃恢复只保留一个 active generation；
- 非终态 mutation、未解决 uncertain、Connector Artifact 上传、未知状态和无法安全结束的只读命令阻断切换；
- 提交点断线统一进入 uncertain，无自动重放；
- Operation 越权 endpoint/网络/系统命令失败；
- 真实 Omnia canary 核对冻结 identity 和写后读回。
