# Omnia Agent v5 文档中心

本页是 v5 文档的当前状态索引。新 Agent 必须先读 [Agent 开发入口](development/AGENT_START_HERE.md)，再按任务路由阅读；不要把历史验收或 v4 研究报告当作当前实现状态。

## 当前状态（2026-08-14）

| 项目 | 源码事实 | 未完成边界 |
|---|---|---|
| Shell | `0.4.18`；Connector Next v3 是唯一 Connector 路径 | 2026-08-14 本地便携包由主 EXE 托管 loopback Server 与 Agent，仅连接 `127.0.0.1`，没有远程 Connector 服务器依赖；尚未形成新的公开 Tag。 |
| Create & Associate | `0.2.150 / sequence 152` | 签名候选已跟踪并进入当前便携包；签名、摘要和内嵌 Operation 一致性已验证，当前精确 digest 的 live acceptance pending。 |
| Delete Elements | `0.3.32 / sequence 1786632995691` | 已进入当前本地 `0.4.18` company-loopback 产物；当前精确 digest 的完整真实删除 canary pending。 |
| Recording | `0.4.21 / sequence 34` | 已进入当前本地 `0.4.18` company-loopback 产物；当前精确 digest 的现场录制/导出验收不从历史版本继承。 |
| Workpaper Preparation | `0.1.71 / sequence 72` | 富文本 JSON 写回、嵌套制度 ZIP 和单制度模板重绑定已打包；当前精确 digest 的真实 Pack 写回 canary pending。 |
| Company loopback | Create `0.2.150`、Recording `0.4.21`、Delete `0.3.32`、Workpaper `0.1.71` | inventory、构建期望、复制列表和 manifest 已收敛；2026-08-14 已从 `c1b57b3` 干净快照生成本地产物。 |
| Connector Next | 唯一 Connector 产品链；协议 `omnia.connector-next/v3` | 远端/本机 loopback 是部署 profile 差异，不是两套业务源码；真实 Pack canary 以精确目标、Feature/Operation digest 和发布记录为准。 |

四个 Feature 仍不能仅凭候选包或自动化表述为“当前版本已独立升级/回滚并完成 live acceptance”。[四 Feature 独立性审计](architecture/FEATURE_INDEPENDENCE.md) 是 2026-08-10 的审计快照；分支其后已演进，原行号和个别关闭状态需要在下一次发布冻结前重新审计，不能直接当作 2026-08-14 当前结论。

Feature 的原装/内置/后装/Operation/额外部署边界以 [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md) 为准；Shell 的实际代码映射以 [Shell 实现映射](implementation/SHELL_IMPLEMENTATION_MAP.md) 为准。

## 推荐阅读顺序

1. [Agent 开发入口](development/AGENT_START_HERE.md)
2. [开发手册](development/DEVELOPMENT_PLAYBOOK.md)
3. [系统架构](architecture/SYSTEM_ARCHITECTURE.md)
4. [四 Feature 独立性审计](architecture/FEATURE_INDEPENDENCE.md)
5. [统一合同](contracts/CONTRACTS.md)
6. [Feature Package 标准](architecture/FEATURE_PACKAGE_STANDARD.md)
7. [Connector Gate](architecture/CONNECTOR_GATE.md)
8. [数据与存储](data/DATA_AND_STORAGE.md) 与 [Managed Content 登记簿](data/AGENT_MANAGED_CONTENT_REGISTRY.md)
9. [Feature 快速开发与测试](development/FEATURE_FAST_ITERATION_GUIDE.md)
10. [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)
11. 对应任务的产品设计、实现文档、研究报告、源码和测试。

## 架构与合同

- [系统架构](architecture/SYSTEM_ARCHITECTURE.md)：前台、中台、后台、Connector 四 Plane、进程与信任边界。
- [四 Feature 独立性审计](architecture/FEATURE_INDEPENDENCE.md)：Feature 独立性不变量、P0–P2 实现证据、测试和发布关闭条件。
- [统一合同](contracts/CONTRACTS.md)：公共对象、状态、错误、幂等、`uncertain`、`reconcile`。
- [Feature Package 标准](architecture/FEATURE_PACKAGE_STANDARD.md)：独立包、manifest、四 Plane 实现、安装升级回滚。
- [Connector Gate](architecture/CONNECTOR_GATE.md)：Remote-only Transport/Session/Gate/Operation host、链接码/binding/Pack 状态。
- [Connector Next 架构](architecture/CONNECTOR_NEXT.md)：当前唯一 Connector 产品、协议、exact target、durable job 与更新边界。旧 ADR-0035 文件已退出当前文档树，其历史决定不得覆盖 Connector Next v3 现状。
- [数据与存储](data/DATA_AND_STORAGE.md)：Core Store、便携数据根、迁移、备份和保留。
- [Agent Managed Content 登记簿](data/AGENT_MANAGED_CONTENT_REGISTRY.md)：创建、修改、删除、revision、relation、tombstone。
- [模板与文档管线](data/TEMPLATE_AND_DOCUMENT_PIPELINE.md)：默认模板、最小 Patch、验证和发布。
- [Schema 与迁移](implementation/DATA_SCHEMA_AND_MIGRATIONS.md)：数据库结构和迁移合同。

## 当前实现与发布

- [Shell 实现映射](implementation/SHELL_IMPLEMENTATION_MAP.md)
- [Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)
- [Feature 快速开发、安装与测试](development/FEATURE_FAST_ITERATION_GUIDE.md)
- [Git 分支、Remote 联调与便携发布流程](development/GIT_BRANCH_AND_RELEASE_WORKFLOW.md)
- [Feature 随包文档模板](development/FEATURE_DOCUMENTATION_TEMPLATE.md)
- [新建与关联 0.2.6 热更新](implementation/CREATE_ASSOCIATE_0_2_6_HOT_UPDATE.md)
- [录制 Feature 实现](implementation/RECORDING_FEATURE.md)
- [Connector Next 架构与运行边界](architecture/CONNECTOR_NEXT.md)
- [公司本地 Connector Next 便携包发布指南](development/COMPANY_LOOPBACK_PORTABLE_RELEASE.md)
- 旧 Remote-only 迁移说明与 Shell 0.4.2 验收文件已退出当前文档树；需要历史上下文时以 Git 历史读取，不作为当前实现链接。
- [Shell 0.4.3 新建与关联便携验收](reviews/SHELL_0_4_3_CREATE_ASSOCIATE_PORTABLE_ACCEPTANCE.md)
- [Shell 0.4.4 启动修复与便携入口验收](reviews/SHELL_0_4_4_STARTUP_ACCEPTANCE.md)
- 公司电脑旧 Remote Pack canary 文件已退出当前文档树；当前 live acceptance 必须针对 Connector Next、精确 Feature/Operation digest 重新记录。
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
- [新建与关联能力架构](implementation/CREATE_ASSOCIATE_CAPABILITY_ARCHITECTURE.md)：当前参数化能力、四 Plane 与新增类型门禁。旧 ADR-0036 文件已退出当前文档树。
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
- Shell/Remote 0.2.0 历史验收文件已退出当前文档树；如需证据只能从 Git 历史读取，不能作为当前状态来源。
- [早期独立技术审查](reviews/INDEPENDENT_FEASIBILITY_ARCHITECTURE_REVIEW.md)
- 各 ADR 的 Proposed/Accepted 时间点和 v4 研究快照

## 文档维护规则

实现、Feature 包和测试状态变化时，必须同时更新 Feature 随包文档、[Feature 包总览](implementation/FEATURE_PACKAGE_CATALOG.md)、对应实现/验收记录和本页状态表。自动化 fixture 通过不等于真实 Omnia canary；未实机验证的能力必须继续保持“待 canary/不可用”表述。
