# ADR-0008：Remote Transport 面向全部版本

状态：Accepted  
日期：2026-07-30  
决策来源：用户产品决策

> 2026-08-03 supersession：Remote 面向全部版本继续有效；本文关于“单一 Local 产品”、首次默认 Local、设置页切换和 Local/Remote parity 的双模式部分已由 [ADR-0035](0035-remote-only-connector-and-link-code-pairing.md) 取代。v5 当前为 Remote-only 且无 Local fallback。本文件其余文字保留为历史决策证据。

## Context

v5 只维护一个 Local 产品，但 Connector 可以位于本机或远程工作站。此前尚未决定 Remote 只供开发/验收还是也提供给普通用户。

## Decision

- Remote Transport 作为所有 v5 版本共同支持的连接模式，不按版本、Edition 或用户类型裁剪。
- 首次运行仍默认 `local`；用户可在设置中显式切换 `remote`，成功后沿用上次有效值。
- “所有版本支持”表示产品和合同不人为隐藏 Remote，不表示未配置 Bridge、未配对或安全门禁未通过时仍可强行使用。
- Local/Remote 共用同一 Feature、Run、Command、确认、幂等、Artifact、Evidence 和 `uncertain` 合同。
- 同一时刻只有一个 active Transport；Remote active 时 Local Connector 不得领取或执行命令。
- Remote 故障不静默回退 Local。

Remote Bridge 的身份协议、部署位置、端到端保护、TTL、撤销、容量和 SLA 仍需独立技术评审；这些门禁未完成前，Remote 入口必须保持禁用并显示真实原因。

## Consequences

正面：

- 所有版本功能一致，不形成开发版/普通版两套逻辑；
- Feature 只依赖 Transport 合同，不判断用户版本；
- Local/Remote parity 成为每个 Feature 的共同发布门禁。

成本：

- Remote 身份、Bridge 运维、隐私、断线和 Artifact 中继成为所有版本的正式质量责任；
- 发布不能以“Remote 仅内部使用”为由降低安全和支持标准。

## Verification

- 所有版本使用同一 Feature manifest 和 Transport capability negotiation；
- 设置页真实显示 Local/Remote，并持久化上次有效选择；
- Remote 未配置/未配对/不健康时明确禁用；
- Remote active 时 Local claim 被 fencing token 拒绝；
- Local/Remote 通过同一合同、故障注入和真实 Connector 验收。
