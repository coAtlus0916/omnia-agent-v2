# Omnia Agent v5 文档中心

本页是 v5 文档的当前状态索引。新 Agent 必须先读 [Agent 开发入口](development/AGENT_START_HERE.md)，再按任务路由阅读；不要把历史验收或 v4 研究报告当作当前实现状态。

## 当前状态（2026-08-05）

| 项目 | 当前状态 | 仍待完成 |
|---|---|---|
| Shell | `0.4.12` Remote-only：安全锁支持搜索、Omnia 真实所在部分折叠、右侧已选与全局关联锁；Core 单飞读取、CAS 持久化并冻结精确成员；固定宿主由启动器加载工作区热构建；内置 recording 0.3.0、create-associate 0.2.8 与 delete-elements 0.2.0 | 真实所在部分目录已现场只读采样；保存/冻结读回待发布后确认 |
| 录制 | 官方签名独立 Feature `omnia.recording 0.3.0 / sequence 4`，播放器式真实 start/pause/resume/stop/export 并自动采集当前页 Risk/Control | 真实 Pack/Remote 现场 canary |
| 删除元素 | 独立签名 Feature `0.2.0 / sequence 7`，随 Shell 内置自动安装/升级；声明式真实目录、多选，Comments 消息卡唯一持有计划 | 首批只开放零 blocker Information；目标 Pack 的真实 Remote mutation 待公司电脑 canary；不允许 fallback Local |
| 删除聊天记录 | 未交付 | 仍处于产品设计阶段 |
| 新建与关联 | `omnia.create-associate@0.2.8 / sequence 10`；authority 与安全锁/delete 共用真实 Facet 目录，只接受精确 Engagement 下的 `CustomWorkspaceGroup → CustomWorkspace.parentId`，Workspace 名称必须唯一命中且处于安全锁范围 | 真实 SAP ECC mutation/readback canary 待完成；AI review port 待接通 |
| Phase 1 母版 | 已冻结 V8 治理输入：9 sheets、187 字段、68 条关系、21 条 v4 证据、180/180 源字段追溯；运行时使用独立签名 base/TemplateInstance，不把 V8 当用户模板 | 真实 Omnia/目标 Pack canary 未通过；待发布首个获批 TemplateVersion |
| Remote | Remote-only：Bridge `0.4.5` 下发在线更新；Connector `0.3.14 / sequence 17` 读取 Omnia 真实 `CustomWorkspaceGroup → CustomWorkspace.parentId`；无 Local fallback | 真实接口与层级响应已现场只读采样；stable 自动升级和安全锁保存读回按发布状态记录 |
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
- [Connector Gate](architecture/CONNECTOR_GATE.md)：Remote-only Transport/Session/Gate/Operation host、链接码/binding/Pack 状态。
- [ADR-0035 Remote-only Connector](adr/0035-remote-only-connector-and-link-code-pairing.md)：无 Local、一次性链接码、长期 credential、重新配对和解除绑定。
- [数据与存储](data/DATA_AND_STORAGE.md)：Core Store、便携数据根、迁移、备份和保留。
- [Agent Managed Content 登记簿](data/AGENT_MANAGED_CONTENT_REGISTRY.md)：创建、修改、删除、revision、relation、tombstone。
- [模板与文档管线](data/TEMPLATE_AND_DOCUMENT_PIPELINE.md)：默认模板、最小 Patch、验证和发布。
- [Schema 与迁移](implementation/DATA_SCHEMA_AND_MIGRATIONS.md)：数据库结构和迁移合同。

## 当前实现与发布

- [Shell 实现映射](implementation/SHELL_IMPLEMENTATION_MAP.md)
- [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)
- [Feature 快速开发、安装与测试](development/FEATURE_FAST_ITERATION_GUIDE.md)
- [Feature 随包文档模板](development/FEATURE_DOCUMENTATION_TEMPLATE.md)
- [新建与关联 0.2.6 热更新](implementation/CREATE_ASSOCIATE_0_2_6_HOT_UPDATE.md)
- [录制 Feature 实现](implementation/RECORDING_FEATURE.md)
- [Remote Connector 0.3.4 发布记录](implementation/REMOTE_CONNECTOR_0_3_4_RELEASE.md)
- [Remote Connector 0.3.5 Remote-only 发布记录](implementation/REMOTE_CONNECTOR_0_3_5_RELEASE.md)
- [Remote Connector 0.3.6 新建与关联 Gate 发布记录](implementation/REMOTE_CONNECTOR_0_3_6_RELEASE.md)
- [Remote Connector 0.3.7 可升级便携包发布记录](implementation/REMOTE_CONNECTOR_0_3_7_RELEASE.md)
- [v5 Bridge 部署合同](implementation/V5_BRIDGE_DEPLOYMENT.md)
- [Bridge 0.4.4 配对收紧发布记录](implementation/BRIDGE_0_4_4_RELEASE.md)
- [Remote-only 迁移说明](implementation/REMOTE_ONLY_MIGRATION.md)
- [Shell 0.4.2 Remote-only UI/Connector 验收](reviews/SHELL_0_4_2_REMOTE_ONLY_ACCEPTANCE.md)
- [Shell 0.4.3 新建与关联便携验收](reviews/SHELL_0_4_3_CREATE_ASSOCIATE_PORTABLE_ACCEPTANCE.md)
- [Shell 0.4.4 启动修复与便携入口验收](reviews/SHELL_0_4_4_STARTUP_ACCEPTANCE.md)
- [公司电脑 Remote Pack canary](reviews/REMOTE_PACK_CANARY_0_4_2.md)
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
- [新建与关联四阶段 Remote 回传 ADR](adr/0036-create-associate-four-stage-remote-return.md)
- [新建与关联 0.1.0 验收记录](reviews/CREATE_ASSOCIATE_0_1_0_ACCEPTANCE.md)
- [新建与关联 0.2.1 验收记录](reviews/CREATE_ASSOCIATE_0_2_1_ACCEPTANCE.md)
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
