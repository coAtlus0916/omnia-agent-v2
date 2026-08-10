# ADR-0002：Control & Data Plane 是唯一事实

状态：Accepted  
日期：2026-07-30  
决策来源：v5 已收敛架构约束

## Context

v4 有多套 Workflow/Agent/Capability/Connector 状态机，也存在进程内 Map 与 settings JSON 补偿。刷新、重启、模块独立升级和外部 effect 的不确定结果需要统一、持久、可审计的事实来源。

前端本地状态、Feature 内存、Connector 内存和历史快照都不能各自宣布业务终态。

## Decision

Control & Data Plane 是以下对象的唯一 system of record：

- Feature registry 与 active/previous/candidate；
- Run、Step、Event、Lease、Confirmation；
- Template/Scenario 元数据、TemplateInstance、Patch/Provenance；
- Artifact 元数据、模块数据域注册、Provider profile/usage；
- Connector Command、progress/result 投影、Evidence/Audit；
- Transport active mode/generation。

规则：

- 状态在外部 effect 前持久化；
- Event 追加式，状态迁移由 owner 白名单和 `stateVersion` 控制；
- Shell 只呈现后台事实；刷新/重启/多窗口重新读取；
- Worker 内存只作计算/缓存，lease 和 checkpoint 持久化；
- Connector 仍拥有 Omnia Session/Secret，Core 只保存逻辑绑定和命令事实；
- 外部 Omnia effect 用持久命令 + Evidence + reconcile，不假装分布式事务。

具体 Core DB 引擎和物理分库方式未在本 ADR 决定。

## Consequences

正面：

- 状态、恢复、审计和 UI 一致；
- 幂等、lease、uncertain 与发布 drain 有统一依据；
- 模块崩溃不会丢失平台事实。

成本：

- 需要 outbox、Event sequence、fencing、持久 checkpoint 和恢复扫描；
- Core DB 是关键资产，必须有备份、migration 和健康策略；
- 高吞吐实现需避免同步重任务阻塞。

## Alternatives

| 方案 | 结论 |
|---|---|
| 前端本地状态为主 | Rejected；刷新/重启/多窗口不可靠 |
| 每 Feature 自己保存 Run 真相 | Rejected；跨 Plane 无统一确认/命令/审计 |
| Connector 宣布全局业务状态 | Rejected；Connector 不拥有业务编排/数据 |
| 内存队列 + 日志补偿 | Rejected；崩溃窗口与重复 effect 不可接受 |

## Verification

- 杀进程/断电故障注入后从 Core 数据恢复；
- 前端不能直接设置 terminal status；
- Event sequence/stateVersion/lease fencing 并发测试；
- mutation 响应丢失进入 uncertain，不由内存自动重放；
- backup/restore 后 active mutation 只读 reconcile。

