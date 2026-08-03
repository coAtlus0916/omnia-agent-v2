# ADR-0013：暂缓 Nova 协议验证

状态：Proposed / Deferred  
日期：2026-07-30  
决策来源：用户当前阶段决策

## Context

用户希望 v5 最终可使用 DeepSeek 及 Nova 等其他模型，但当前没有冻结 Nova 的 Base URL、认证、模型发现和协议兼容资料。当前阶段不要求验证 Nova 协议。

## Decision

- Nova 协议验证和专用 Adapter 暂缓，不作为当前文档阶段、首批 Feature 或平台骨架的阻塞项。
- v5 继续设计和实现通用 AI Gateway、DeepSeek Adapter 与受控 OpenAI-compatible Custom Adapter。
- 在 Nova 未经真实协议验证前，不提供名为“Nova 已支持”的可点击入口，不预置 endpoint、认证头或模型。
- 如果真实 Nova 服务本身兼容已实现的 Custom Adapter，仍须由用户按 Custom Profile 显式配置并完成真实测试；不能仅凭名称自动认定兼容。
- 未来启动 Nova 专用支持时，将本 ADR 更新为 Superseded，并以新的 Accepted ADR 冻结真实协议。

## Consequences

- 首批四个 Feature 和平台架构不等待 Nova 资料；
- 不制造未经验证的 Provider 能力；
- 用户仍可使用 DeepSeek，或在真实安全测试通过后使用 OpenAI-compatible Custom Provider。

## Verification

- 设置页不显示“Nova 已支持”；
- 代码和文档不硬编码未经验证的 Nova endpoint、header 或模型；
- Nova 不出现在首批 Feature 的必需依赖中；
- 后续协议验证有独立合同、Secret、SSRF、模型发现和真实连接测试。
