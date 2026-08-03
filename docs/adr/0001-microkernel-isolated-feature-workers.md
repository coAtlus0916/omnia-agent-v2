# ADR-0001：微内核 + 隔离 Feature Worker

状态：Accepted；安装/启用门槛由 ADR-0031 细化  
日期：2026-07-30  
决策来源：v5 已收敛架构约束

## Context

v4 的业务能力虽然有目录和 registry，但共享同一服务进程、数据库和发布物；服务、前端和 Connector 中存在业务长分支。一个功能的部署、崩溃、资源耗尽、迁移或依赖更新会扩大到整个产品。

v5 需要使每个功能具备独立版本、数据 owner、健康、升级、回滚和故障隔离，同时保持本地单用户产品的可运维性，不照搬云端分布式微服务。

## Decision

采用“稳定微内核 Control Plane + 隔离 Feature Package/Worker”：

- Shell、Control Service、每个 Feature Worker、Parser 和 Connector 采用独立进程/故障边界；
- Core 只提供 registry、Run/Event、Store、Template/Artifact、AI/Connector broker 等通用机制；
- 每个 Feature 使用统一 manifest、SDK/RPC、权限、资源、migration、UI registration 和 test kit；
- Feature 间禁止直接 import 或访问数据库，通过 Core 的公共 Event/Artifact 合同协作；
- 每个 Feature 有唯一数据 owner，可独立启停、升级、回滚；
- Feature 故障只影响自身入口和 Run，不阻断其他健康 Feature。

具体 Shell/Core runtime、RPC library 和 Windows sandbox 技术未在本 ADR 决定，保持 Proposed。
根据 [ADR-0031](0031-fast-local-feature-iteration-and-automated-integrity.md)，Windows 强隔离认证、
AppContainer 或第三方认证不再是 Feature 安装、本地启用或开发测试的前置条件。未完成这类
加固不能单独成为 `runtimeEnabled=false` 的原因；运行时仍必须有真实 Worker、受控端口、
后台状态和所需 Connector capability。

## Consequences

正面：

- 模块化成为可验证的部署/权限边界；
- 降低独立功能发布与故障影响面；
- 可统一实施签名、配额、健康和合同测试。

成本：

- 需要进程监督、RPC、版本协商、Artifact 句柄和独立 migration；
- 跨模块调用比直接 import 更显式；
- 独立进程监督和大型文档性能需要原型/基准；Windows sandbox 可继续加固，但不阻塞使用。

## Alternatives

| 方案 | 结论 |
|---|---|
| 延续共享 server + registry | Rejected；不能独立升级、隔离数据和故障 |
| 每个功能完整云微服务 | Rejected；对单 Local 产品增加不必要部署复杂度 |
| 同进程插件 + 约定不越权 | Rejected；不能形成安全/资源边界 |

## Verification

- 进程测试证明 Feature A crash/OOM/升级不影响 Feature B、Core、Connector；
- 普通故障/权限测试证明 Feature 不经合同访问 Core/其他模块 DB、Secret、任意网络/路径；不要求外部 Windows 隔离认证；
- manifest、RPC、migration、rollback 使用同一 contract kit；
- 依赖扫描拒绝 Feature→Feature import；
- UI 仅在 active/healthy/compatible/authorized 时开放。
