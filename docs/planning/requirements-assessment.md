# Omnia Agent v5 需求评估与架构收敛意见

状态：主 Agent 评估稿，用于约束正式开发文档；当前不代表已经开始开发。

## 1. 对重构目标的判断

本次重构不是一次 UI 改版，也不是把 v4 的目录重新命名为“前台、中台、后台、Connector”。真正目标应定义为：

> 将 Omnia Agent 重构为一个本地优先、契约驱动、模板优先、功能包隔离的桌面平台；前台只负责交互和交付，中台功能包独立处理资料，后台保存唯一可信状态并编排流程，Connector 只作为 Omnia 安全接入网关。

v4 已经积累了真实 Omnia 闭环、安全写入、Connector、模板和测试资产，但它的模块化主要停留在源码目录和元数据注册层。v5 必须把“模块”提升为可单独安装、启动、停止、升级、回滚和验收的部署单元。

## 2. 已收敛的产品范围

### 2.1 当前版本形态

- 只维护一个本地桌面版本，不再维护面向用户的在线版产品。
- 应用首次运行默认使用本地 Connector。
- 设置中可切换到远程 Connector；选择成功后持久化，下一次启动沿用上次选择。
- 任一时刻只允许一种 Connector Transport 生效。远程模式不可在故障时静默回退到本地模式。
- 远程服务器只承担配对、鉴权、消息中继、流控和短期审计，不运行 Omnia 业务逻辑，不持有 Omnia 会话。

### 2.2 当前阶段

- 本阶段只完成调研、需求、架构、契约、数据、测试、迁移和实施文档。
- 不创建业务应用脚手架，不开发前端、中台、后台或 Connector 功能。
- 架构和接口契约通过评审前，不制作任何可点击的“占位功能”。

### 2.3 明确删除或停止延续的产品概念

- 删除前台“+ 添加 Agent”入口。
- 不再把第二列作为 Agent/用户列表。
- 不把多 Agent、员工、群聊等 v4 历史概念默认迁入 v5 核心信息架构；若未来确有业务需求，应作为独立 ADR 重新评估。

## 3. 四个模块的规范定义

为避免“中台”和“后台”在代码中继续混用，开发文档和未来代码统一采用以下架构术语。

| 用户术语 | 架构名称 | 核心职责 | 明确禁止 |
|---|---|---|---|
| 前台 | Delivery Plane | 功能导航、表单与资料接收、进度展示、人工复核、文件下载和结果交付 | 解析业务资料、生成底稿、执行 AI 推理、直接访问数据库或 Omnia |
| 中台 | Execution Plane | 由隔离功能包执行资料解析、规则计算、AI 调用、模板差异生成和结果校验 | 直接访问 Omnia、直接读写后台数据库、跨模块导入内部代码 |
| 后台 | Control & Data Plane | 模块注册、任务编排、状态机、模板目录、业务数据、Artifact Store、审计、设置和 Connector 命令 | 承载具体场景的文档加工算法、绕过 Connector 直接访问 Omnia |
| Connector | Integration Plane | 维护既有 Omnia 会话、接收受控指令、执行已注册 Omnia 操作、回传脱敏结果和证据 | 资料处理、模板选择、AI 推理、功能工作流编排、保存业务主数据 |

四个 Plane 可以位于同一个本地安装包中，但不能因此共享内部实现。边界以版本化契约、独立进程和受控存储权限落实，而不是只靠目录约定。

## 4. 推荐的总体架构

### 4.1 架构风格

推荐采用“微内核控制面 + 隔离功能包 + 可替换 Connector Transport”，而不是为本地单用户产品照搬复杂的云端微服务。

- 桌面 Shell、后台核心和模块管理器组成稳定微内核。
- 每个业务功能是一个独立 Feature Package，并在独立 Worker 进程中运行。
- 功能包通过版本化 SDK/RPC 调用后台服务，不直接导入其他功能包或后台源码。
- 本地 Connector 与远程 Connector 共用一个 `ConnectorTransport` 契约。
- 新功能原则上只增加 Feature Package、后台登记信息和必要的 Omnia Operation Pack，不修改 Shell、后台核心或 Connector 核心结构。
- 首个工程交付先完成不内置业务 Feature 的真实 Shell Baseline；四个首批功能按既定顺序作为独立包安装和验收。
- 每个 Feature 的每个 capability 都用统一结构记录四 Plane 的实际实现；签名文档与代码同版本安装到项目 Documentation Registry。
- 后台新增 v4 不具备的 Agent Managed Content Registry：保存 Agent 创建/修改/删除对象与关系的当前投影和不可变变更历史，供 Phase 2 复用。

### 4.2 统一功能包

每个功能包必须使用完全相同的结构和生命周期，至少包含：

- `manifest`：模块 ID、版本、合同版本、2–3 段菜单路径、权限、资源限额、兼容范围；
- `contracts`：输入、输出、任务事件、错误、Artifact 和 Connector 操作 Schema；
- `worker`：独立进程中的真实处理逻辑；
- `ui`：只消费真实后台状态的功能界面；
- `migrations`：仅作用于本模块数据域的前向迁移；
- `template-bindings`：场景与后台模板版本的引用，不复制模板主文件；
- `tests`：合同、单元、集成、升级、回滚和真实闭环门禁；
- `healthcheck`：加载、依赖、模板兼容和运行状态检查。
- `docs`：文档 manifest、逐 capability 四 Plane 实现映射、数据/迁移、运维/恢复、测试/canary 和 changelog。

模块安装和升级必须执行“候选目录 → 签名与完整性检查 → 文档与实现双向校验 → 兼容性检查 → 模块私有迁移/checkpoint → 候选进程健康检查 → 单一 activation record 激活 Feature/Documentation → 观察期 → 晋升或按 journal 恢复”。整个流程不是跨文件/Store/进程的 ACID 事务；一个模块失败不得阻止其他健康模块启动。

### 4.3 进程与数据隔离

- 前台、后台、每个中台功能模块和 Connector 分属不同进程边界。
- 功能模块只获得本次 Run 所需的只读输入 Artifact 和专属输出目录/上传能力。
- 功能模块不能获得后台数据库文件路径、Connector 凭据、其他模块目录或全局 AI Key 明文。
- 每个模块拥有独立的数据命名空间和迁移版本；禁止多个模块共同修改同一组业务表。
- 跨模块协作通过后台事件或显式的公共合同完成，不允许直接读写另一个模块的数据。

## 5. 前台信息架构与交互要求

### 5.1 主界面

- 保留紧凑的工具栏/应用 Rail。
- 第二列改为真实功能树，最大三级；二级可以直接是 Feature，也可以是通往三级 Feature 的能力组。
- 叶子菜单只来自后台当前已安装、已启用、兼容且健康的模块注册信息。
- 没有真实后台能力的菜单不显示；已安装但不可用的模块可以禁用，并展示来自真实健康状态的原因。
- 主工作区显示当前功能的资料接收、真实处理进度、人工复核和结果交付。
- 上传控件只把文件流交给后台 Intake API；前台不解析 Excel/PDF/Word，不生成业务数据，也不作最终有效性判断。

### 5.2 视觉方向

以 Navicat 一类桌面数据工具的树形导航为参考，目标是紧凑、专业、清晰，而不是大字号卡片式 SaaS Dashboard：

- 默认正文建议以 12–13px 作为设计基线，树节点使用紧凑行高；
- 层级依靠缩进、展开箭头、图标和分隔线表达；
- 避免大面积留白、巨型标题、装饰性统计卡和无数据价值的动画；
- 所有密度、字号和可调整列宽最终须通过 Windows 常用缩放比例的可用性测试确认。

这只是设计方向，正式文档必须给出 Design Token、键盘操作、焦点、树状态持久化和可访问性要求，不能仅写“仿 Navicat”。

## 6. 后台数据与 Artifact 设计

### 6.1 存储分层

“后台有独立数据库”不应理解为把所有 Excel/PDF 二进制直接塞入一张表。推荐：

- Core Database：模块、运行、事件、设置、模板元数据、Artifact 元数据、Connector 命令和审计记录；
- Module Data Stores：由后台托管的模块私有数据域和独立迁移；
- Content-addressed Artifact Store：用户上传、模板正文、中间产物、输出文件和 Omnia 回传文件；
- Secret Store：AI Key、远程配对密钥等敏感信息，使用 Windows DPAPI/Credential Manager，不以明文进入数据库；
- Audit/Evidence Store：不可变或追加式保存的执行摘要、哈希、合同版本和写后验证证据。
- Managed Content Store：保存 Agent 管理对象/关系的类型化 current、revision、change、tombstone 和 provenance。

数据库保存索引、状态、关系、版本和哈希；文件正文进入受控 Artifact Store。所有路径都由后台生成，前台和模块不能提交任意本机路径。

### 6.2 Agent 管理内容登记

Run/Event/Evidence 不能替代可查询的业务当前状态。v5 必须同时维护：

- 最后一次经 Omnia 完整读回验证的 snapshot projection，供 Phase 2 按 maxAge/watermark、authority identity 和 schema 约束查询 RAIT、Factors Considered 等字段；
- create/update/delete/reconcile 的不可变 revision/change ledger；
- 对象和关系 tombstone，防止删除后下游继续把旧对象当 active；
- `partial/uncertain` 的未解决项和 freshness，禁止计划值覆盖 current。

该数据由共享 Managed Content Service 唯一拥有，Feature/Connector 不直写，Phase 2 不直连数据库。详细设计见 [Agent 管理内容登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)。

### 6.3 模板必须是一等实体

模板目录至少包含：

- `templateId`、`scenarioId`、语义版本、Schema/合同版本；
- 原文件 Artifact ID、SHA-256、文件类型和有效期；
- 适用模块版本、Omnia 目标类型和必需字段；
- 可修改区域、禁止修改区域、默认值规则和校验器版本；
- 发布状态、签名、来源、审批人和回滚关系。

模板一经发布即不可原地修改。更新必须生成新版本；历史 Run 永远能追溯到当时冻结的模板版本和哈希。

## 7. 模板优先的差异处理策略

用户提出的“默认情况下直接使用模板、一般情况下只修改必须修改部分”是 v5 的核心处理模式，但必须补充以下约束：

1. 先由场景合同唯一确定 `scenarioId` 和模板版本。
2. 后台冻结用户输入 Artifact、模板 Artifact、模块版本和规则版本。
3. 模块把输入归一化为场景 Schema，并明确区分：
   - 用户明确填写默认值；
   - 合同允许自动采用默认值；
   - 信息缺失；
   - 信息冲突或无法判断。
4. “缺失”不能自动等同“默认”。只有合同声明为 `defaultable` 的字段才可采用模板默认值。
5. 全部字段均可合法采用默认值时，生成该模板的 Run 专属不可变副本和 provenance manifest；不得直接修改或传递模板主文件。
6. 存在差异时，只对合同允许的字段/单元格/文档节点生成 Patch Set，其他样式、公式、结构和内容必须保持不变。
7. 输出需通过结构校验、业务规则校验、占位符检查、差异白名单检查和必要的可视化检查。
8. 后台保存输入、模板、Patch Set、输出、验证结果和哈希。
9. 若动作会写入 Omnia，必须先向用户展示真实差异和目标范围，并在确认后才由后台向 Connector 发命令。
10. 无法唯一选择模板、存在未默认化的缺失字段、输出验证失败或目标 Omnia 状态漂移时，任务失败关闭，不得“尽量生成”后假装可用。

## 8. Connector 的 Gate 边界

Connector 核心保持稳定，只负责：

- Local/Remote Transport 接入和设备身份；
- 既有 Omnia 登录会话与精确 Engagement/Pack 绑定；
- 受签名、版本和权限约束的 Operation Registry；
- 命令 Schema 校验、作用域校验、并发门禁、超时和取消；
- 只读重试策略与写操作不确定结果保护；
- Omnia 调用、流式进度、结果脱敏、Artifact 回传和证据采集；
- 心跳、健康、版本和最小诊断。

Connector 不负责决定使用哪个业务模板，不比较用户资料，不调用 AI，也不编排一个功能的多步流程。

为减少新功能修改 Connector 核心，新 Omnia 能力应通过经过签名和兼容性验证的 Operation Pack 注册。Operation Pack 只能使用 Connector 暴露的受控 Omnia 会话 API；不得获得任意系统命令或任意网络访问。不能为了“无需改 Connector”而开放一个可访问任意 URL、任意方法和任意请求体的通用 HTTP 后门。

## 9. Local/Remote 模式状态机

- 首次运行：`local`。
- 后续启动：读取后台持久化的上次有效模式。
- 切换到远程前：完成远程地址校验、配对、认证、Connector 身份和健康检查。
- 远程模式成功启用后：停止本地 Connector 的命令领取并撤销本地活动路由；UI 明确显示当前只使用远程路径。
- 切换回本地前：确认没有远程在途写操作，启动并验证本地 Connector 后再原子切换。
- 切换过程中禁止新任务进入；已有只读任务可按合同取消，有写入或 `uncertain` 任务时禁止切换。
- 当前模式不可用时明确失败，不自动选择另一条 Transport。

Local 和 Remote 必须运行同一套业务命令 Schema、幂等键、确认、结果状态、对账和合同测试。网络拓扑只能由 Transport Adapter 感知。

Remote Connector 必须继续支持在线升级，但采用分层策略：

- 新 Feature/新 Omnia 业务能力优先只发布签名 Operation/Capability Module，活动 Run 固定旧版本；
- Connector Core 只在 Transport、Session、Gate、安全边界、受控 SDK 或基础兼容确实变化时升级；
- Core 使用 candidate/active/previous、签名/hash/SBOM/sequence、安全窗口、probation 和回滚；
- 更新时不切到 Local，不强制打断 mutation 或 `uncertain`；
- Supervisor/trust root 更新使用更严格的独立 bootstrap。

## 10. AI Provider 设置

v5 应撤销 v4“服务端固定 DeepSeek 地址和单一模型、页面只收 API Key”的产品限制，同时保留密钥安全边界。

设置页至少支持：

- Provider Profile 名称；
- Provider 类型：DeepSeek、OpenAI-compatible Custom（可覆盖 Nova API 等兼容服务）；
- Base URL/API Endpoint；
- API Key；
- 模型列表和默认模型；
- 真实“测试连接”；
- 连接超时、是否支持模型发现等能力状态。

模型列表优先从 Provider 实时能力发现接口读取；服务不支持发现时允许用户手工填写模型 ID，并明确标记来源。保存和测试必须由后台执行，前台不直接向 Provider 发送 Key。API Key 使用 Secret Store；普通 API 和日志只返回是否已配置、脱敏标识和连接测试摘要。

功能模块通过统一 AI Gateway 请求模型，不直接保存或读取 Provider Key。每次调用记录 Provider Profile ID、模型、用途、Run ID、Token/时延和脱敏错误类别。精确 Nova API 协议、认证头和模型发现方式目前没有可靠资料，应作为 Provider Adapter 验证项，不能在架构文档中猜测。

## 11. 必须继承的 v4 安全与可靠性底线

以下能力虽然需要重构实现，但不能在 v5 中丢失：

- 所有 UI 入口连接真实后台、真实数据或真实状态；
- 写操作必须确认、实时预检、幂等、持久化状态、写后验证；
- `uncertain` 表示写入可能已发生，禁止自动重试，必须先重新读取并对账；
- Connector/Room/Engagement/Pack/Run/Operation 身份在任务中冻结；
- 只读请求可按白名单有限重试，非幂等写入不可因超时或 502 自动重放；
- 前端刷新、应用重启和多窗口必须从后台唯一事实恢复；
- Connector 和模块包必须签名、哈希校验、单调版本、候选健康检查和可回滚；
- 本地 API/IPC、Host、Origin、启动令牌、秘密和路径访问继续失败关闭；
- 真实 Omnia 验收必须经 Agent → Connector → 已登录 Omnia 会话完成；
- 历史快照必须标明采集时间，不能冒充当前实时状态；
- 无来源的数据必须返回 `not_evaluable` 或等价状态，不能猜测成通过或失败。

## 12. 用户决定与剩余问题

已确认：

1. 主界面保持三列，第三列保留聊天。
2. 首批 Feature 为“其他”下的新建与关联、删除元素、删除聊天记录和录制。
3. 开发、真实闭环验收和开放顺序为“录制 → 删除元素 → 删除聊天记录 → 新建与关联”；第四项用已验证的窄 canary 完成四 Plane 综合验收。
4. Remote 面向全部版本。
5. Remote Connector 必须支持分层在线升级，并尽量少升级 Core。
6. 功能菜单最多三级，二级或三级都可以是 Feature 叶子。
7. Nova 协议验证暂缓，不阻塞首批范围，也不宣称已支持。
8. 先交付真实 Shell Baseline；录制、删除元素、删除聊天记录、新建与关联分别使用独立 Feature 包测试安装、隔离、升级和回滚。
9. “新建与关联”的 v5 默认文档当前尚未准备；它是第四 Feature 的独立 DoR 阻塞项目，不影响前三项开发。
10. 每个 Feature 必须记录各 Plane 的真实实现；安装 Feature 时把同版本签名文档发布进项目 Documentation Registry，并与代码原子升级/回滚。
11. 后台必须保存 Agent 创建、修改和删除内容的当前状态与历史变化；RAIT、Factors Considered 等已验证字段可供 Phase 2 通过合同读取。
12. 删除元素使用紧凑两栏，无常驻选择篮；右上角消息卡独占确认、进度和结果，终态自动刷新。
13. 删除聊天正文立即物理删除，无引用聊天专属附件清理；必要业务/Evidence 分离保留。
14. 删除与录制基于 v4 固定证据基线和既有测试方法重新认证，不要求专用 Pack。

仍需在开发前形成 ADR 或用户决策：

1. Remote Bridge 的身份、端到端保护、TTL、部署和 SLA 技术方案。
2. D5 runtime/IPC、Store、sandbox、installer、Remote 和轻/重抓取原型范围与指标。
3. 代表性 Windows 设备和典型数据规模的性能/容量基准。
4. “新建与关联”canary 的非生产 Workspace、模板版本、APP/DB 测试对象和清理责任人。
5. “新建与关联”默认文档的候选来源、许可、默认字段、保护区域、业务负责人和批准人。

## 13. 正式开发文档验收标准

正式文档至少应包含并保持相互一致：

- 产品需求、范围、术语、角色和用户旅程；
- 系统上下文、容器、组件、运行时和部署图；
- 四个 Plane 的依赖规则和禁止依赖；
- Feature Package 目录、manifest、生命周期、兼容和回滚合同；
- Feature Documentation manifest、逐 capability 四 Plane 实现映射、项目文档安装/升级/回滚和历史版本规则；
- Agent Managed Content 的对象/关系 current、revision、change、tombstone、adopted baseline、freshness、Phase 2 查询与恢复合同；
- 最大三级、允许二级/三级 Feature 叶子的菜单与模块注册真实数据合同；
- Run、Event、Artifact、Template、Patch、Provider、Connector Command 的状态和数据模型；
- 上传、默认模板、差异模板、Local Connector、Remote Connector、AI 调用和 Omnia 写入的时序图；
- API/RPC/Event Schema 示例及统一错误模型；
- 安全、秘密、权限、审计、幂等、`uncertain` 恢复和灾难恢复；
- 性能、资源、容量、可观测性和本地运行非功能要求；
- 自动化测试、合同测试、真实 Omnia 验收、模块升级和回滚门禁；
- v4 资产迁移/废弃矩阵、分阶段路线、每阶段进入/退出标准；
- ADR 和尚未决定事项；
- 明确的“无真实闭环不提供入口”验收规则。
