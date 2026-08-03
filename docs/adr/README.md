# 架构决策记录

ADR 只记录跨模块、长期有效且需要解释取舍的决定。产品/协议尚未验证的问题保持 `Proposed`，不得通过实现先行变相决定。

## 状态

- `Proposed`：候选决定，等待用户/架构/证据；
- `Accepted`：已收敛并成为实现约束；
- `Rejected`：评审后不采用；
- `Superseded`：被新 ADR 替代，原文保留。

变更 Accepted ADR 必须新增 ADR 并标记 supersedes，不原地改写历史结论。

## 已记录

| ADR | 标题 | 状态 | 来源 |
|---|---|---|---|
| [ADR-0001](0001-microkernel-isolated-feature-workers.md) | 微内核 + 隔离 Feature Worker | Accepted | 已收敛需求约束 |
| [ADR-0002](0002-control-plane-system-of-record.md) | Control & Data Plane 是唯一事实 | Accepted | 已收敛需求约束 |
| [ADR-0003](0003-single-connector-transport.md) | 单一 ConnectorTransport 与单 active lease | Accepted；双模式部分由 ADR-0035 取代 | 已收敛需求约束 |
| [ADR-0004](0004-template-first-minimal-patch.md) | 模板优先、Run 副本与最小 Patch | Accepted | 已收敛需求约束 |
| [ADR-0008](0008-remote-for-all-versions.md) | Remote Transport 面向全部版本 | Accepted；Local/Remote 双模式部分由 ADR-0035 取代 | 用户产品决策 |
| [ADR-0010](0010-three-column-chat-shell.md) | 三列主界面且第三列保留聊天 | Accepted；列职责由 ADR-0032 更新 | 用户产品决策 |
| [ADR-0012](0012-initial-feature-scope.md) | 原首批三个 Feature 范围 | Superseded by ADR-0018/0020/0021 | 用户产品决策 |
| [ADR-0013](0013-defer-nova-protocol.md) | 延后 Nova 精确协议校验 | Proposed / Deferred | 用户产品决策 |
| [ADR-0015](0015-chat-history-immediate-deletion.md) | 聊天正文立即删除并分离保留必要证据 | Accepted | 用户产品决策 |
| [ADR-0016](0016-global-ui-scale-control.md) | 所有一级界面统一全局缩放 | Accepted | 用户产品决策 |
| [ADR-0017](0017-unified-resizable-layout.md) | 所有相邻功能区域使用统一可调整边界 | Accepted；主 Shell 固定 Rail 例外见 ADR-0032 | 用户产品决策 |
| [ADR-0018](0018-create-associate-first-vertical-slice.md) | 新建与关联作为首条四 Plane 纵向切片 | Superseded in part by ADR-0021；范围/canary 保留 | 用户产品决策 |
| [ADR-0019](0019-remote-connector-online-upgrade.md) | Remote Connector 分层在线升级 | Accepted；Decision 12 superseded by ADR-0028 | 用户产品决策 |
| [ADR-0020](0020-flexible-two-or-three-level-navigation.md) | 菜单最多三级，允许二级 Feature | Accepted | 用户产品决策 |
| [ADR-0021](0021-initial-feature-development-order.md) | 首批 Feature 开发顺序 | Accepted | 用户产品决策 |
| [ADR-0022](0022-shell-first-independent-feature-packages.md) | 先交付真实 Shell 基线，首批功能使用独立 Feature 包 | Accepted | 用户产品决策 |
| [ADR-0023](0023-feature-documentation-bundle.md) | Feature 四 Plane 实现文档随安装发布到项目文档 | Accepted | 用户产品决策 |
| [ADR-0024](0024-agent-managed-content-registry.md) | 后台保存 Agent 管理内容的当前投影与不可变变更登记 | Accepted | 用户产品决策 |
| [ADR-0025](0025-authoritative-light-heavy-workspace-reads.md) | 权威轻抓取与有界重抓取 | Accepted | 用户产品决策 |
| [ADR-0026](0026-official-signed-package-supply-chain.md) | 只允许官方签名的 Feature 与 Operation 包 | Accepted | 用户产品决策 |
| [ADR-0027](0027-portable-data-root-and-update-boundary.md) | 便携根目录内的数据与更新边界 | Accepted | 用户产品决策 |
| [ADR-0028](0028-remote-automatic-safe-window-rollout.md) | Remote Connector 默认自动安全窗口更新 | Accepted | 用户产品决策 |
| [ADR-0029](0029-user-or-authorized-codex-template-publication.md) | 模板由用户或获单次授权的 Codex 发布 | Accepted | 用户产品决策 |
| [ADR-0030](0030-v4-evidence-seeded-recertification.md) | 以 v4 证据启动 v5 删除与录制的重新认证 | Accepted | 用户产品决策 |
| [ADR-0031](0031-fast-local-feature-iteration-and-automated-integrity.md) | Feature 本地快速迭代与自动完整性处理 | Accepted | 用户开发/交付决策 |
| [ADR-0032](0032-shell-layout-and-settings-surfaces.md) | 精简 Shell Rail、纯功能菜单、全局会话栏与设置双列布局 | Accepted；Feature placement 由 ADR-0034 更新 | 用户 UI 产品决策 |
| [ADR-0033](0033-menu-only-shell-and-independent-feature-windows.md) | Shell 第二列只保留功能菜单，Feature Surface 保持受控隔离 | Accepted；默认 placement 由 ADR-0034 更新 | 用户 UI 产品决策 + v4 证据 |
| [ADR-0034](0034-tabbed-feature-host-and-detachable-surfaces.md) | 第三列浏览器式 Feature 标签、功能栏折叠及弹出/最小化/关闭 | Accepted | 用户 UI 产品决策 + v4 折叠证据 |
| [ADR-0035](0035-remote-only-connector-and-link-code-pairing.md) | Remote-only Connector、一次性链接码与长期设备 binding | Accepted | 用户正式产品决策 + v4 配对方向证据 |

Accepted 表示架构方向已确定。根据 ADR-0031，未确定的 Windows sandbox/认证可以后续加固，
但不再阻碍 Feature 安装、启用或开发测试；真实 Worker/后台/Operation 依赖仍必须接通。

## 待创建/确认的 Proposed ADR

| 编号建议 | 决策 | 所需输入 |
|---|---|---|
| ADR-0005 | Shell/Core runtime 与 IPC 技术栈 | Windows 目标、原型、安全/性能基准 |
| ADR-0006 | Core/Module Store 物理实现 | 并发、备份、迁移、容量基准 |
| ADR-0007 | Windows Feature Worker/Parser/Operation 与 Feature UI 可选加固 | 进程/UI 权限攻击测试、兼容和运维；不得成为安装/使用认证门槛 |
| ADR-0014 | Remote Bridge 身份、部署、TTL、加密与 SLA | 威胁模型、部署环境和断网/重连原型 |

## ADR 模板

```markdown
# ADR-NNNN：标题

状态：Proposed
日期：YYYY-MM-DD
决策者：待指定

## Context

事实、约束、风险和证据。

## Decision

清晰、可测试的决定；未决定的实现细节必须列出。

## Consequences

正面、成本、迁移和运营影响。

## Alternatives

考虑过的替代方案及拒绝/待定原因。

## Verification

合同、测试、指标、canary 和退出门槛。
```
