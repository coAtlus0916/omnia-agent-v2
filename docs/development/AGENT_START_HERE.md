# Agent 开发入口

本页是新 Agent 的导航，不要求默认通读整个仓库或整个 v4。先读固定必读包，再按任务路由阅读专项文档、源码和测试。所有链接均以当前 v5 工作区为准。

## 1. 固定必读包（按顺序）

1. [项目规则](../../AGENTS.md)
2. [开发手册](DEVELOPMENT_PLAYBOOK.md)：DoR/DoD、真实接线、所有权和禁止事项。
3. [系统架构](../architecture/SYSTEM_ARCHITECTURE.md)：前台、中台、后台、Connector 四 Plane、进程和信任边界。
4. [统一合同](../contracts/CONTRACTS.md)：Run、状态、错误、幂等、`uncertain`、`reconcile` 和证据。
5. [Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)：独立包目录、manifest、四 Plane 文档、安装/升级/回滚。
6. [Connector Gate](../architecture/CONNECTOR_GATE.md)：Transport/Session/Gate/Operation host、Local/Remote 切换和在线升级边界。
7. [数据与存储](../data/DATA_AND_STORAGE.md)：Core 数据所有权、便携根、迁移、备份和保留。
8. [Agent Managed Content 登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)：创建、修改、删除、revision、relation、tombstone 和 Phase 2 查询。
9. [Feature 快速开发与测试](FEATURE_FAST_ITERATION_GUIDE.md)：构建、自动签名/摘要、安装到测试便携根和真实缺口表达。
10. [Shell 实现映射](../implementation/SHELL_IMPLEMENTATION_MAP.md)：当前 Shell/AI/布局/Local/Remote 已经实现的边界。

固定包读完后，再查看 [Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md) 和 [文档中心](../README.md) 的当前状态表。

## 2. 专项阅读路由

| 任务 | 必读专项文档 | 建议源码/测试入口 |
|---|---|---|
| UI、首页、设置、布局 | [Shell UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md)、[全局缩放](../product/GLOBAL_UI_SCALE.md)、[可调整布局](../product/RESIZABLE_LAYOUT_SYSTEM.md)、ADR-0032/0033/0034 | [`src/renderer/index.tsx`](../../src/renderer/index.tsx)、相应 `tests/*ui*` 和 `tests/shell*` |
| 新 Feature | [Feature 文档模板](FEATURE_DOCUMENTATION_TEMPLATE.md)、[Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md)、对应 `docs/product/*_FEATURE.md` | 现有 `feature-packages/recording`、`feature-packages/delete-elements` 的 source、manifest 和测试 |
| 后台数据、模板、Phase 2 | [数据与存储](../data/DATA_AND_STORAGE.md)、[Managed Content 登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)、[Schema 与迁移](../implementation/DATA_SCHEMA_AND_MIGRATIONS.md)、[模板与文档管线](../data/TEMPLATE_AND_DOCUMENT_PIPELINE.md) | [`src/main/database.ts`](../../src/main/database.ts)、`src/main/features/`、`tests/*database*`、`tests/*managed*` |
| Local Connector | [Connector Gate](../architecture/CONNECTOR_GATE.md)、[v4 复用清单](../implementation/V4_REUSE_MANIFEST.md) | [`src/connector/contracts.ts`](../../src/connector/contracts.ts)、[`src/connector/local-connector.ts`](../../src/connector/local-connector.ts)、`src/main/connector/local-connector-adapter.ts`、Connector tests |
| Remote Connector/Bridge | [Remote 发布记录](../implementation/REMOTE_CONNECTOR_0_3_4_RELEASE.md)、[Bridge 部署合同](../implementation/V5_BRIDGE_DEPLOYMENT.md)、ADR-0028 | [`src/main/connector/remote-connector-transport.ts`](../../src/main/connector/remote-connector-transport.ts)、[`src/remote-connector/worker.ts`](../../src/remote-connector/worker.ts)、[`src/bridge/server.ts`](../../src/bridge/server.ts)、`tests/remote*`、`tests/bridge*` |
| AI Provider | [AI Provider 架构](../ai/AI_PROVIDER_ARCHITECTURE.md)、[DeepSeek V4 Flash API 评审](../reviews/DEEPSEEK_V4_FLASH_API_REVIEW.md) | `src/main/services/ai-service.ts`、Provider tests |
| Phase 1 / 新建与关联 | [Phase 1 母版待办](../planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)、[新建与关联设计](../product/CREATE_AND_ASSOCIATE_FEATURE.md)、[四 Plane 差距评估](../research/V4_CREATE_ASSOCIATE_FOUR_PLANE_GAP_ASSESSMENT.md)、[默认文档准备项目](../planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md)、[最终母版](../../outputs/019fb190-b0b1-7fb2-94d1-f3f7cad4a853-sol-rebuild/omnia-agent-phase1-master-v4-based.xlsx) | `src/main/features/`、`src/main/database.ts`、`src/connector/operation-host.ts`、对应 operation/feature tests |
| 录制 | [录制实现](../implementation/RECORDING_FEATURE.md)、[录制产品设计](../product/RECORDING_FEATURE.md)、[v4 删除/录制证据](../research/V4_DELETE_RECORDING_EVIDENCE_BASELINE.md) | `src/connector/recording/`、`feature-packages/recording/source/`、recording tests |
| 删除元素 | [删除元素设计](../product/DELETE_ELEMENTS_FEATURE.md)、`feature-packages/delete-elements/README.md`、[Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md) | `feature-packages/delete-elements/source/`、delete tests |
| 删除聊天记录 | [删除聊天记录设计](../product/DELETE_CHAT_HISTORY_FEATURE.md) | Shell chat store/service、相应 tests；未交付前不得伪造入口 |

### v4 证据的读取边界

开发者先读 [v4 复用清单](../implementation/V4_REUSE_MANIFEST.md) 和相关研究报告，再按报告给出的精确文件、函数和行号读取 `omnia-agent-v4`。不要默认通读、导入或运行整个 v4；v4 只能提供证据，所有运行时代码和资产必须在 v5 工作区内。

## 3. 开工前必须输出

开始编码前，在任务评论或变更说明中写清楚：

1. 本功能在前台、中台、后台、Connector 四 Plane 的责任和数据流；
2. 需要修改的文件、不会修改的边界，以及是否新增 Feature/Operation 包；
3. 真实 backend/state/Connector 能力来源，不能用 mock/sample/hardcoded 数据替代的地方；
4. Local 与 Remote 的共同合同、失败关闭和是否需要额外部署；
5. 测试分层、真实 Omnia/Pack canary 计划和尚未能验证的部分。

## 4. 完成定义（DoD）

- UI action 已连接真实状态，错误和不可用原因可见；没有后端的入口隐藏、禁用或标记 `coming soon`。
- Feature 的 source、manifest、签名包、四 Plane 实现文档、测试和文档登记同步更新；安装/升级/回滚不会破坏其他 Feature。
- Omnia mutation 具备签名 Operation、预检、确认、幂等、读回和 `uncertain/reconcile`；Local/Remote 不静默 fallback。
- Managed Content、模板、Evidence、revision/relation/tombstone 的写入和查询走公共合同，不直连私有数据库拼装 Phase 2 结果。
- 运行相关 lint、typecheck、单元/合同/安装/便携或连接测试；最后按风险执行 `npm run check`。
- 交付报告列出实际修改文件、测试命令及结果，并清楚区分“代码/fixture 通过”“便携冒烟通过”和“真实 Omnia canary 已通过”。
