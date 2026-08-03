# Omnia Agent v5 开发前文档验收

> 后续状态说明（2026-07-30）：本报告记录的是开发尚未获授权时的阶段门禁。用户随后明确授权由 Sol High 子 Agent 实现只包含首页五项能力的 Shell `0.1.0`，并由主 Agent 完成独立验收；该次授权只更新“正式 Shell Baseline”一项，不授权任何业务 Feature。当前实施结论见 [Shell 0.1.0 主验收](SHELL_0_1_0_ACCEPTANCE.md)。
>
> 后续决策（2026-08-01）：本文中的 D5/D6、Windows 强隔离认证、OS 生命周期/补丁和逐次人工 hash 门禁均为历史阶段结论，不再阻碍 Feature 开发、安装或使用。当前执行以 [ADR-0031](../adr/0031-fast-local-feature-iteration-and-automated-integrity.md)和 [Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md)为准；真实 Worker/后台/Connector 链路仍必须存在。

验收人：主 Agent  
验收日期：2026-07-30  
结论：**独立可行性复核和主 Agent 修订验收完成；文档收敛继续 Go，D5 有界技术原型仅在用户批准范围后 Conditional Go，正式 Shell Baseline 与全部业务 Feature 当前 No-Go。**

## 1. 验收范围

本次验收覆盖：

- v4 全面审计及其源码/测试证据；
- 主 Agent 需求评估；
- 产品、总体架构、Feature Package、Feature 随包文档模板、Connector、Agent 管理内容登记簿、Pack Sync/快照缓存评估、数据、模板、合同、AI、安全测试、迁移和开发手册；
- 17 份 Accepted ADR、2 份被取代或部分取代的历史 ADR 与 1 份 Proposed / Deferred ADR；
- 文档之间的术语、状态、依赖、数据所有权和验收门槛；
- [独立技术可行性与架构审查](INDEPENDENT_FEASIBILITY_ARCHITECTURE_REVIEW.md)提出的 0 个 P0、13 个 P1 和 4 个 P2，以及主 Agent 的逐项证据核验与修订；
- 工作区是否仍严格处于“只做文档、不开发”状态。

本次没有创建或验收任何 v5 应用代码、脚手架、数据库、服务、前端页面、Feature、Connector 或可点击功能。

## 2. 用户需求覆盖

| 用户要求 | 主要证据 | 验收判断 |
|---|---|---|
| 新建 v5 工作区，先整理方向和文档 | 根 README、本文档中心 | 通过；独立 Git 工作区仅有 Markdown、`.gitignore` 和本地文档编辑器配置 |
| 全面调研 v4 的 handoff、README、架构和功能 | [v4 全面审计](../research/v4-audit.md) | 通过；区分文档声称与代码现实，包含优缺点、P0–P2 风险和资产矩阵 |
| 前台只交付/接收，不处理资料 | [产品需求](../product/PRODUCT_REQUIREMENTS.md)、[系统架构](../architecture/SYSTEM_ARCHITECTURE.md) | 通过；上传进入后台 quarantine，Delivery 禁止解析、AI、DB、Omnia |
| 删除“+ Agent”，第二列改功能树 | [产品需求](../product/PRODUCT_REQUIREMENTS.md)、[统一合同](../contracts/CONTRACTS.md) | 通过；导航由真实 Feature Registry 生成，最大三级且允许二级/三级 Feature 叶子，Agent/Employee/Room 不迁产品面 |
| 紧凑、专业、类似 Navicat 的交互 | [产品需求](../product/PRODUCT_REQUIREMENTS.md) | 通过；已转化为树、密度、键盘、焦点、缩放与持久化要求，具体数值保持 Proposed |
| 中台功能相互隔离、可独立开发/部署/升级 | [Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[ADR-0001](../adr/0001-microkernel-isolated-feature-workers.md) | 通过；独立 Worker、数据 owner、manifest、生命周期、故障/升级/回滚门禁明确 |
| 先交付空 Shell，再用首批独立 Feature 包测试 | [Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[迁移路线](../migration/MIGRATION_ROADMAP.md)、[ADR-0022](../adr/0022-shell-first-independent-feature-packages.md) | 通过设计复核；先完成用户批准的 D5 conformance spikes 和 D6，再按“最小内核激活 → 平台服务逐项加入”实现真实空 Shell，无内置业务代码和假入口；四个包逐项安装和隔离回归 |
| 每个 Feature 记录各模块实现，安装时写入项目文档 | [Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[统一合同](../contracts/CONTRACTS.md)、[ADR-0023](../adr/0023-feature-documentation-bundle.md) | 通过；逐 capability 强制四 Plane 实现映射，签名代码/文档先崩溃安全 staging，再通过单一 activation record 一致激活/回滚；未安装设计稿不冒充当前实现 |
| 后台保存 Agent 创建、修改和删除的内容，供 Phase 2 使用 | [Agent 管理内容登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)、[统一合同](../contracts/CONTRACTS.md)、[ADR-0024](../adr/0024-agent-managed-content-registry.md) | 通过；共享后台域维护最后完整验证 snapshot + immutable revision/change，删除写 tombstone，partial 只按 whole object/relation 推进，查询必须受 maxAge/watermark、authority identity 和 repair 状态约束 |
| 保存连接过的 Pack、完善 Workspace 抓取 | [Pack 轻/重抓取与 Sync 降级评估](PACK_SYNC_CACHE_EVALUATION.md)、[ADR-0025](../adr/0025-authoritative-light-heavy-workspace-reads.md) | Accepted；轻抓取权威 Section + Workspace，重抓取限 Pack/选定 Workspace/capability；禁止名称推断，Sync 降级为可选性能优化，删除仍双重实时校验 |
| 后台独立存储处理数据、模板和交互文件 | [数据与存储](../data/DATA_AND_STORAGE.md)、[ADR-0027](../adr/0027-portable-data-root-and-update-boundary.md) | 通过；Core/Module Store 保存状态与结构，Artifact Store 保存正文，Secret/Evidence 分离；同一产品根分离 releases/data，更新不覆盖 data |
| 全默认直接使用模板；一般场景只改必要部分 | [模板与文档管线](../data/TEMPLATE_AND_DOCUMENT_PIPELINE.md)、[ADR-0004](../adr/0004-template-first-minimal-patch.md) | 通过；默认不等于缺失，全默认仍有 Run 副本/provenance，普通场景只用白名单最小 Patch |
| Connector 尽量只负责 gate，新功能少改 Core | [Connector Gate](../architecture/CONNECTOR_GATE.md)、[ADR-0003](../adr/0003-single-connector-transport.md) | 通过；Core 无业务分支，扩展使用签名受限 Operation Module，明确禁止任意 HTTP 后门 |
| 单一 Local 产品；本地/远程可选并沿用上次设置 | [Connector Gate](../architecture/CONNECTOR_GATE.md)、[产品需求](../product/PRODUCT_REQUIREMENTS.md)、[ADR-0008](../adr/0008-remote-for-all-versions.md) | 通过；Remote 面向全部版本，首次 local、单 active lease、成功后持久化、remote 时本地无 claim 权、故障不静默 fallback |
| Remote Connector 继续支持在线升级，但尽量少升级 Core | [Connector Gate](../architecture/CONNECTOR_GATE.md)、[ADR-0019](../adr/0019-remote-connector-online-upgrade.md)、[ADR-0028](../adr/0028-remote-automatic-safe-window-rollout.md) | 通过设计复核；服务器自动下发，Supervisor 自动取得/验证并在真实安全窗口激活；业务变化优先 side-by-side Operation Module，Core 仅按基础协议/安全/兼容变化走 A/B、probation 和 previous |
| 只允许官方签名 Feature 包 | [Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[ADR-0026](../adr/0026-official-signed-package-supply-chain.md) | 通过；生产无第三方、未签名或任意离线导入，未来只可另行兼容官方签名离线包 |
| 主界面保留三列结构，第三列保留聊天 | [产品需求](../product/PRODUCT_REQUIREMENTS.md)、[ADR-0010](../adr/0010-three-column-chat-shell.md) | 通过；第二列为最多三级的混合深度 Feature 树，第三列是与当前会话和 Feature 上下文一致的聊天/交付工作区 |
| 菜单不强制三级，有些功能只使用两级 | [统一合同](../contracts/CONTRACTS.md)、[ADR-0020](../adr/0020-flexible-two-or-three-level-navigation.md) | 通过；一级是业务域，二级可为 Feature 或 group，三级仅 Feature，禁止第四级 |
| 首批 Feature 为新建与关联、删除元素、删除聊天记录、录制 | [首批 Feature 范围](../product/INITIAL_FEATURE_SCOPE.md)、[ADR-0018](../adr/0018-create-associate-first-vertical-slice.md) | 通过；范围不变，删除功能仍保留后台安全锁 |
| 开发顺序为录制 → 删除元素 → 删除聊天记录 → 新建与关联 | [首批 Feature 范围](../product/INITIAL_FEATURE_SCOPE.md)、[ADR-0021](../adr/0021-initial-feature-development-order.md) | 通过；录制是第一开发切片，新建与关联是第四项和首批四 Plane 综合验收 |
| 用新建与关联测试四模块链路 | [新建与关联设计](../product/CREATE_AND_ASSOCIATE_FEATURE.md)、[v4 审计附录](../research/v4-audit.md) | 通过设计复核；第四阶段首个能力 canary 收窄为 Generic APP + Generic DB + 两个 GRA core + 唯一 DB → APP 双边读回 |
| 删除元素恢复简洁消息卡确认 | [删除元素 UX 复核](DELETION_UX_REVIEW.md)、[删除元素设计](../product/DELETE_ELEMENTS_FEATURE.md) | 用户已确认；保留 React/后台安全合同，紧凑两栏且无常驻选择篮，右上角消息卡独占确认/进度/结果，终态自动刷新目录 |
| 所有界面右上角提供 `−/+` 调节 | [全局界面缩放](../product/GLOBAL_UI_SCALE.md)、[ADR-0016](../adr/0016-global-ui-scale-control.md) | 通过；一级界面统一 `− 百分比 +`，后台持久化并跨窗口/重启同步，弹窗继承 |
| 所有功能区域边界可拖动调整 | [统一可调整分区](../product/RESIZABLE_LAYOUT_SYSTEM.md)、[ADR-0017](../adr/0017-unified-resizable-layout.md) | 通过；Shell/Feature 共用 Splitter，支持横纵/嵌套/键盘，布局按 surface 真实持久化 |
| DeepSeek 地址/模型可见，并支持其他兼容 API | [AI Provider 架构](../ai/AI_PROVIDER_ARCHITECTURE.md)、[ADR-0013](../adr/0013-defer-nova-protocol.md) | 通过；DeepSeek/Custom Profile、Base URL、模型发现/手填和真实测试已定义；Nova 精确协议延后，验证前不伪装支持 |
| 所有入口必须接真实后端/数据/状态 | [开发手册](../development/DEVELOPMENT_PLAYBOOK.md)、[产品需求](../product/PRODUCT_REQUIREMENTS.md) | 通过；已进入 DoR/DoD、UI 注册、测试和发布门禁 |

## 3. 主 Agent 独立复核结果

### 3.1 结构和机械检查

- 工作区中除 Git 元数据外只有 Markdown、`.gitignore` 和 `.obsidian` 本地文档编辑器配置，没有业务代码、包文件、构建产物或样例数据。
- 当前 52 份 Markdown 全部成功读取。
- 所有相对 Markdown 链接检查通过。
- 代码围栏全部成对。
- 16 个 JSON 合同示例全部可解析。
- 35 个 Mermaid 图块均有完整围栏。
- 正式文档未发现 API Key、Bearer 凭据、私钥正文、生产路径或环境 Secret 赋值。

### 3.2 交叉一致性

以下易发生歧义的语义已核对一致：

- `uncertain` Command 经新的只读 reconcile 证明已应用时转 `succeeded`；证明未应用时转 `closed_not_applied`，父 Run 转 `failed` 并记录 `effectState=not_applied`；原命令不得重放。
- Artifact 状态为 `receiving → quarantined → available/rejected → expired → deleted`；派生物是新 Artifact，只通过 `derivedFrom` 关联，不使用 `derived` 状态。
- Transport 切换统一阻断非终态 mutation、未解决 `uncertain`、Connector Artifact 上传、状态未知，以及无法安全结束的只读任务。
- Mermaid 图中的 TitleCase 是显示标签；合同值统一使用小写 snake_case。
- Remote 是 Connector Transport，不是第二套在线产品或第二套业务状态机。
- Remote Connector 在线升级是分层供应链：Operation Module 为默认单元，Core 低频 A/B；更新失败恢复 previous 且不切换 Local。
- 首批开发顺序统一为录制 → 删除元素 → 删除聊天记录 → 新建与关联；功能树仍按业务信息架构排序，新建与关联保留为第四阶段的四 Plane 综合验收。
- Feature 实现与文档是同一发布事实：每个 capability 的四 Plane 映射必须与 action/schema/migration/operation/test ID 双向一致；Feature Registry 与 Documentation Registry 从单一 activation record 投影同版本 active/previous。
- Agent Managed Content 采用双层事实：最后完整验证 snapshot 供 Phase 2 按 maxAge/watermark 使用，不可变 revision/change 负责来源、修改、删除和恢复；Omnia 仍是危险操作的实时外部权威。

### 3.3 架构判断

本方案正确解决了 v4 的主要时间成本根因：

1. 不把源码目录或 registry 冒充部署隔离；
2. 不继续扩大巨型 Server、Gateway、Runtime 和全局前端脚本；
3. 不让功能模块直连数据库、Secret 或 Connector；
4. 不用任意 HTTP 代理实现“Connector 无需修改”；
5. 不把模板主文件作为某次 Run 的可写成果；
6. 不把缺失资料、历史快照、AI 输出或前端状态冒充已验证事实；
7. 保留 v4 在真实写入、`uncertain`、身份冻结、读回验证和签名发布方面的安全经验。

### 3.4 独立 xhigh 审查处置

独立 Agent 完整读取当时的 48 份既有 Markdown，形成[独立技术可行性与架构审查](INDEPENDENT_FEASIBILITY_ARCHITECTURE_REVIEW.md)。主 Agent 逐项复核后确认：0 个 P0 判断成立；13 个 P1 与 4 个 P2 均有有效证据，但关闭方式不同，不能把未来原型或用户决定伪装成已经解决。

| 发现 | 主 Agent 结论 | 本轮处置 | 剩余门禁 |
|---|---|---|---|
| P1-01 阶段门禁/Baseline 大爆炸 | 成立 | 新增阶段 0.5 D5 conformance spikes；正式 Stage 1 必须在 D6 和用户批准后，且拆为 1A/1B | D5 真实原型 + 用户批准 |
| P1-02 Core 准入规则 | 成立 | 增加 Core admission rule、owner/合同/故障预算和业务 ID/import 自动边界 | runtime 架构冻结 |
| P1-03 Windows Worker/UI 强隔离 | 成立 | 保留为 D5 原型和 Accepted ADR 门禁；未把“独立进程”写成已证明安全 | sandbox/UI 攻击原型 |
| P1-04 跨资源“原子安装”过强 | 成立 | 改为 crash-safe staged install + journal + 单一 activation record；逐阶段故障注入 | installer/Store 原型 |
| P1-05 freshness 无时间上界 | 成立 | `verified_current` 改为查询时判定；新增 maxAge/asOf、authority revision/watermark 与失效事件 | 域 freshness policy/原型 |
| P1-06 field-level partial 合成不存在状态 | 成立 | 首版仅 whole-object/whole-relation 推进；字段级 current 禁止，未来需 major contract | 并发漂移测试 |
| P1-07 外部身份/租户/ID 重生 | 成立 | 冻结 authority/tenant/Pack/Workspace/type/externalId canonical key 与 transition 规则 | 真实 Omnia identity 验证 |
| P1-08 effect/Evidence/projection 边界 | 成立 | 定义 projection pending 的非成功 Run、repair key/lease/dead-letter/扫描 | Store 故障原型 |
| P1-09 跨 Store/Artifact 备份一致点 | 成立 | 增加全局 backup epoch/barrier、participant checkpoint、引用闭包和 restore reconcile | RPO/RTO + 真实恢复演练 |
| P1-10 录制不能替代平台渐进验证 | 成立 | 保持用户可见开发顺序不变；录制前增加不可交付 conformance kit | Bridge/Artifact/隐私 DoR |
| P1-11 revoked pinned version | 成立 | 增加撤销严重度、历史可读≠可执行、TTL 离线失败关闭和安全 reconcile 兼容 | 更新/撤销原型 + rollout 决定 |
| P1-12 保留/配额/删除/RPO/RTO | 成立 | 建立统一 retention class、引用图、GC/低磁盘/备份传播原则 | 用户数据治理决定 + 容量原型 |
| P1-13 Pack Sync 分页/离线授权 | 成立且只影响 Proposed 范围 | 增加一致性 token 优先、non-atomic observation 和 Session 不可用默认隐藏详情 | 用户是否接受 Pack Sync；接受后 ADR/原型 |
| P2-01 文档映射语义不能全自动证明 | 成立 | 保留人工架构/安全复核为高风险发布门禁 | installer/conformance 实现测试 |
| P2-02 模板状态词汇 | 成立 | 统一 `draft|review|published|superseded|revoked`，validation 独立；发布者收敛为用户或持有单次精确授权的 Codex | 每个模板的来源/许可/授权 Evidence |
| P2-03 ID namespace/转移 | 成立 | 增加 publisher-scoped ID、联合转移、alias/tombstone 和禁止重用 | 供应链 ADR |
| P2-04 删除 UX 状态漂移 | 成立 | 依据用户明确要求更新为 Accepted Product Direction / User Confirmed | 删除 Feature DoR |

结论不是“17 个问题已经全部完成”，而是：文档可修的歧义已修；不能由文档证明的 P1 仍被显式保留为 D5 原型、用户决定或实现测试门禁。

## 4. 尚未关闭的风险

以下不是文档遗漏，而是开发前必须关闭的设计/产品决策：

| 风险 | 当前状态 | 关闭方式 |
|---|---|---|
| Windows Worker/Parser/Operation 与 Feature UI renderer/view 的强隔离技术 | Proposed | 进程/DOM/CSS/Bridge/资源攻击原型和 ADR-0007 |
| Core runtime、服务拆分与 admission rule 的可执行边界 | 文档规则已补齐 / 技术 Proposed | runtime/IPC spike、owner/故障预算和 import/合同边界测试 |
| Core DB 与 Module Store 的物理实现/并发 | Proposed | 代表性负载、备份/迁移原型和 ADR-0006 |
| 安装 journal、activation record 与 previous-readable 数据兼容 | 文档规则已补齐 / 技术 Proposed | 逐阶段断电/崩溃/磁盘满恢复原型和 installer/storage ADR |
| Managed Content freshness/authority identity/projection repair | 合同已补齐 / 外部能力待验证 | 真实 identity/watermark、并发漂移、磁盘满、重复 repair 和 Phase 2 查询原型 |
| 全局 backup epoch/barrier 与引用闭包 | 文档规则已补齐 / NFR 待定 | 多 Store/Artifact 真实 restore rehearsal，用户冻结 RPO/RTO |
| Documentation Store 物理布局与安全 Markdown renderer | Proposed | 纳入存储和 sandbox 原型；验证内容寻址、配额/保留、路径隔离、CSP/HTML/外链攻击与备份恢复 |
| Shell/Core runtime 与 IPC | Proposed | Windows 基线、性能/安全原型和 ADR-0005 |
| Remote Bridge 身份、端到端保护、TTL 和 SLA | Proposed | 使用范围已经确认；仍需威胁模型、部署/断网原型和新的技术 ADR |
| Remote 撤销分发 TTL 与安全版本 reconcile | 合同规则已补齐 / 技术 Proposed | 旧版本 pinning、各撤销严重度、离线和 trust-root compromise 原型 |
| 录制首切片环境与采集边界 | 产品与证据来源 Accepted / 技术待冻结 | 详细采集沿用 v4；以固定 v4 evidence baseline 生成候选 capture policy，无需专用 Pack；首次已有非生产页面复核和数值仍属 Feature DoR |
| 删除元素首批 capability 与安全 canary | 证据来源 Accepted / 技术待冻结 | 从 v4 当前源码、完整录制、测试和写后证据生成候选矩阵；无需专用 Pack，使用届时已有非生产环境做最小 canary |
| 删除聊天记录的数据生命周期 | Accepted | 正文立即物理删除、无引用聊天附件清理、必要业务/Evidence 分离保留；见 ADR-0015 |
| 新建与关联 canary 环境与治理 | 待用户确认 | 指定非生产 Workspace、模板版本、测试对象、owner、保留与清理 |
| 新建与关联默认文档未准备 | Pending / 第四 Feature DoR blocker | 完成默认文档准备项目；不得使用 v4、示例或临时文件替代正式 TemplateVersion |
| Managed Content 域 Schema 与 Phase 2 精确字段 | Pending / 第四 Feature DoR blocker | 与默认文档项目一起冻结 RAIT、Factors Considered、DB 有效 RAIT、GRA/关系、provenance 和 consumer schema；通用登记合同已 Accepted |
| Pack Registry、轻/重抓取与 observation 新鲜度 | Accepted 方向 / 技术待验证 | ADR-0025 已冻结 authority、scope 和 Sync 降级；D5 验证 Section identity、non-atomic pagination、权限撤销和容量 |
| 模板来源/许可 | 每个模板 DoR | 发布者已确定为用户或持有单次精确授权的 Codex；每个 TemplateVersion 仍逐份证明来源/许可 |
| NFR/资源数值 | 待基准测试 | 用安全更新期 Win11、受支持 LTSC/有效 ESU Win10 普通 ThinkPad、代表性文件和网络冻结 |

Nova 精确协议已按用户决定延后：它不是首批开发的阻塞项，也不能在未通过真实连接测试前作为“已支持”能力出现在产品中。

特别提醒：Operation Module 虽然解决了 Connector Core 的结构稳定性，但仍然是高权限供应链边界。后续不能把 v4 Gateway 的巨型业务代码简单搬进一个新的 Operation 包；每个包仍须按 operation、effect、endpoint、资源和数据范围拆小并独立验收。

### 4.1 最新决策的独立 xhigh 复核

第二个独立 xhigh Agent 对 ADR-0025～0027、Remote 自动更新、详细录制、模板发布、v4 零迁移和 Windows 范围做了只读复核。结论为“方向可行、无 P0”；其 6 项 P1 已由主 Agent 在本轮修订：

| 发现 | 主验收处置 |
|---|---|
| Workspace 合同缺父子映射与硬容量预算 | `omnia.workspace-read/v1` 增加 sections/workspaces 的 `parentSectionId`、访问状态、capability，以及 maxWorkspaces/Objects/Relations/Pages/Bytes/Duration；预算取签名 capability/平台/请求最小值 |
| 历史 observation 缺展示授权 | 增加 principal、accessCheckedAt/revision、authorization Evidence；当前 Session 无法证明访问时只显示脱敏 Pack 历史 |
| 删除便携根不会清理外部 Secret/Remote/服务 | 增加 instanceId、externalResourceInventory、租约和产品根外 Windows 保护的 PendingRevocationCapsule；直接删除文件夹不等于彻底删除 |
| Windows 10 无条件支持不安全 | Win10 限仍受支持 LTSC 或有效 ESU/补丁达标 22H2；Win11 需在安全更新期，否则阻止 Remote/录制/敏感 Artifact/mutation |
| Codex 模板发布缺可执行授权 | 新增单次、精确 digest、可撤销/防重放的发布授权合同和 ADR-0029；拒绝后进入不可复用 `rejected`，Codex 不持有用户长期签名私钥 |
| 详细录制隐私门禁不足 | 增加 host/path/method/content-type/body-field 正向白名单、每 Run 硬预算、落盘前源头净化、二层扫描/quarantine、实例 DEK 静态保护和导出/清理门禁 |

评审另指出 Accepted ADR 不应实质原地改写。Remote 默认 rollout 因此独立记录为 [ADR-0028](../adr/0028-remote-automatic-safe-window-rollout.md)，只 supersede ADR-0019 的未决 Decision 12；并补充安全更新的 new-run 截止和最大 drain 策略。历史独立评审文件已标记为 superseded snapshot，旧的 “Pack Sync Proposed” 文字不再代表当前状态。

## 5. 开发前仍需关闭的评审与技术门禁

按影响优先级建议依次确认：

1. **是否批准 D5 有界技术原型**：只批准逐项 conformance spike，不批准正式 Shell 或业务 Feature；每项先写唯一问题、fixture、阈值、失败退出和 ADR 回填。
2. **目标环境与原型范围**：Windows 基线；runtime/IPC、Store/outbox/backup、installer/activation、Worker/UI sandbox、Remote Bridge、大文件/TTL、在线更新撤销和容量原型。
3. **D5 数据/设备原型范围**：稳定 data 根、配额/低磁盘、checkpoint/导出、恢复演练，以及安全更新期 Win11、受支持 LTSC/有效 ESU Win10 的普通 ThinkPad 基准；产品边界已经 Accepted。
4. **录制首切片准入**：按 ADR-0030 固定 v4 evidence baseline，生成 capture allowlist 候选；用届时已有非生产页面完成当前字段、完整性、脱敏和 Local/Remote 复核，不要求用户准备专用 Pack。
5. **删除元素首批准入**：按 ADR-0030 对 v4 对象/关系证据分级，生成最窄 capability matrix；用届时已有非生产 Workspace 完成最小 canary，不固定 TEST/TEST-Auto 名称或旧对象。
6. **Workspace 读取原型**：验证真实 Section/父级 identity、轻抓取延迟、重抓取分页/取消/cursor/watermark 和 Local/Remote parity；不再讨论名称推断或首次强制 Sync。
7. **新建与关联默认文档、Managed Content Schema 与 canary 环境（P-12/P-17）**：先提供/认可候选默认文档并完成来源、许可、默认规则、RAIT/Factors/关系的 Phase 2 字段合同、保护区域、Validator 和发布，再确定非生产 Workspace、测试命名、业务 owner、保留和清理责任。

## 6. 最终验收结论

文档包已经达到“可以继续用户决策并申请 D5 有界技术原型”的标准，并为后续正式工程建立了 DoR、DoD、依赖、状态、安全、恢复和发布边界。

首批四个 Feature、开发顺序“录制 → 删除元素 → 删除聊天记录 → 新建与关联”、Shell-first 独立包、四 Plane 文档随包交付、后台保存 Agent 管理内容、三列聊天、二/三级混合菜单、Remote 面向全部版本和 Remote Connector 分层在线升级均保持 Accepted。独立审查指出的阶段大爆炸、Core 准入、过强原子语义、Managed Content freshness/partial/identity/repair、全局备份、录制验证耦合、撤销策略、数据治理、Pack 分页/离线授权和文档状态问题已由主 Agent 逐项处置；文档可修项已修，技术可行性项仍明确保留为原型门禁。

Workspace 权威轻/重抓取和 Sync 降级已 Accepted，但具体 API、分页、一致性和容量仍须 D5 证明；它不授权开始开发。删除/录制已确认使用 v4 evidence baseline 和既有测试方法，不要求专用 Pack，但当前环境最小复核仍是正式开放门禁。删除聊天记录产品语义与删除元素 UX 已关闭。新建与关联仍是第四项综合验收，其默认文档和精确域 Schema 是 Pending DoR blocker。Nova 精确协议延后且不阻塞首批范围。

当前判定：

- 文档收敛与用户评审：**Go**；
- D5 不可交付、有界、无用户入口的技术原型：**Conditional Go，仅在用户明确批准原型范围后**；
- 正式 Shell Baseline：**No-Go**，直到 D5 证据回填 Accepted ADR、D6 再审通过且用户批准开发；
- 录制、删除元素、删除聊天记录、新建与关联及 Workspace 读取实现：**No-Go**，各自 D5/技术 DoR 尚未完成，且新建与关联的 P-12/P-17 尚未关闭。

在取得 D5 批准前继续保持纯文档工作区，不创建应用脚手架、数据库、服务、业务 UI、Feature 或 Connector 实现。
