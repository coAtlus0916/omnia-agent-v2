# Agent 开发入口

本页是新 Agent 的导航，不要求默认通读整个仓库或整个 v4。先读固定必读包，再按任务路由阅读专项文档、源码和测试。所有链接均以当前 v5 工作区为准。

## 1. 固定必读包（按顺序）

1. [项目规则](../../AGENTS.md)
2. [开发手册](DEVELOPMENT_PLAYBOOK.md)：DoR/DoD、真实接线、所有权和禁止事项。
3. [系统架构](../architecture/SYSTEM_ARCHITECTURE.md)：前台、中台、后台、Connector 四 Plane、进程和信任边界。
4. [统一合同](../contracts/CONTRACTS.md)：Run、状态、错误、幂等、`uncertain`、`reconcile` 和证据。
5. [Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)：独立包目录、manifest、四 Plane 文档、安装/升级/回滚。
6. [Connector Gate](../architecture/CONNECTOR_GATE.md)：Remote Transport、Session/Gate/Operation host、链接码配对和在线升级边界。
7. [数据与存储](../data/DATA_AND_STORAGE.md)：Core 数据所有权、便携根、迁移、备份和保留。
8. [Agent Managed Content 登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)：创建、修改、删除、revision、relation、tombstone 和 Phase 2 查询。
9. [Feature 快速开发与测试](FEATURE_FAST_ITERATION_GUIDE.md)：构建、自动签名/摘要、安装到测试便携根和真实缺口表达。
10. [Shell 实现映射](../implementation/SHELL_IMPLEMENTATION_MAP.md)：当前 Shell/AI/布局/Remote-only Connector 已经实现的边界。

固定包读完后，再查看 [Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md) 和 [文档中心](../README.md) 的当前状态表。

## 2. 专项阅读路由

| 任务 | 必读专项文档 | 建议源码/测试入口 |
|---|---|---|
| UI、首页、设置、布局 | [Shell UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md)、[全局缩放](../product/GLOBAL_UI_SCALE.md)、[可调整布局](../product/RESIZABLE_LAYOUT_SYSTEM.md)、ADR-0032/0033/0034 | [`src/renderer/index.tsx`](../../src/renderer/index.tsx)、相应 `tests/*ui*` 和 `tests/shell*` |
| 新 Feature | [Feature 文档模板](FEATURE_DOCUMENTATION_TEMPLATE.md)、[Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md)、对应 `docs/product/*_FEATURE.md` | 现有 `feature-packages/recording`、`feature-packages/delete-elements` 的 source、manifest 和测试 |
| 后台数据、模板、Phase 2 | [数据与存储](../data/DATA_AND_STORAGE.md)、[Managed Content 登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)、[Schema 与迁移](../implementation/DATA_SCHEMA_AND_MIGRATIONS.md)、[模板与文档管线](../data/TEMPLATE_AND_DOCUMENT_PIPELINE.md) | [`src/main/database.ts`](../../src/main/database.ts)、`src/main/features/`、`tests/*database*`、`tests/*managed*` |
| Connector/Remote-only | [Connector Gate](../architecture/CONNECTOR_GATE.md)、[ADR-0035](../adr/0035-remote-only-connector-and-link-code-pairing.md)、[0.3.8 发布记录](../implementation/REMOTE_CONNECTOR_0_3_8_RELEASE.md)、[Bridge 0.4.4 发布记录](../implementation/BRIDGE_0_4_4_RELEASE.md)、[Bridge 部署合同](../implementation/V5_BRIDGE_DEPLOYMENT.md)、[v4 复用清单](../implementation/V4_REUSE_MANIFEST.md) | [`src/connector/workstation-omnia-session.ts`](../../src/connector/workstation-omnia-session.ts)、[`src/main/connector/remote-connector-transport.ts`](../../src/main/connector/remote-connector-transport.ts)、[`src/remote-connector/worker.ts`](../../src/remote-connector/worker.ts)、[`src/bridge/server.ts`](../../src/bridge/server.ts)、Remote/Bridge tests；不得恢复 Shell Local adapter/router |
| AI Provider | [AI Provider 架构](../ai/AI_PROVIDER_ARCHITECTURE.md)、[DeepSeek V4 Flash API 评审](../reviews/DEEPSEEK_V4_FLASH_API_REVIEW.md) | `src/main/services/ai-service.ts`、Provider tests |
| 诊断日志、交互错误定位 | [统一合同](../contracts/CONTRACTS.md)、[数据与存储](../data/DATA_AND_STORAGE.md)、[Schema 与迁移](../implementation/DATA_SCHEMA_AND_MIGRATIONS.md)、[Shell 实现映射](../implementation/SHELL_IMPLEMENTATION_MAP.md) | `src/main/services/interaction-log-service.ts`、`src/main/index.ts`、`src/renderer/index.tsx`、`tests/interaction-logging.test.ts`；禁止读取或记录 Secret、正文、文件内容和完整路径 |
| Phase 1 / 新建与关联 | [Phase 1 母版待办](../planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)、[新建与关联设计](../product/CREATE_AND_ASSOCIATE_FEATURE.md)、[四 Plane 差距评估](../research/V4_CREATE_ASSOCIATE_FOUR_PLANE_GAP_ASSESSMENT.md)、[SAP ECC v4 录制审计](../research/SAP_ECC_RECORDING_PHASE1_MASTER_AUDIT.md)、[默认文档准备项目](../planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md)、[当前 V8 母版](../../../outputs/sap_ecc_phase1_master_update/phase1_系统信息填写V8_SAP_ECC_v4录制证据补充.xlsx) | `src/main/features/`、`src/main/database.ts`、`src/connector/operation-host.ts`、对应 operation/feature tests |
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
4. Remote Transport 与公司电脑 Session Core 的共同合同、失败关闭、无 Local fallback 证明和额外部署要求；
5. 测试分层、真实 Omnia/Pack canary 计划和尚未能验证的部分。

对于新 Feature、v4 迁移或复用任务，还必须先给出以下四项，未冻结前不要开始大范围编码：

1. **复用矩阵**：逐项列出 `v4 文件/函数/证据 → 行为语义 → v5 模块 → 测试向量 → 采用/重写/拒绝`；只读精确入口，不通读或运行整个 v4。默认在 15–20 分钟内收束，超时就记录证据缺口、标为 unsupported 或拆分研究任务。
2. **支持矩阵**：按对象类型和 action 列出解析、转换、Operation、自动化、便携冒烟、真实 canary 和入口启用状态。只有真实后端闭环存在的能力才能开放。
3. **范围与所有权**：列出本轮真实纵切、明确非目标、四 Plane 文件所有权和可并行任务。平台补洞预计超过 30 分钟，或需要同时扩大三个以上通用模块时，先拆出平台任务；不要让一个 Feature 顺手承担整个平台重构。
4. **分层验收计划**：规定开发内环的定向测试、第一份真实产物的早期视觉/结构验收、冻结前唯一一次完整验收、冻结后的最小产物冒烟。不要把这些阶段混在一个重复循环中。

## 4. 开发、验收、打包和发布顺序

### 4.1 开发内环

- 只运行与当前改动直接相关的 lint、typecheck 和定向测试；安全关键状态、幂等、读回和失败关闭不能因追求速度而省略。
- 不升正式版本，不生成候选发布清单，不反复 build/ZIP/sign，也不做人工全树 before/after hash。
- 产生第一份真实 Excel、文档或其他最终格式后立即做结构、公式、分页、行高、字体和来源追踪验收，不要等到最终打包后才发现视觉问题。
- 新发现的非阻塞平台缺口或范围外对象类型另立任务；本轮入口保持隐藏或真实禁用。

### 4.2 冻结前验收

- 定向测试和真实产物验收通过后，再按风险运行一次完整 `npm run check` 及必要的安装、升级/回滚合同测试。
- 这是业务正确性的最终源码门禁；失败就继续开发，不能先落版本、生成候选包或进入发布步骤。
- 全绿后一次性冻结源码身份、版本、组件清单和验收记录。冻结后任何业务代码、测试基线或随包文档变化都使候选作废，必须重新回到本阶段。

### 4.3 一次性候选产物

- 从冻结源码执行一次 build。各包装脚本应消费同一冻结 `dist`/staging 输出，不得各自隐式重复完整 build。
- 按实际变更 Plane 打包：Feature/Operation-only 只生成对应 `.ofp/.ofop`；没有 Shell、Bridge 或 Connector 变更时不重打这些组件。
- 每个组件只复制、压缩、生成 manifest/digest 并签名一次，形成唯一不可变 `artifactId`。Portable、upgrade、canary 和正式发布必须复用同一字节产物，禁止为不同阶段重新压缩。
- Shell 当前只维护 `releases/` 产品根，不再生成 `artifacts/` 副本或 ZIP。`releases/` 根持有身份标记、`current`、启动脚本与版本外 `data/`，版本目录为 `releases/<version>/`；用户测试直接运行该根的 CMD 或版本 EXE。

### 4.4 最小发布门禁

- 发布阶段不再重复源码 lint、typecheck、业务测试或全量 `npm run check`；只验证冻结 artifact 的目标版本/组件身份、官方签名和 manifest，以及最小安装、启动、升级、原子切换和回滚能力。
- 删除人工和同一流程内重复的全树 SHA/Hash。必须保留的校验只有真实信任边界：包生成、外部包进入安装边界、Remote 正式更新/v4 通道隔离，以及业务和模板来源证据。
- 已验签 artifact 应复制到按 digest 标识的只读受管位置；安装、启动和后续环境直接引用它，不为同一未变化文件反复验签或计算逐成员 SHA。
- 产物冒烟失败时只处理打包、安装或启动问题；若需要修改业务逻辑，立即废弃候选并回到冻结前验收。
- 自动化启动冒烟必须真正执行用户入口。绕过 CMD/启动器直接拉起 EXE 的测试只能证明内部进程可运行，不能记为用户入口通过；最终以用户直接测试为准。

## 5. 完成定义（DoD）

- UI action 已连接真实状态，错误和不可用原因可见；没有后端的入口隐藏、禁用或标记 `coming soon`。
- Feature 的 source、manifest、签名包、四 Plane 实现文档、测试和文档登记同步更新；安装/升级/回滚不会破坏其他 Feature。
- Omnia mutation 具备签名 Operation、预检、确认、幂等、读回和 `uncertain/reconcile`；Remote 失败关闭且不存在 Local fallback。
- Managed Content、模板、Evidence、revision/relation/tombstone 的写入和查询走公共合同，不直连私有数据库拼装 Phase 2 结果。
- 运行相关 lint、typecheck、单元/合同/安装/便携或连接测试；最后按风险执行 `npm run check`。
- 交付报告列出实际修改文件、测试命令及结果，并清楚区分“代码/fixture 通过”“便携冒烟通过”和“真实 Omnia canary 已通过”。
