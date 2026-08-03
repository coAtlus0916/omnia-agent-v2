# Omnia Agent v5 文档中心

本页是 v5 文档的当前状态索引。新 Agent 必须先读 [Agent 开发入口](development/AGENT_START_HERE.md)，再按任务路由阅读；不要把历史验收或 v4 研究报告当作当前实现状态。

## 当前状态（2026-08-03）

| 项目 | 当前状态 | 仍待完成 |
|---|---|---|
| Shell | `0.4.1` UI regression patch：native Surface 单实例附着、Comments/Settings 遮挡修复、真实统一缩放、稳定设置外框与持久化 splitter | 真实 Pack hierarchy、真实 Provider 和公司设备表现需 canary |
| 录制 | 官方签名独立 Feature `omnia.recording 0.1.1 / sequence 2`，随 Shell 便携包内置，首次启动自动升级/注册；显式 rollback 不被启动覆盖 | 真实 Pack/Remote 现场 canary |
| 删除元素 | 独立后装 Feature `0.1.2`，Local 自动化闭环已接通 | 目标 Pack 的真实 mutation 与 Remote 业务删除待 canary |
| 删除聊天记录 | 未交付 | 仍处于产品设计阶段 |
| 新建与关联 | 未交付 | 需要 TemplateVersion、Managed Content 和签名 Operation |
| Phase 1 母版 | 已完成治理母版：7 sheets、183 字段、68 条关系、21 条 v4 证据、180/180 源字段追溯、公式错误 0 | 用户整理业务值并发布首个 TemplateVersion |
| Remote | Connector `0.3.4 / sequence 7`、Bridge `0.4.0` 独立上线；支持 discovery、status/light read、录制、签名 Operation register/invoke 传输与自动升级 | 具体业务 mutation 仍待公司电脑 canary；v4 更新通道保持不变 |
| Nova | 仅保留 OpenAI-compatible 配置路径 | Nova 专有协议尚未校验 |

Feature 的原装/内置/后装/Operation/额外部署边界以 [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md) 为准；Shell 的实际代码映射以 [Shell 实现映射](implementation/SHELL_IMPLEMENTATION_MAP.md) 为准。

## 推荐阅读顺序

1. [Agent 开发入口](development/AGENT_START_HERE.md)
2. [开发手册](development/DEVELOPMENT_PLAYBOOK.md)
3. [系统架构](architecture/SYSTEM_ARCHITECTURE.md)
4. [统一合同](contracts/CONTRACTS.md)
5. [Feature Package 标准](architecture/FEATURE_PACKAGE_STANDARD.md)
6. [Connector Gate](architecture/CONNECTOR_GATE.md)
7. [数据与存储](data/DATA_AND_STORAGE.md) 与 [Managed Content 登记簿](data/AGENT_MANAGED_CONTENT_REGISTRY.md)
8. [Feature 快速开发与测试](development/FEATURE_FAST_ITERATION_GUIDE.md)
9. [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)
10. 对应任务的产品设计、实现文档、研究报告、源码和测试。

## 架构与合同

- [系统架构](architecture/SYSTEM_ARCHITECTURE.md)：前台、中台、后台、Connector 四 Plane、进程与信任边界。
- [统一合同](contracts/CONTRACTS.md)：公共对象、状态、错误、幂等、`uncertain`、`reconcile`。
- [Feature Package 标准](architecture/FEATURE_PACKAGE_STANDARD.md)：独立包、manifest、四 Plane 实现、安装升级回滚。
- [Connector Gate](architecture/CONNECTOR_GATE.md)：Transport/Session/Gate/Operation host、Local/Remote 切换。
- [数据与存储](data/DATA_AND_STORAGE.md)：Core Store、便携数据根、迁移、备份和保留。
- [Agent Managed Content 登记簿](data/AGENT_MANAGED_CONTENT_REGISTRY.md)：创建、修改、删除、revision、relation、tombstone。
- [模板与文档管线](data/TEMPLATE_AND_DOCUMENT_PIPELINE.md)：默认模板、最小 Patch、验证和发布。
- [Schema 与迁移](implementation/DATA_SCHEMA_AND_MIGRATIONS.md)：数据库结构和迁移合同。

## 当前实现与发布

- [Shell 实现映射](implementation/SHELL_IMPLEMENTATION_MAP.md)
- [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)
- [Feature 快速开发、安装与测试](development/FEATURE_FAST_ITERATION_GUIDE.md)
- [Feature 随包文档模板](development/FEATURE_DOCUMENTATION_TEMPLATE.md)
- [录制 Feature 实现](implementation/RECORDING_FEATURE.md)
- [Remote Connector 0.3.4 发布记录](implementation/REMOTE_CONNECTOR_0_3_4_RELEASE.md)
- [v5 Bridge 部署合同](implementation/V5_BRIDGE_DEPLOYMENT.md)
- [前代实现复用清单](implementation/V4_REUSE_MANIFEST.md)
- [Phase 1 母版待办与最终工作簿](planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)
- [最终 Phase 1 母版文件](../outputs/019fb190-b0b1-7fb2-94d1-f3f7cad4a853-sol-rebuild/omnia-agent-phase1-master-v4-based.xlsx)

## 产品与专项设计

- [产品需求](product/PRODUCT_REQUIREMENTS.md)
- [首批 Feature 范围](product/INITIAL_FEATURE_SCOPE.md)
- [录制](product/RECORDING_FEATURE.md)
- [删除元素](product/DELETE_ELEMENTS_FEATURE.md)
- [删除聊天记录](product/DELETE_CHAT_HISTORY_FEATURE.md)
- [新建与关联](product/CREATE_AND_ASSOCIATE_FEATURE.md)
- [全局缩放](product/GLOBAL_UI_SCALE.md)
- [可调整布局](product/RESIZABLE_LAYOUT_SYSTEM.md)
- [主界面布局规范](design/SHELL_UI_LAYOUT_SPEC.md)
- [AI Provider 架构](ai/AI_PROVIDER_ARCHITECTURE.md)
- [DeepSeek V4 Flash API 差异评审](reviews/DEEPSEEK_V4_FLASH_API_REVIEW.md)

## v4 证据与评估

v4 仅用于证据、接口路径和行为复核。开发 Agent 先读 [v4 复用清单](implementation/V4_REUSE_MANIFEST.md) 和研究报告，再按报告给出的精确文件/符号读取 v4；不得默认通读、运行或把 v4 路径作为 v5 运行时依赖。

- [v4 全面审计](research/v4-audit.md)
- [v4 删除与录制证据基线](research/V4_DELETE_RECORDING_EVIDENCE_BASELINE.md)
- [新建与关联四 Plane 差距评估](research/V4_CREATE_ASSOCIATE_FOUR_PLANE_GAP_ASSESSMENT.md)
- [新建与关联默认文档准备项目](planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md)
- [架构与可行性审查](reviews/ARCHITECTURE_REVIEW.md)

## 历史快照（不代表当前状态）

以下文档保留当时的验收证据或设计阶段结论，可能写着“录制尚无 v5 包”“Remote Operation host 未发布”或“Phase 1 本轮不制作 Excel”。这些句子只能解释历史时间点，不能覆盖顶部当前状态和 [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)：

- [Shell 0.1.0 历史验收](reviews/SHELL_0_1_0_ACCEPTANCE.md)
- [Shell 0.4.1 UI 回归验收](reviews/SHELL_0_4_1_UI_REGRESSION_ACCEPTANCE.md)
- [Remote Connector 0.1.0 历史发布记录](implementation/REMOTE_CONNECTOR_0_1_0_RELEASE.md)
- [Shell/Remote 0.2.0 历史验收](reviews/SHELL_REMOTE_0_2_0_ACCEPTANCE.md)
- [早期独立技术审查](reviews/INDEPENDENT_FEASIBILITY_ARCHITECTURE_REVIEW.md)
- 各 ADR 的 Proposed/Accepted 时间点和 v4 研究快照

## 文档维护规则

实现、Feature 包和测试状态变化时，必须同时更新 Feature 随包文档、[Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)、对应实现/验收记录和本页状态表。自动化 fixture 通过不等于真实 Omnia canary；未实机验证的能力必须继续保持“待 canary/不可用”表述。
