# Omnia Agent v5 独立技术可行性与架构审查

状态：Historical Review / Decision Status Superseded  
审查日期：2026-07-30  
审查输入快照：主 Agent 修订前的全部 48 份既有 Markdown；不包含实现、脚手架、配置、数据库或原型代码  
判定基线：真实后端、真实数据、真实状态闭环；不允许 mock、sample 或 hardcoded 业务结果冒充功能

> 本文保留独立 Agent 提交时的原始发现和当时行号，作为修订前审查证据；后续文档已发生行号漂移。逐项证据复核、修订和剩余门禁以[主 Agent 开发前文档验收](ARCHITECTURE_REVIEW.md)的“独立 xhigh 审查处置”为准。
>
> **状态覆盖说明**：本文所有“Pack Sync 仍为 Proposed/未接受”、Remote 默认更新策略、包来源、数据/模板发布者和 v4 迁移待用户决定的表述，均只代表本次历史审查快照，不是当前状态。当前决定以 [ADR-0025](../adr/0025-authoritative-light-heavy-workspace-reads.md)、[ADR-0026](../adr/0026-official-signed-package-supply-chain.md)、[ADR-0027](../adr/0027-portable-data-root-and-update-boundary.md)、[ADR-0028](../adr/0028-remote-automatic-safe-window-rollout.md)和 [ADR-0029](../adr/0029-user-or-authorized-codex-template-publication.md)为准；Sync 已降级为可选优化，轻/重抓取方向已 Accepted。
>
> **2026-08-01 覆盖**：本文的统一开发 Go/No-Go、Windows 强隔离认证、OS 生命周期/补丁阻断和人工 hash 要求也不再是当前门槛。按 [ADR-0031](../adr/0031-fast-local-feature-iteration-and-automated-integrity.md)，开发完成即可自动打包并装入便携根测试；真实能力仍按实际 Worker、数据和 Connector 依赖判定。

## 1. 执行结论

**总体结论：有条件可行，但当前尚未达到业务 Feature 开发的 Go 条件。**

v5 的目标在技术上能够实现，不过其真实体量不是普通 Electron 桌面重构，而是以下系统的组合：

- 本地微内核与独立扩展宿主；
- 每 Feature 独立进程、UI、Store、版本、迁移和发布生命周期；
- Local/Remote 共合同的受控 Connector 与分布式 mutation 状态机；
- 签名包、供应链、候选发布、回滚和文档同步系统；
- Agent Managed Content 的 current projection、不可变 ledger、tombstone、Evidence 和跨 Feature 查询平台；
- 长期运行、隐私、备份恢复、真实 Omnia canary 与 Windows 强隔离体系。

架构方向具有内在一致性：后台是事实源、危险 mutation 写后读回、`uncertain` 不自动重试、Local/Remote 不静默 fallback、Feature 不跨库和跨进程私接、未安装能力不展示入口，这些都明显降低了“界面可点但系统不真实”的风险。

当前没有发现必须推翻产品方向的 P0 问题。发现 **0 个 P0、13 个 P1、4 个 P2**。P1 主要不是“技术做不到”，而是当前合同或阶段门禁不足以防止实现阶段产生不可恢复歧义。

### 1.1 Go / No-Go

| 对象 | 结论 | 解释 |
|---|---|---|
| 继续文档收敛 | **Go** | 应先关闭本报告列出的文档级 P1，并把用户决定与技术原型入口条件写成单一门禁。 |
| D5 有界技术原型 | **Conditional Go** | 用户批准明确的原型范围后，可以验证 runtime/IPC、Store、sandbox、Bridge、更新和恢复；必须是不可交付、非用户可见的技术实验，测试 fixture 不得冒充产品数据。 |
| “Shell Baseline 原型”作为完整 Stage 1 交付 | **No-Go（当前）** | 当前 Baseline 一次包含过多平台子系统，而 D5/D6 尚未开始，runtime、Store、sandbox、Bridge 等 ADR 尚未冻结。 |
| Shell Baseline 的架构/原型计划 | **Go** | 可以立即形成有界 spike、判定阈值、失败退出和 ADR 回填计划，但不能据此宣称 Baseline 已开始实现。 |
| Shell Baseline 正式实现 | **No-Go（当前）** | 至少应先通过关键 D5 原型、关闭本报告 P1-01 至 P1-10，并由用户批准进入工程阶段。 |
| 首批业务 Feature 开发 | **No-Go** | 录制的 Remote/E2E/大文件/TTL/capture/retention 门禁未冻结；删除和新建也分别受数据生命周期、模板与 canary 决定阻塞。 |
| Pack Sync / 快照缓存开发 | **No-Go** | 它仍是 Proposed / For User Review，不是 Accepted 决定，也不授权开发。 |

这与现有路线图自身的 D6 清单一致：sandbox/Bridge 原型、包回滚、四 Plane 文档、Managed Content、数据迁移/NFR、第二次审查和用户批准均尚未完成（[DOCUMENTATION_AND_DESIGN_ROADMAP](../planning/DOCUMENTATION_AND_DESIGN_ROADMAP.md)，L122–136）。

## 2. 决定状态边界

### 2.1 已接受的产品与架构决定

以下决定可以继续作为不可静默偏离的约束：

- 单一 Local 桌面产品；Remote 是 Connector Transport，面向全部版本，但安全门禁未满足时禁用；
- 三列 Shell、第三列保留聊天、最多三级 Feature 树、统一全局缩放和可调整分区；
- 四 Plane、每 Feature 独立 Worker/版本/数据 owner、后台为 system of record；
- Connector Core 只负责 Transport/Session/Gate，业务能力由受限 Operation Module 提供；
- 单一 ConnectorTransport、单 active lease、Local/Remote 语义一致、mutation `uncertain` 不自动重试；
- Remote Connector 在线升级，优先升级 Operation Module，Core 仅在必要时升级；
- 先交付不内置业务 Feature 的真实 Shell Baseline，再按“录制 → 删除元素 → 删除聊天记录 → 新建与关联”逐包验收；
- Feature 实现文档与包同版本、同签名、同发布单元；
- Managed Content 保存已验证 current projection 与不可变 revision/change/tombstone，Omnia 仍是外部事实权威；
- 未有真实后端、真实数据或真实状态逻辑的前端入口不开放。

证据见 [SYSTEM_ARCHITECTURE](../architecture/SYSTEM_ARCHITECTURE.md) L9–26、[ADR 索引](../adr/README.md) L18–36、[PRODUCT_REQUIREMENTS](../product/PRODUCT_REQUIREMENTS.md) L28、L81–93、L207–209。

### 2.2 仍是 Proposed 的实现设计

以下内容不得在开发计划、预算或验收中写成已经冻结：

- Electron/React/TypeScript Shell、Node/TypeScript Core/Worker、SQLite 物理布局、内容寻址 Artifact、具体 IPC/RPC、OpenTelemetry；
- Windows Worker/Parser/Operation sandbox、Feature UI renderer/view 隔离的具体技术；
- Core DB 与每 Feature Store 是独立文件还是强 owner namespace，以及加密、WAL、备份方式；
- Remote Bridge 身份、部署、E2E、TTL、SLA、大文件续传和更新通道；
- NFR、资源阈值、RPO/RTO、保留期、配额和清理策略；
- Pack Sync、Pack Registry、Workspace Snapshot Cache 及其 UI。

证据见 [SYSTEM_ARCHITECTURE](../architecture/SYSTEM_ARCHITECTURE.md) L27–35、[OPEN_DECISIONS_GUIDE](OPEN_DECISIONS_GUIDE.md) L263–289、[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md) L20、L151、L233、[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md) L3–5。

### 2.3 仍需用户确认或批准

至少包括：

- 录制、删除、新建的真实非生产 canary 环境和清理 owner；
- Remote Connector 默认在线更新策略；
- 生产包来源、信任根、离线导入和是否允许第三方发布；
- 删除聊天记录的数据生命周期与“删除”承诺；
- 模板 owner、许可、默认文档及唯一兼容 `TemplateVersion`；
- v4 导入范围、数据保留、导出、备份、RPO/RTO、加密和目标 Windows/NFR；
- Bridge 部署与运维责任；
- Pack Sync 是否进入范围，以及初次连接、跳过 Sync、离线缓存可见性、容量与删除策略。

证据见 [docs/README](../README.md) L137–142、[PRODUCT_REQUIREMENTS](../product/PRODUCT_REQUIREMENTS.md) L338–350、[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md) L228–257。

## 3. 可行性矩阵

| 领域 | 可行性 | 当前成熟度 | 主要成本/风险 | 开发前必需关闭 |
|---|---|---|---|---|
| 四 Plane 与依赖方向 | 高 | Accepted direction | 接口数量和跨 Plane 追踪成本 | 冻结 runtime/IPC 与 capability 合同生成规则 |
| 微内核与 Core 边界 | 中高 | 边界原则清楚，服务面偏大 | Core 演化成平台单体 | Core admission rule、独立服务边界、容量/故障预算 |
| Feature Worker 隔离 | 中 | 行为约束清楚，技术未选 | Windows 同用户进程未必形成安全边界 | 受限 token/AppContainer/Job/ACL/默认禁网攻击原型 |
| Feature UI 隔离 | 中 | 行为约束清楚，技术未选 | Electron view/partition/CSP/Bridge 逃逸与资源 DoS | renderer/view 攻击与回收原型 |
| 独立 Feature 包 | 中高 | 生命周期设计较完整 | 供应链、兼容矩阵、迁移与回滚组合爆炸 | crash-safe 安装 journal、信任根、兼容与回滚 ADR |
| Feature 文档随包 | 高 | ADR-0023 Accepted，合同较完整 | 存储/索引/审核成本；机器校验不能证明语义真实 | 原子激活边界、符号/合同目录、保留与修复流程 |
| Connector Core / Operation | 高 | 职责清楚 | 签名模块和 capability 演化成本 | SDK/ABI、版本解析、撤销与回收规则 |
| Local/Remote 等价 | 中 | 合同方向清楚 | Bridge 服务、E2E、断线、大文件、真实双路径测试 | Bridge ADR 与实链路故障原型 |
| Remote 在线升级 | 中 | ADR-0019 Accepted direction | Supervisor、发布服务、A/B 槽、撤销、长期维护 | 撤销严重度、旧版 pinning、恢复兼容和 rollout policy |
| Managed Content | 中高 | ADR-0024 Accepted direction，详细设计较强 | 双写恢复、Schema 演化、漂移和长期 ledger 成本 | freshness、partial、identity、outbox/repair 语义 |
| 全局备份/恢复 | 中 | 有清单，无全局一致性协议 | 多 Store + Artifact + 外部 effect 的一致点 | backup epoch/barrier、引用闭包、restore rehearsal |
| Pack Sync | 中高 | **Proposed only** | 枚举容量、快照一致性、隐私、离线授权 | 用户接受后新 ADR；分页一致性和 fail-closed 离线策略 |
| 首批 Feature 顺序 | 中 | 顺序 Accepted，DoR 未满足 | 第一项录制同时引入最多远端/二进制/隐私问题 | 先做非产品 conformance spikes；关闭录制 DoR |
| v4 迁移 | 中高 | 分阶段原则合理 | 数据污染、身份冲突、未知 schema、回滚 | 用户逐类批准 importer，真实迁移/恢复演练 |

## 4. 分级发现

### P0

未发现需要立即推翻 Accepted 架构方向、会在任何合理实现下必然导致数据损坏或安全失守的 P0 问题。

“未发现 P0”不表示可以开始业务开发；以下 P1 是进入工程阶段前必须关闭或明确排除的条件。

### P1-01：阶段门禁与 Shell Baseline 范围存在“先建平台、后做原型”的冲突

**证据**

- D5 技术原型和 D6 第二次验收均为 Not Started；D6 明确要求 sandbox/Bridge 原型、包回滚、Managed Content 和用户批准（[DOCUMENTATION_AND_DESIGN_ROADMAP](../planning/DOCUMENTATION_AND_DESIGN_ROADMAP.md)，L23–33、L107–136）。
- Migration Stage 1 只要求 Stage 0 文档门槛通过，却要求一次实现 Shell/Core、多个 Registry、Store/Broker、进程隔离、包验证和 test harness（[MIGRATION_ROADMAP](../migration/MIGRATION_ROADMAP.md)，L87–105）。
- Shell Baseline 的规范还包括 Documentation Registry、Managed Content Registry、公共合同、状态持久化、健康与隔离（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L292–305）。

**为什么是问题**

Stage 1 当前像一个平台“大爆炸”里程碑。runtime、IPC、Store、sandbox、Bridge 等尚未经过 D5，若直接进入 Baseline 实现，失败会同时落在多个未冻结边界，无法判断根因，也会使 Proposed 选型因代码既成事实而被动 Accepted。

**可能失败场景**

团队先按 SQLite 多文件、某种 Electron view 和 loopback IPC 搭出 Baseline；随后 sandbox 或备份原型证明该组合不能满足隔离/一致性要求，但 Registry、迁移和包生命周期已绑定这些假设，产生大规模返工。

**建议**

1. 在 Stage 0 与正式 Stage 1 之间增加“P0 Platform Spikes”阶段；
2. 每个 spike 只回答一个无法靠文档证明的问题，并有数值阈值、失败退出和 ADR 回填；
3. 把 Shell Baseline 拆成“最小内核激活”与“平台服务逐项加入”，每项有独立 DoR/DoD；
4. Stage 1 的进入门槛引用 D5 通过证据和本报告 P1 关闭清单。

**关闭类型**：文档阻塞项；随后由未来原型验证。  
**阻塞范围**：完整 Shell Baseline 正式实现和全部业务 Feature；不阻塞经用户批准的有界 D5 spike。

### P1-02：Core 的功能面过大，缺少“进入微内核”的可执行准入规则

**证据**

- Core 图中同时包含 API/AuthN、Feature Registry、Run Orchestrator、Event、Template、Artifact、AI、Command、Transport、Module、Documentation、Managed Content 和 Audit/Evidence（[SYSTEM_ARCHITECTURE](../architecture/SYSTEM_ARCHITECTURE.md)，L103–137）。
- Shell Baseline 要求这些平台能力在没有业务 Feature 时均为真实可运行状态（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L292–305）。
- 文档只规定“Core 组件只实现跨功能通用机制”，但没有服务晋升、拆分或拒收业务能力的量化规则（[SYSTEM_ARCHITECTURE](../architecture/SYSTEM_ARCHITECTURE.md)，L137）。

**为什么是问题**

“跨功能通用”仍可被用来为任何共享需求辩护。Core 既承担编排、数据、包、文档、AI、Connector 和审计，又是所有 Feature 的必经点，容易从微内核变成高耦合平台单体，升级任何服务都扩大故障域。

**可能失败场景**

Phase 2 需要新的 RAIT 查询和 Pack 快照；实现者以“多个 Feature 复用”为由把域判断加入 Orchestrator/Managed Registry。以后 Feature 独立升级仍被 Core 发布节奏锁住，违背独立部署目标。

**建议**

- 增加 Core admission rule：只有身份、授权、生命周期、调度、版本路由和通用持久化协议可进内核；
- 每个 Core service 定义 owner、公开合同、数据 owner、故障域、资源预算和可独立演化边界；
- “被两个 Feature 使用”不能成为进入 Core 的充分条件；域语义应进入版本化公共域服务或包；
- 为 Core 设禁止业务 enum/operation ID/import 的自动边界测试。

**关闭类型**：文档阻塞项。  
**阻塞范围**：Shell Baseline 架构冻结。

### P1-03：进程隔离与 UI 隔离的行为目标正确，但 Windows 上的强制边界尚未证明

**证据**

- Worker 仅确定独立进程和受限工作目录，具体 Windows sandbox 为 Proposed（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L194）。
- Feature UI 要求隔离 DOM/CSS/store/Node/文件/网络/存储，并可单独终止，但具体 renderer/view 技术待原型（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L206–218）。
- 开放决策已明确“单独进程不等于安全隔离”（[OPEN_DECISIONS_GUIDE](OPEN_DECISIONS_GUIDE.md)，L273–275）。
- 安全文档将越权文件、网络、子进程和 UI Bridge 攻击列为必须测试的边界（[SECURITY_RELIABILITY_TESTING](../operations/SECURITY_RELIABILITY_TESTING.md)，L52–86、L205–220）。

**为什么是问题**

同一 Windows 用户下的普通子进程通常仍能读取用户可读文件、连接网络或干扰同权限进程。Electron 的 `contextIsolation`、partition 或独立 renderer 也不自动提供资源、导航、浏览器存储和消息授权隔离。

**可能失败场景**

一个签名但被攻陷的 Feature parser 读取其他 Feature Store 或用户凭据；一个 UI bundle 通过错误 Bridge origin/replay 触发另一 Feature action，或通过内存/事件循环耗尽拖垮 Shell。

**建议**

- 先决定信任模型：仅官方包、管理员导入包、第三方包分别允许什么；
- 原型比较 restricted token、AppContainer、Job Object、ACL 临时目录、brokered I/O 和默认禁网；
- UI 原型验证独立 origin/partition、CSP、无 Node、严格 Bridge schema/时序、下载/导航拒绝和资源强制回收；
- 不满足攻击用例时，第三方包不得进入可执行面，只能使用 Shell 解释的声明式 view。

**关闭类型**：未来原型阻塞项，并需 Proposed ADR 转为 Accepted。  
**阻塞范围**：Shell Baseline 正式实现、任何可执行 Feature 包和第三方包政策。

### P1-04：包、文档、指针与数据迁移的“原子发布”边界描述过强

**证据**

- ADR-0023 要求 Feature Registry 与 Documentation Registry 在同一安装事务切换 active/previous/candidate（[ADR-0023](../adr/0023-feature-documentation-bundle.md)，L45–50）。
- 合同要求 Package Manager 以单一事务提交 Feature 与文档版本指针（[CONTRACTS](../contracts/CONTRACTS.md)，L776–795）。
- 实际安装还包括文件复制、文档 staging、私有 Store checkpoint/migration、Worker 启动、drain、指针切换、probation 和数据可读回滚（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L339–355）。
- Core DB/Module Store 的物理布局仍是 Proposed（[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md)，L20）。

**为什么是问题**

文件系统、两个 Registry、模块私有 Store、进程启动和外部签名验证不可能靠一个普通数据库事务全部原子提交。真正可保证的通常是“已完整 staged 的不可变版本的激活指针原子切换”，而不是整个安装过程原子。

**可能失败场景**

模块 migration 已提交、文档已复制，但进程在 active 指针切换前崩溃；重启后 candidate 数据只兼容新代码，active 仍是旧代码。系统若把这称为事务回滚，会启动不可读状态或丢失恢复线索。

**建议**

- 将术语改为“crash-safe staged install + atomic activation record”；
- 定义持久 install journal：`discovered → verified → staged → migrated/checkpointed → health_passed → activated → probation → promoted|rolled_back|manual_recovery`；
- 写明哪些资源是同一数据库事务，哪些使用幂等补偿/恢复扫描；
- 在 activation record 中绑定 package/docs/schema/dataCompatibility/checkpoint digest；
- 用每个步骤断电/进程终止故障注入证明恢复。

**关闭类型**：文档阻塞项 + 未来 Store/installer 原型。  
**阻塞范围**：Package Manager、Documentation Registry 和独立升级/回滚实现。

### P1-05：Managed Content 的 `verified_current` 没有时间上界或权威 revision

**证据**

- `ManagedObject` 保存 `lastVerifiedAt` 和 `freshness=verified_current|stale|unknown`（[CONTRACTS](../contracts/CONTRACTS.md)，L801–818）。
- 查询只声明 `minimumFreshness=verified_current|allow_stale`，不包含 `maxAge`、`asOf` 或 authority watermark（[CONTRACTS](../contracts/CONTRACTS.md)，L873–886）。
- 设计规定 Omnia 是外部权威，外部修改应记录 drift，但没有定义何时主动把未重新读取的数据从 `verified_current` 降级（[ADR-0024](../adr/0024-agent-managed-content-registry.md)，L37–44；[AGENT_MANAGED_CONTENT_REGISTRY](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)，L158–170）。

**为什么是问题**

“上次读回时验证过”不等于“现在仍是当前事实”。如果没有 TTL、调用方最大年龄或 Omnia revision/token，一条记录可能无限期保持 `verified_current`，直到偶然发现漂移。

**可能失败场景**

Phase 2 请求 `verified_current` 的 RAIT。对象一周前由 Agent 读回，后来在 Omnia 被人工修改；本地没有 unresolved change，查询仍返回“已验证当前”，下游基于陈旧 RAIT 生成决策。

**建议**

- 将语义拆为 `last_verified_snapshot` 与消费时 freshness 判定；
- 查询增加 `maxAge`/`asOf`，若 Omnia 支持则保存 authority revision/ETag/watermark；
- 在 Session、capability、schema、访问权或 Pack/Workspace 身份变化时失效；
- 对安全或 mutation 计划始终要求实时 Connector 读取，不能仅靠 Registry 状态；
- 为不同实体类型定义由域 owner 决定的 freshness policy，Core 不硬编码业务时长。

**关闭类型**：合同与数据设计文档阻塞项。  
**阻塞范围**：Managed Content Service 和任何 Phase 2 消费；不阻塞只验证存储机制的有界 Store spike。

### P1-06：field-level partial 推进可能合成一份从未在 Omnia 同时存在的 current

**证据**

- ADR-0024 允许 partial 只提交已读回证明的“对象/字段/关系”，其余保留旧 current（[ADR-0024](../adr/0024-agent-managed-content-registry.md)，L33–39）。
- 详细设计重复规定 partial 可推进字段（[AGENT_MANAGED_CONTENT_REGISTRY](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)，L140–146）。
- 公共合同又以 `verifiedTargetIds` 表示 partial，并说未证明部分保留旧 current（[CONTRACTS](../contracts/CONTRACTS.md)，L847–871）。

**为什么是问题**

对象 A 字段来自本次读回、B 字段来自上次快照时，合成 payload 可能从未作为一个一致对象存在于 Omnia。`currentStateDigest` 随后会错误暗示这是一次完整权威快照。合同中“字段级”和“target 级”的粒度也不一致。

**可能失败场景**

更新同时改变 RAIT 与 Factors；只读回 RAIT 成功。Registry 把新 RAIT 与旧 Factors 合成新 revision。实际 Omnia 的 Factors 已被另一用户改动，Phase 2 得到一个不存在的组合，并且 provenance 看起来像完整验证。

**建议**

- 默认只在完整读取该实体的全部 required fields 后推进 whole-object current；
- partial 可分别推进独立对象或独立关系，但不得悄悄合成 whole-object snapshot；
- 若确需字段级 current，合同必须改为每字段 revision/provenance/freshness，并证明未读字段未变化；
- `verifiedTargetIds` 明确定义 target 是 object、relation 还是 field path，且 digest 计算纳入粒度。

**关闭类型**：合同与数据设计文档阻塞项。  
**阻塞范围**：Managed Content mutation 投影、Phase 2 查询。

### P1-07：Managed Content 的外部身份唯一性、租户边界与 ID 重生规则未定义

**证据**

- 数据模型有 `logicalKey`、`externalSystem/externalId`、Engagement/Workspace scope，但未声明组合唯一键（[AGENT_MANAGED_CONTENT_REGISTRY](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)，L56–70）。
- 公共合同只把 `externalIdentity` 定义为 `system/id`，scope 为允许的 engagement/workspace 字段（[CONTRACTS](../contracts/CONTRACTS.md)，L801–820）。
- Pack 评估反而单独提出按 environment + immutable Pack ID 识别，说明权威实例维度确实存在（[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md)，L74–97）。

**为什么是问题**

同一个外部 ID 可能在不同 Omnia 环境、租户、Pack、Workspace 或实体类型中重复，也可能在删除后被系统重用。没有 canonical authority instance 和 reincarnation 规则，本地 `managedObjectId` 可能错误合并不同对象。

**可能失败场景**

测试与生产 Omnia 都出现 `externalId=123`；导入或切换 Session 后，Registry 将新对象识别成旧对象并推进旧 ledger，导致 Phase 2 泄露跨环境数据或删除计划引用错误实体。

**建议**

- 冻结 canonical key：`authorityInstanceId/tenantOrOrgId/packId/workspaceId/entityType/externalId`；
- 明确哪些维度可缺省、谁负责规范化、唯一索引和冲突错误；
- 定义 alias/merge、跨 Workspace 移动、外部 ID 复用、删除后重生和 imported history 规则；
- Evidence 和 Session binding 必须携带同一 authority identity，不允许用 display name 参与身份。

**关闭类型**：合同与数据设计文档阻塞项。  
**阻塞范围**：Managed Content、Pack reuse、v4 importer 和真实 canary。

### P1-08：外部 effect、Command/Evidence、Run 与 Managed projection 的本地提交边界不够具体

**证据**

- ADR-0024 正确要求外部 mutation 已验证但投影失败时不重放，而由持久 outbox 从 Evidence 补写（[ADR-0024](../adr/0024-agent-managed-content-registry.md)，L41–45）。
- 详细设计说 revision、current、change 和 outbox 在一个本地事务提交，但外部写与本地 Store 没有分布式事务（[AGENT_MANAGED_CONTENT_REGISTRY](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)，L114–119、L172–180）。
- Store 可能是 Core DB 与多个独立 Module Store；Core outbox 只明确覆盖 Core 状态与事件（[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md)，L20、L171–180）。

**为什么是问题**

尚不清楚 Command、Evidence、Run、Managed change/revision 和 outbox 是否位于同一事务域，也未定义投影恢复期间 Run 的最终状态、重复 projection 的判定和永久失败后的 repair owner。

**可能失败场景**

Omnia 写入和读回成功，Evidence 已保存；Managed Store 提交因磁盘满失败。Run 被标为成功并通知 UI，但 projection 长期 pending。Phase 2 看不到对象；清理磁盘后两个恢复 worker 又并发追加重复 revision。

**建议**

- 画出每个持久事实的 Store owner 与事务边界；
- 冻结 projection key、Evidence immutability、outbox lease、幂等唯一键和重复 digest 规则；
- 定义 `effect_verified_projection_pending` 或等价非成功/恢复状态，以及何时允许 UI 宣称业务成功；
- 增加持久 repair queue、dead-letter、人工修复入口和一致性扫描；
- Store spike 必须覆盖磁盘满、进程崩溃、重复 delivery、Store 损坏和 restore 后重放。

**关闭类型**：文档阻塞项 + 未来 Store 原型。  
**阻塞范围**：Managed Content、真实 mutation Feature、恢复和审计。

### P1-09：备份清单完整，但缺少跨 Store/Artifact 的全局一致性点

**证据**

- 数据层包括 Core、Module Private、Artifact、Secret、Evidence、Documentation 和 Managed Content 等多个 owner（[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md)，L7–20）。
- 备份方案要求在 backup point 阻止新 mutation，并恢复所有 Store 后运行引用检查（[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md)，L203–233）。
- RPO/RTO、频率和保留层级仍为 Proposed（[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md)，L233–249）。

**为什么是问题**

“阻止新 mutation”不等于已经完成全局 quiesce：可能仍有在途远端 effect、Artifact 写入、outbox、模块 migration 或 Documentation candidate。独立 SQLite 文件和内容文件若在不同时间复制，恢复后会形成悬空引用或回到 effect 发生前的本地状态。

**可能失败场景**

备份先复制 Core DB，再复制 Artifact/Managed Store；期间录制 Artifact 完成、Run 更新并发生 outbox 投影。恢复后 Run 指向不存在 Artifact，或 Omnia 已删除对象而本地恢复到 active current。

**建议**

- 定义全局 backup epoch/barrier 与参与者协议；
- 枚举允许在 barrier 时继续的只读任务、必须 drain 的 mutation/candidate/migration 和超时行为；
- backup manifest 保存每个 Store checkpoint、Artifact 引用闭包、active package/docs 版本、authority identity 和未解决 command；
- restore 后 active/uncertain/pending 状态统一进入 reconcile，不直接恢复为成功；
- 以代表性容量做断电和真实 restore rehearsal，再冻结 RPO/RTO。

**关闭类型**：文档阻塞项 + 未来 Store/backup 原型 + 用户 NFR 决定。  
**阻塞范围**：生产数据、正式 Shell Baseline 发布和全部业务 Feature。

### P1-10：首条录制切片同时引入最多未冻结的系统风险，不能替代平台架构的渐进验证

**证据**

- Accepted 顺序把录制放在第一项，并要求它验证真实 Connector/Session、Local/Remote、长运行、Artifact、完整性、隐私和故障恢复（[ADR-0021](../adr/0021-initial-feature-development-order.md)，L23–33）。
- 录制 DoR 仍缺 Remote E2E、大文件续传/TTL、Artifact 配额/时长/大小/保留和 capture allowlist（[RECORDING_FEATURE](../product/RECORDING_FEATURE.md)，L137–175）。
- 四 Plane 的综合验收被放到第四个“新建与关联”（[INITIAL_FEATURE_SCOPE](../product/INITIAL_FEATURE_SCOPE.md)，L194–205）。

**为什么是问题**

录制虽然是 read-mostly 的首个业务切片，却同时绑定 Remote Bridge、流式大文件、隐私采集、长运行恢复、配额和导出。若直接用它证明平台，故障可能来自 Transport、Bridge、Artifact、capture policy 或 Feature runtime，难以隔离；直到第四项才综合验证 mutation/模板/Managed Content 也过晚。

**可能失败场景**

录制 Remote 大文件中断。团队无法判断是 Bridge chunk/ACK、Artifact outbox、Run lease、Worker 背压还是 Connector capture 的问题，随后为了赶通第一项在 Core 中加入录制特例。

**建议**

- 保留用户决定的四个“用户可见 Feature”顺序不变；
- 在它们之前建立非产品、不可安装为业务功能的 architecture conformance kit；
- 分别用人工构造 fixture 验证 IPC 背压/崩溃、Artifact 流、包安装、Local/Remote transport、outbox 和 sandbox；
- 录制只有在其 DoR 全部冻结且同一真实合同的 Local/Remote 链路可用后才进入业务开发；
- conformance kit 只产生测试证据，不创建菜单、统计卡或可点击假入口。

**关闭类型**：开发路线文档阻塞项 + 多个未来原型。  
**阻塞范围**：首个业务 Feature；不改变 Accepted 的用户可见 Feature 顺序。

### P1-11：Remote 在线升级缺少“已固定旧版本被撤销”时的确定规则

**证据**

- ADR-0019 要求包携带撤销信息；Operation Module side-by-side，活动 Run 固定旧版本（[ADR-0019](../adr/0019-remote-connector-online-upgrade.md)，L19–35）。
- Core 激活在 mutation/uncertain/Artifact 上传期间阻断，probation 失败恢复 previous（[CONNECTOR_GATE](../architecture/CONNECTOR_GATE.md)，L279–305）。
- 验收要求篡改、降级、撤销 key 和不兼容合同失败关闭（[ADR-0019](../adr/0019-remote-connector-online-upgrade.md)，L66–71）。

**为什么是问题**

旧 Operation/Core 可能因密钥泄露、严重漏洞或合同错误被撤销，但活动 Run 又要求继续 pin 旧版本。当前文档没有说明不同撤销严重度下是允许 drain、立即停止、进入 uncertain，还是只能只读 reconcile；历史 bytes 是否可保留但禁止执行也未定义。

**可能失败场景**

一个活动 mutation Run 固定到后来被紧急撤销的 Operation Module。Supervisor 继续执行违反安全要求；若立即杀进程，又可能让外部 effect 进入 `uncertain` 且旧版 reconcile 也被禁止。

**建议**

- 定义 revocation severity：不再用于新 Run、停止未提交命令、紧急停用全部执行、仅允许受限 reconcile；
- 分离“历史 payload 可供审计”与“payload 可执行”；
- 为 revoked pinned Run 定义状态迁移、用户提示和安全版本 reconcile compatibility；
- 规定信任根/签名 key 轮换、撤销分发 TTL、离线行为和 Supervisor 最低安全版本；
- 将这些用例加入在线更新故障原型。

**关闭类型**：在线更新合同文档阻塞项 + 未来原型。  
**阻塞范围**：Remote Connector 正式发布和依赖在线升级的业务 Feature。

### P1-12：保留、配额、加密、删除承诺和 RPO/RTO 尚未收敛，系统可能无界增长

**证据**

- Feature 文档会保留多个版本，需要去重、配额和保留策略（[ADR-0023](../adr/0023-feature-documentation-bundle.md)，L53–64）。
- Managed Content tombstone/revision/change 随 Run/Evidence 和引用保留，最终期限待数据治理 ADR（[ADR-0024](../adr/0024-agent-managed-content-registry.md)，L44–45）。
- Artifact、Evidence、模板、日志、Quarantine 等保留策略大多仍待用户确认或 Proposed（[DATA_AND_STORAGE](../data/DATA_AND_STORAGE.md)，L233–249）。
- 录制又会产生大 Artifact，最大时长/大小和保留未定（[RECORDING_FEATURE](../product/RECORDING_FEATURE.md)，L173–175）。

**为什么是问题**

不可变版本、Evidence、录制 Artifact、Managed revisions、未来 Pack snapshots 和备份会叠加增长。未冻结引用保留优先级、法务删除、导出、加密和配额时，无法实现真实的“删除聊天”“卸载 Feature”“移除 Pack 历史”，也无法估算磁盘与支持成本。

**可能失败场景**

用户删除聊天并认为附件已清理，但 Artifact 因 Run/Evidence/Managed 引用仍被保留；另一个清理器为满足空间配额删除了仍被历史 Run 引用的文档或录制，导致审计不可恢复。

**建议**

- 先建立统一 retention class 与引用图；定义法律/安全保留优先级；
- 每个 owner 明确 logical delete、tombstone、物理 GC、导出和不可恢复删除语义；
- 冻结配额、压力行为、低磁盘门禁、备份是否含密文/Secret；
- 以代表性录制、revision 和 snapshot 规模做容量基准；
- 用户确认前，不开放声称“彻底删除”或“无限历史可用”的入口。

**关闭类型**：用户决定 + 数据治理文档阻塞项 + 容量原型。  
**阻塞范围**：业务 Feature 开发/发布、备份和 Pack Sync；基础机制 spike 可使用有界 fixture。

### P1-13：Pack Sync 的分页一致性与离线授权策略未定义

**证据**

- Pack Sync 明确是 Proposed / For User Review，不授权开发（[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md)，L3–5）。
- 方案要求必需页面全部成功才晋升 full snapshot，但没有 source snapshot token、watermark 或跨页一致性验证（[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md)，L115–145）。
- `PackAccessState` 包含 `session_unavailable`，只明确 `access_denied/inaccessible` 时隐藏缓存业务详情（[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md)，L74–97、L147–160、L197–204）。
- 删除链路的两次目标级实时验证和旧缓存不授权 mutation 是正确约束（[PACK_SYNC_CACHE_EVALUATION](PACK_SYNC_CACHE_EVALUATION.md)，L164–195）。

**为什么是问题**

“每页都成功”不保证页面来自同一外部时刻；Sync 期间 Omnia 变化可能造成重复、遗漏或不可能组合。当前 Session 不可用时，是否允许显示缓存客户名称/元素也不明确，存在权限已撤销但尚无法联网确认的隐私风险。

**可能失败场景**

Workspace 枚举到第二页时对象从第三页移动到第一页，最终 snapshot 漏掉对象却被标 full。另一次启动无 Session，系统继续显示上次缓存，而该用户的 Pack 权限已被撤销。

**建议**

- 保持 Pack Sync 完全排除在 Accepted Shell/Feature 范围之外，直到用户明确接受；
- 接受后创建独立 ADR，说明它是共享读取服务，不是 Managed Content authority；
- 优先使用 Omnia snapshot token/consistent cursor/watermark；若不支持，记录开始/结束 fingerprint 并把覆盖标为 non-atomic observation，不能声称完整当前事实；
- 明确 offline/session-unavailable 默认 fail-closed 的详情可见性、重新授权窗口和最小历史元数据；
- `user_assumed_unchanged` 只能是审计选择，不能成为 safety freshness；
- 做大 Pack 分页、并发变化、权限撤销、容量和清理原型。

**关闭类型**：Pack-only 的用户决定 + 设计文档阻塞项 + 未来原型。  
**阻塞范围**：只阻塞 Pack Sync；若它保持不在范围内，不阻塞 Shell Baseline 的其他原型。

### P2-01：四 Plane 文档映射可证明 ID 存在，但不能自动证明描述的语义真实

**证据**

- 每个 capability 必须恰好有四条 Plane 记录，并双向验证 action/schema/operation/migration/test ID（[CONTRACTS](../contracts/CONTRACTS.md)，L751–774）。
- 安装器要拒绝“代码有能力而文档遗漏”或“文档宣称不存在实现”（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L339–345）。

**为什么是问题**

机器可验证 entrypoint/ID 是否存在，却不能判断 responsibility、数据 owner、失败边界和恢复说明是否准确。强制每能力四条记录还可能产生大量形式合规、语义空洞的 `not_applicable`。

**可能失败场景**

映射引用真实 operation ID，安装校验通过，但文档把实际 mutation 误写为 read-only，或遗漏其对 Managed projection 的失败恢复。

**建议**

- 生成公开 symbol/contract catalog 供映射解析；
- 对 `effect`、permission、data owner、migration、canary 做可推导交叉校验；
- 高风险 capability 必须人工 architecture/security review；
- 统计无理由 `not_applicable`、未使用 contract ID 和文档漂移，而不是只检查四条数量。

**关闭类型**：文档完善项；未来 installer prototype 验证。  
**阻塞范围**：不单独阻塞 D5；在包发布前关闭。

### P2-02：模板状态词汇在决策说明与规范文档中不一致

**证据**

- 决策说明建议 `draft → validated → published → deprecated`（[OPEN_DECISIONS_GUIDE](OPEN_DECISIONS_GUIDE.md)，L161–174）。
- 模板管线规范使用 `Draft → Review → Published → Superseded|Revoked`（[TEMPLATE_AND_DOCUMENT_PIPELINE](../data/TEMPLATE_AND_DOCUMENT_PIPELINE.md)，L29–43）。

**为什么是问题**

`validated` 是校验结果还是生命周期状态、`deprecated` 是否等于 `superseded`、安全/许可 `revoked` 是否另有含义，当前可能被不同实现解释为不同状态机。

**可能失败场景**

UI 把已自动验证但未 owner 审批的模板视为 published；或运行时允许 `revoked` 模板用于新 Run，因为只认识 deprecated。

**建议**

指定一个 normative enum；把 validation result 与 lifecycle 分离；在非规范决策说明中链接并采用同一词汇。

**关闭类型**：文档阻塞项。  
**阻塞范围**：模板 Registry/默认文档项目，不阻塞无模板的基础原型。

### P2-03：全局 Feature/Capability/Operation ID 的命名空间与转移规则仍不完整

**证据**

- Feature 包要求稳定 `featureId`、capability 和 operation ID，并用它们做文档、权限、Run 和升级追踪（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L74–134、L384–410）。
- 包来源、第三方发布与信任边界仍待供应链 ADR（[FEATURE_PACKAGE_STANDARD](../architecture/FEATURE_PACKAGE_STANDARD.md)，L317）。

**为什么是问题**

一旦允许多个 publisher 或离线导入，短字符串 ID 可能碰撞。publisher 更名、功能转移到新包、拆包/并包、operation owner 转移也会影响历史 Run 和权限。

**可能失败场景**

两个受信 publisher 使用相同 `featureId`；后装包覆盖 Registry identity，历史文档和 Run 解析到错误实现。

**建议**

在供应链 ADR 中定义 publisher-scoped canonical ID、保留 namespace、转移签名、alias/tombstone 和禁止重用规则。

**关闭类型**：文档阻塞项。  
**阻塞范围**：生产包来源和第三方/离线导入；不阻塞单一受控 publisher 的 spike。

### P2-04：部分评审状态与产品文本已采用的措辞存在轻微状态漂移

**证据**

- 删除 UX 评审状态仍是 “Recommended for Acceptance”（[docs/README](../README.md)，L39–41）。
- 产品范围已直接写入消息卡复核、紧凑两栏等布局方向（[INITIAL_FEATURE_SCOPE](../product/INITIAL_FEATURE_SCOPE.md)，L122–128；[PRODUCT_REQUIREMENTS](../product/PRODUCT_REQUIREMENTS.md)，L224–232）。
- Pack Sync 同表中正确保留 Proposed / For User Review。

**为什么是问题**

实现者可能把“推荐”误当 Accepted，或反过来认为产品规范中的相关布局仍可自由变化。状态表是开发入口的主要导航，细小漂移会累积成范围争议。

**可能失败场景**

删除 Feature 按已采用布局开发后，用户认为消息卡 owner 尚未正式批准，需要返工；或团队把 Pack Sync 与删除 UX 同样看成已可进入实现。

**建议**

将删除 UX 的已接受部分和仍待确认部分拆开记录，必要时建立 ADR/decision record；继续保持 Pack Sync 为 Proposed。

**关闭类型**：文档清理项。  
**阻塞范围**：删除 Feature UX，不阻塞 D5。

## 5. 问题关闭类型汇总

“文档修订”关闭语义歧义和阶段门禁；“原型门禁”回答文档无法证明的技术可行性；“实现测试”是后续正式实现必须长期保留的回归证据，不能用一次原型代替。

| 发现 | 文档修订 | 原型门禁 | 后续实现测试 | 用户决定 |
|---|---|---|---|---|
| P1-01 阶段门禁/Baseline | 必需 | 必需 | 阶段退出与故障归因 | 批准 D5 范围 |
| P1-02 Core 准入 | 必需 | 条件性 | 架构边界/import/合同测试 | 不需要新增产品决定 |
| P1-03 Worker/UI 隔离 | 必需，形成 ADR | 必需 | 持续攻击、资源和逃逸测试 | 第三方包信任模型 |
| P1-04 原子激活 | 必需 | 必需 | 每阶段 crash/断电故障注入 | 包来源策略相关 |
| P1-05 freshness | 必需 | 条件性 | TTL/watermark/失效合同测试 | 域 freshness policy 可需确认 |
| P1-06 partial | 必需 | 条件性 | 并发漂移与逐字段/逐目标测试 | 不需要新增产品决定 |
| P1-07 外部身份 | 必需 | 条件性 | 跨租户、重生、迁移冲突测试 | v4 导入范围相关 |
| P1-08 projection/outbox | 必需 | 必需 | 磁盘满、重复、崩溃、repair 测试 | 不需要新增产品决定 |
| P1-09 全局备份 | 必需 | 必需 | 定期真实 restore rehearsal | RPO/RTO/保留 |
| P1-10 首条录制切片 | 必需 | 必需 | conformance kit + 真实双路径 | canary/Bridge/录制策略 |
| P1-11 在线更新撤销 | 必需 | 必需 | 撤销、pinning、probation、回滚测试 | 默认 rollout policy |
| P1-12 数据治理 | 必需 | 容量原型必需 | 配额、GC、导出/删除、低磁盘测试 | 必需 |
| P1-13 Pack Sync | 接受后必需 | 接受后必需 | 分页变化、权限撤销、容量测试 | 是否接受 Pack Sync |
| P2-01 文档语义校验 | 包发布前必需 | installer 原型覆盖 | ID/owner/effect 漂移测试 | 不需要 |
| P2-02 模板状态 | 模板实现前必需 | 不需要 | 状态机合同测试 | owner/发布流程相关 |
| P2-03 ID namespace | 生产包前必需 | 条件性 | 冲突/转移/重用测试 | 包来源/第三方策略 |
| P2-04 状态漂移 | 删除 UX 前必需 | 不需要 | 文档一致性扫描 | 接受删除 UX 决定 |

## 6. 十个审查角度的综合评价

### 6.1 业务目标、范围、阶段目标和完成定义

优点：

- 产品范围和禁止假入口原则清楚；
- Shell-first、四个 Feature 顺序、真实 canary 和 DoR/DoD 已有较完整描述；
- 文档明确区分“评审通过”与“用户批准开发”。

缺口：

- Stage 1 进入门槛没有强制引用 D5/D6；
- Baseline 的完成定义过宽，容易把多个未验证平台一次性耦合；
- 用户决定、Proposed 技术和未来原型应汇总成一张单一 release gate，而不是分散在 README、路线图和各 Feature。

### 6.2 总体架构、四 Plane、微内核与隔离

四 Plane 的职责、允许依赖和禁止项总体合理（[SYSTEM_ARCHITECTURE](../architecture/SYSTEM_ARCHITECTURE.md)，L139–164）。关键风险不是逻辑划分，而是 Core 服务面、Windows 强隔离和 UI 扩展执行模型尚未落地。只要以 P1-02/P1-03 为门禁，架构可实施；若只靠目录、普通进程和 Electron 常规配置，则不满足 Accepted 目标。

### 6.3 Feature Package、版本、兼容、迁移、回滚与文档同步

包规范覆盖 manifest、权限、Store owner、UI、文档、签名、SBOM、候选、drain、probation 和 Local/Remote canary，方向完整。最大缺口是 P1-04 的跨资源激活/恢复协议。ADR-0023 可落地，但应把“文档与代码的原子指针一致”限定为 activation record，不宣称文件、迁移和进程生命周期属于单一 ACID 事务。

### 6.4 Connector Core、Operation Module、Local/Remote 与在线升级

Core/Operation 拆分和单 Transport 合同可行；`uncertain/reconcile`、active lease、无静默 fallback、写后读回是重要优势。真正成本在 Remote Bridge 长期运维、E2E、大文件、更新 Supervisor、兼容矩阵和真实双路径测试。P1-11 关闭前不能认为在线升级完整。

### 6.5 数据模型、current/ledger/tombstone、freshness、partial/uncertain、outbox、备份与保留

current projection + immutable ledger 的双模型是正确方向，比纯 event log 或覆盖式快照更适合 Phase 2。`uncertain` 不写计划值、tombstone 不冒充物理删除、外部 effect 不因本地投影失败而重放，都设计得较好。

当前必须修复 P1-05 至 P1-09 和 P1-12；否则系统可能把旧快照称为 current、合成未观察对象、混淆跨租户身份、在双写失败后状态分裂，或恢复出跨 Store 不一致数据。

### 6.6 ADR-0023、ADR-0024 与两个 Registry 的工程可落地性

**ADR-0023：可落地，复杂度中高。**

- 适合内容寻址、不可变版本、生成索引和 active/previous 指针；
- 主要成本是安装扫描、四 Plane ID 解析、历史版本存储、链接/渲染安全和人工语义审核；
- 故障边界应是 candidate 不可见、activation record 原子、旧版可读；不是整个安装过程 ACID。

**ADR-0024：可落地，复杂度高。**

- 适合独立 Managed Content Service/Store；
- 主要成本是类型 Schema 演化、identity、projection/outbox、漂移、字段 provenance、查询授权、ledger 保留和 restore reconcile；
- 故障边界应优先保护外部 effect 和 Evidence，再异步修复投影；在修复完成前不能向需要新鲜数据的消费者声称成功/current。

两个 Registry 都不应变成新的业务事实源：Documentation Registry 只证明安装文档版本，Managed Content 只证明 Agent 已验证的本地管理投影；Feature 健康仍由 Registry/Core，Omnia 当前危险事实仍由实时 Connector 读取。

### 6.7 Pack Sync、快照缓存、删除安全、隐私、容量、离线与复用

方案把 Pack Snapshot 与 Managed Content 分开是正确的：前者是外部世界的观测缓存，后者是 Agent 已验证管理事实。删除计划和 mutation 前两次目标级实时校验也应保留。

但 Pack Sync **仍仅为 Proposed**。其分页一致性、Session 不可用时缓存可见性、容量/保留和 authority identity 未关闭；它不能成为 Shell Baseline 或删除 Feature 的隐含前置，也不能把 `user_assumed_unchanged` 转化为安全授权。

### 6.8 首批 Feature 顺序与增量验证

顺序本身是明确的用户决定，应保持不变。工程问题在于第一项录制的前置面最大，而完整四 Plane/mutation/Managed 验证到第四项才出现。解决办法不是更改用户可见 Feature 顺序，而是在之前完成非产品 conformance spikes，以技术 fixture 隔离验证平台边界。

### 6.9 迁移与开发路径

v4 “证据提取而非代码延续”、逐类 importer、未知 schema 失败关闭、Secret/配对/在途状态不迁移等原则合理。风险在于：

- Baseline Stage 1 入口过早；
- 物理 Store/加密/备份未冻结就写 importer 会固化错误布局；
- external identity 未冻结会污染新 ledger；
- package migration 与 previous-readable 回滚未原型验证；
- v4 数据范围、保留和清理仍需用户逐类批准。

### 6.10 开发阻塞、未来原型与用户决定

开发阻塞不应混成一个列表：

- **文档先关闭**：P1-01、02、04、05、06、07、08、09、10、11、12；P2-02/03 在相关实现前关闭；
- **未来原型证明**：runtime/IPC、Worker/UI sandbox、Store/outbox/backup、installer crash recovery、Remote Bridge、大文件/TTL、在线更新/撤销、代表性容量/NFR；
- **用户确认**：canary、更新策略、包来源、删除生命周期、模板、v4 导入、保留/RPO/RTO、Bridge 运维、Pack Sync；
- **保持排除**：Nova 精确协议、未批准 Pack Sync、未批准第三方包和任何无真实闭环的 UI 入口。

## 7. 架构优点

1. **事实源纪律强。** UI 不拥有业务真相，Run/Event/Command/Evidence/Artifact 均持久化；没有后端就没有入口。
2. **外部 effect 语义严谨。** `failed` 不等于未发生，`uncertain` 不自动重试，reconcile 必须是新 read-only 命令。
3. **Omnia 权威边界正确。** Managed Content 不替代危险操作的实时预检，缓存也不授权删除。
4. **Local/Remote 没有双业务合同。** 单 Transport、单 active lease 和不静默 fallback 能减少行为漂移。
5. **包与数据 owner 边界明确。** Feature 不跨库、不 import 其他 Feature，失败不应影响 Shell 和无关 Worker。
6. **文档被纳入发布物。** ADR-0023 使运行版本、文档和历史 Evidence 可追溯，避免手工文档漂移。
7. **迁移态度保守。** v4 不受信任，未知或敏感状态不“尽量转换”。
8. **安全验收是行为级。** 不是只写“使用 sandbox”，而是列出文件、网络、进程、DOM、Bridge 和资源攻击用例。

## 8. 主要工程成本

| 成本中心 | 成本来源 | 控制建议 |
|---|---|---|
| 平台内核 | 多服务合同、持久状态机、事件/outbox、进程 supervision | 分阶段加入服务；每项独立 fault budget |
| 扩展与供应链 | 签名、SBOM、兼容、迁移、候选、回滚、文档扫描 | 单一官方 publisher 起步；先冻结 namespace/信任根 |
| Windows 隔离 | Worker、Parser、Operation、UI 四类不可信执行面 | 共用 broker/sandbox primitives；用攻击原型选型 |
| 数据与恢复 | 多 Store、Artifact、Evidence、Managed ledger、备份引用闭包 | 统一 epoch、journal、repair scanner 和 restore rehearsal |
| Remote | Bridge、身份、E2E、TTL、续传、Supervisor、在线更新 | Bridge 保持最小；明确运维/SLA；Operation 优先 |
| 测试 | Local/Remote parity、真实 Omnia canary、断电/磁盘满/崩溃 | 建 conformance kit 和受控非生产环境 |
| 运营与治理 | 审计、配额、保留、导出、删除、密钥、撤销 | 在业务功能前冻结 retention/security policy |
| 文档同步 | 每 capability 四 Plane、历史版本、语义审核 | 自动生成 ID catalog；高风险内容人工审核 |

## 9. 推荐的开发前关闭顺序

1. 用户确认当前只批准“文档收敛 + D5 有界原型”，不批准 Shell/Feature 实现。
2. 修订 Stage 1 入口和 Baseline 分层，关闭 P1-01/P1-02。
3. 修订 Managed Content freshness、partial、identity 和 projection 状态，关闭 P1-05 至 P1-08。
4. 冻结 crash-safe installer/activation 和全局 backup epoch 文档，关闭 P1-04/P1-09。
5. 用户冻结保留、RPO/RTO、包来源、Bridge 运维、更新与 canary 决定。
6. 执行并记录 D5：runtime/IPC、sandbox/UI、Store/backup、Bridge、在线更新和容量原型。
7. 把原型结果写入 Accepted ADR；未通过的选型不得进入 Baseline。
8. 进行 D6 第二次独立审查，用户签署 Go。
9. 开始正式 Shell Baseline；只呈现真实平台状态和真实空 Registry。
10. Shell Baseline 验收后，再按已接受顺序逐个进入业务 Feature；Pack Sync 保持排除，除非另行接受。

## 10. 最终判定

**架构是否值得继续：是。**  
**是否存在不可行的根本矛盾：未发现。**  
**是否可按当前文档直接开始完整 Shell Baseline：否。**  
**是否可在用户批准后开始有界技术原型：是。**  
**是否可开始业务 Feature 开发：否。**  
**Pack Sync 是否已被接受或可进入开发：否，仍为 Proposed / For User Review。**

推荐决策为：

> **Conditional Go for D5 technical prototypes; No-Go for production Shell Baseline implementation and all business Feature development until the P1 document blockers, prototype gates, and user-confirmed decisions are closed.**
