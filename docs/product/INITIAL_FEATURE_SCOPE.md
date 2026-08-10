# 首批 Feature 范围

状态：Accepted Scope / Accepted Development Order  
决策日期：2026-07-30

## 1. 首批范围

首批 Feature 固定为“其他”一级模块下的四个真实功能：

| 当前导航路径 | Feature 层级 | 用户可见名称 | 核心边界 |
|---|---:|---|---|
| 其他 → 元素管理 → 新建与关联 | 3 | 新建与关联 | 只在真实模板、实时预检、冻结计划和明确确认后，新建已验证类型并读回证明必需关联 |
| 其他 → 元素管理 → 删除元素 | 3 | 删除元素 | 只能删除当前安全锁允许范围内、经实时预检和用户确认的元素 |
| 其他 → 删除聊天记录 | 2 | 删除聊天记录 | 只清理当前 v5 本地会话在第三列中的聊天，不删除 Feature、配置、Omnia 平台数据或无关业务数据 |
| 其他 → 录制 | 2 | 录制 | 通过当前 active Connector 对已绑定 Omnia 会话执行真实录制、停止、完整性验证与导出 |

功能树最多三级，不强制所有 Feature 使用第三级。“元素管理”当前包含两个相关功能，因此保留分组；删除聊天记录和录制直接作为二级 Feature，不创建只有一个叶子的“会话管理/诊断与取证”分组。以后调整 parent 不改变 Feature 身份、权限、route 或历史 Run。

稳定 Feature ID 命名规则仍待公共 namespace ADR 决定，当前文档不提前硬编码生产 ID。

下文按当前功能树顺序说明四项范围，不代表开发先后；开发顺序以第 7 节和 ADR-0021 为准。

交付模型采用 Shell-first：先验收不内置业务 Feature 的真实 Shell Baseline，再把四项分别构建为独立签名 Feature 包逐个安装。Feature 代码、UI、私有 migration 和 Operation 不能编译进 Shell 或通过私有旁路运行，详见 [ADR-0022](../adr/0022-shell-first-independent-feature-packages.md)。

每个包还必须携带同版本签名文档，逐 capability 记录 Delivery、Execution、Control & Data、Integration 的实际实现，并在安装时原子发布到项目 Documentation Registry，详见 [ADR-0023](../adr/0023-feature-documentation-bundle.md)。

## 2. 三列主界面中的行为

主界面保持三列：

1. 第一列：最小固定宽度 Rail，只保留 OA 和底部设置；
2. 第二列：来自后台 Feature Registry、最多三级且允许二级/三级 Feature 叶子的纯功能树；
3. 第三列：固定 `Comments`、docked Feature 标签、唯一确认卡、交付工作区与始终保留的聊天输入区。

连接、刷新、保活、当前 Pack 和安全锁位于跨第二/第三列的固定顶部会话状态栏。

四个首批 Feature 及其独立工具窗口都在右上角提供统一的全局 `− 百分比 +` 控制，并使用后台持久化的同一 UserViewPreference。

第一列与第二列之间没有 Splitter；第二/第三列、聊天消息/输入区和各 Feature 内部允许调整的相邻长期功能区域使用统一 Splitter。布局偏好按 surface 持久化，Feature 之间互不覆盖。

选择 Feature 不删除第三列聊天，而是在原聊天记录区域打开/聚焦隔离 docked Surface，并为当前标签建立真实 `FeatureContext`：

- 聊天标题区明确显示当前 Feature、版本和可用状态；
- 用户仍可通过聊天提交说明和上传资料；
- 点击 Feature 叶子默认打开或聚焦第三列 Feature 标签；结构化选择、预检与计划创建只使用后台真实 action/state；用户可通过 `↗ / −` 把同一 Surface 弹出或最小化为独立窗口；
- Feature 切换、刷新或重启后，当前上下文从后台恢复；
- 不新增永久第四列；
- 未接入真实后端的 Feature 不进入功能树。

第二列不内联任何工作台，顶部会话栏下直接开始功能树。结构化工作台默认进入第三列隔离 Feature 标签，可主动弹出/最小化；Feature 进度、唯一确认卡、结果和 Artifact 交付归固定 `Comments`。标签切换不会删除聊天，底部聊天输入区始终保留。完整规则见 [主界面 UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md)与 [ADR-0034](../adr/0034-tabbed-feature-host-and-detachable-surfaces.md)。

## 3. 新建与关联

详细设计见[新建与关联 Feature](CREATE_AND_ASSOCIATE_FEATURE.md)。

当前 DoR 阻塞：v5 默认文档尚未准备，且没有可绑定的已发布 `TemplateVersion`。该缺口已登记为[默认文档准备项目](../planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md)；不得使用 v4 历史文件、示例或临时文件绕过。

### 3.1 范围

- 用户上传唯一已发布的官方系统信息模板，前台只接收文件和声明，不解析业务内容。
- 隔离 Feature Worker 生成逐项 `create/reuse/resume/reference/blocked` 决策和声明式计划。
- 后台冻结输入 revision、模板/规则/capability 版本、目标身份、关系端点、并发状态和期望后置条件。
- 用户在右上角消息卡明确确认整个计划后，后台经当前 active Connector 分步执行小型 Operation。
- 两个 IT Element、两个 GRA core 和唯一 DB → APP 关系都通过 Omnia 实时读回，该 Feature 的四 Plane canary 才成功。
- 未通过真实 canary 的对象类型和关系类型保持隐藏或禁用并显示原因。

### 3.2 新建与关联的首个真实 canary

```text
前台接收一个 Generic APP + Generic DB 官方模板
  → 中台隔离 Worker 解析、验证并生成计划
  → 后台持久化 Run/计划/确认/命令
  → Connector 绑定真实非生产 Omnia 并执行创建
  → 创建并读回 APP core 与 DB IT Element
  → 建立并双边读回唯一 DB → APP 关系
  → 创建并读回 DB GRA core
  → 精确读回对象和关系
  → 后台保存 Evidence/结果 Artifact
  → 后台提交 Managed Content 对象/关系 revision 与 current
  → 前台自动重读并交付
```

首个 canary 只支持同一批、同一 Workspace 中一个新建的 `Generic Application`、一个新建的 `Generic Database` 和唯一的 Database → Application 关系，并读回两个 IT Element、两个 GRA core 和关系双方。Risk/Control 后处理、OS、Tool、SAP ECC、批外引用和多 APP 关系均留待逐类验证。

如果创建已验证但必需关联失败，Run 必须显示 `failed + partial effect`，不能显示整体成功，也不能自动删除已创建对象。提交点后无法判断结果则进入 `uncertain`，只允许只读 reconcile。

经验证创建的 APP/DB/GRA、关系、APP RAIT、Factors Considered 和 DB 有效 RAIT 必须进入共享 Agent Managed Content Registry。它们不只保存在本 Feature 私有结果或日志中；后续 Phase 2 通过版本化查询读取。

## 4. 删除元素

详细设计见 [删除元素 Feature](DELETE_ELEMENTS_FEATURE.md)。

### 4.1 命名与范围

- 用户可见名称从“删除安全锁内元素”简化为“删除元素”。
- 名称变化不改变安全边界：服务端和 Connector 必须继续强制校验安全锁。
- UI 不能显示、选择或提交安全锁范围外的可删除对象。
- 目标类型只允许已经具备真实读取、解除关系、删除和写后验证合同的元素；未知类型禁用并说明原因。

### 4.2 真实闭环

```text
轻抓取权威 Section/部分 + Workspace
  → 对选定 Workspace 重抓取允许类型的元素目录
  → 用户选择
  → 后台逐项实时预检
  → 冻结元素 ID、关系、锁、并发状态与计划摘要
  → 用户明确确认
  → Connector Operation 执行解除/删除
  → 逐项写后读取与关系验证
  → 后台更新 Managed Content 关系/对象 tombstone
  → succeeded / failed / uncertain
```

必须保留：

- 安全锁快照随计划冻结，锁变化使计划失效；
- Section/Workspace 归属只使用 Omnia 权威 identity；禁止按 `TEST`、`20000`、`IT Elements` 等显示名称推断；
- 重抓取仅限当前 Pack、选定 Workspace 和 Feature capability 声明范围，必须分页、可取消、可观测；
- 零匹配、多匹配、未知类型、目标漂移和并发 token 变化失败关闭；
- 单项失败不能伪装整批成功；
- 提交点后失联进入 `uncertain`，禁止自动重试；
- 所有进度、统计、详情和结果来自真实 Run/Event/Evidence。
- 删除成功后共享 current 不再返回 active 对象，但历史 revision/tombstone 保留；partial/uncertain 不误删未证明记录。

UX 采用“选择工作台 + 右上角消息卡”的单一责任模式：

- 工作台只做实时目录、搜索、选择和创建计划；
- 确认、执行进度、终止和结果统一在右上角消息卡处理；
- 不在工作台底部重复弹出删除计划面板；
- 删除进入终态后自动强制刷新真实目录；
- 字体与行高使用紧凑密度，详细设计见 [删除元素 UX 复核](../reviews/DELETION_UX_REVIEW.md)。

## 5. 删除聊天记录

详细设计见 [删除聊天记录 Feature](DELETE_CHAT_HISTORY_FEATURE.md)。

### 5.1 范围

- 目标是当前用户明确选择的 v5 本地聊天会话/上下文，也就是主界面第三列显示的 Agent 对话。
- 它不是删除 Omnia 平台中的聊天、评论、邮件、工作项或其他远端业务记录，不经过 Connector。
- “删除聊天记录”沿用 v4 的产品语义：保留 Agent/应用配置和 Feature 配置，只清理当前会话的聊天内容及按最终数据策略允许清理的本地派生记录。
- 删除 Feature 入口、模块配置、模板、Provider、Connector、业务主数据或其他会话不在本 Feature 权限内。
- 活动 Run、待确认操作或未解决 `uncertain` 与聊天记录的引用关系必须在删除前检查。

### 5.2 真实闭环

```text
读取会话真实摘要和引用
  → 展示消息/附件/活动 Run 影响
  → 阻断不安全状态
  → 用户明确确认
  → 后台事务执行既定删除/保留策略
  → 重新读取会话和引用
  → 展示真实结果
```

数据策略已经确认：

- 聊天正文立即物理删除，不提供普通用户回收站；
- 无引用、仅属于这些消息的附件由清理器物理删除；
- 已产生 Omnia effect、`uncertain`、共享引用和必要 Evidence 分离保留；
- Evidence 不复制聊天正文，只保存最小身份、digest、计数、时间、决定和结果；
- 删除结果分别报告已删除与保留内容，不声称抹除业务/审计事实。

具体事务和恢复合同见 [ADR-0015](../adr/0015-chat-history-immediate-deletion.md)。

## 6. 录制

详细设计见 [录制 Feature](RECORDING_FEATURE.md)。

### 6.1 范围

- 录制依赖当前 active Transport、已配对 Connector、有效 Omnia Session 和精确 Engagement/Pack。
- Connector 负责会话绑定、采集 Gate、进度、脱敏和回传；Feature 负责编排录制 Run、用户交互、完整性判定和 Artifact 交付。
- 采集深度沿用 v4：在 capture policy 内详细记录请求/响应、事件、segment、时序和必要正文；Secret 在 Connector 源头剔除。
- 以 v4 当前 Recorder、完整/不完整录制、Handoff 和合同测试建立首轮等价基线，不要求用户准备专用 Pack；首次现场验收使用届时已有的非生产页面流程。
- 不把历史录制或本地固定文件冒充当前录制结果。

### 6.2 真实闭环

```text
验证 Connector/Session/Engagement
  → 创建持久录制 Run
  → 用户启动
  → Connector 实时采集并回报状态
  → 用户停止或受控终止
  → 完整性/范围/脱敏校验
  → 后台保存录制 Artifact 和 Evidence
  → 用户查看真实摘要并导出
```

必须支持并真实接线：

- 开始、停止、状态、失败、断线恢复和导出；
- 录制范围、采集时间、Connector/Session/Engagement 绑定；
- 完整性不足时明确失败或受限导出，不能显示“录制成功”；
- 客户正文、授权信息、Cookie、Token 和内部路径的双层脱敏；
- Artifact 默认保留在稳定 `data` 根且不按年龄自动删除；用户显式清理和低磁盘准入遵守统一数据策略。

## 7. 已确认的开发顺序

四项都属于首批范围。开发、真实闭环验收和开放顺序已由用户确定为：

1. **录制**：先验证真实 Connector/Session、Local/Remote、长运行状态、采集、Artifact、完整性、隐私和 Transport 故障恢复。
2. **删除元素**：在 Connector 基础链路通过后验证安全锁、实时预检、确认、关系解除、真实 mutation、写后读回、并发和对账。
3. **删除聊天记录**：按已确认的立即物理删除正文、清理无引用附件、分离保留必要 Evidence 语义，验证本地事务、引用、真实清理和刷新/重启恢复。
4. **新建与关联**：最后以一个 Generic APP + 一个 Generic DB + 两个 GRA core + 唯一 DB → APP 关系的真实 canary，综合验收四 Plane、模板、确认、Local/Remote、多步 Omnia mutation、双边读回、Evidence 和 `partial/uncertain`。

这是开发顺序，不是功能树排序；菜单仍按业务信息架构组织。把“新建与关联”放在第四项，不取消用户用它测试四模块链路的决定，而是把它改为首批完成前的综合验收。该 canary 通过也不等于一次开放完整 v4 Phase 1；本 Feature 的首个 canary 未通过前，不扩展批量或其他类型。详见 [ADR-0021](../adr/0021-initial-feature-development-order.md)。

第四项开始前必须先关闭默认文档准备项目；该项目未完成不影响前三个 Feature 按顺序推进。

## 8. 首批共同验收

- [ ] 四个叶子只在对应 Feature 已安装、启用、兼容、健康且授权时可点击。
- [ ] 第三列聊天在四个 Feature 下均保留，并从后台恢复 FeatureContext。
- [ ] 所有按钮、列表、搜索、统计、导出和详情使用真实数据/状态。
- [ ] 新建与关联使用单一 `traceId` 串起四 Plane，并读回证明新对象和必需关联。
- [ ] Agent 创建、修改、删除的对象/关系和关键业务字段进入共享 Managed Content current/revision/change；Phase 2 仅通过合同查询。
- [ ] 删除聊天记录不越权删除业务数据；删除元素不越过安全锁。
- [ ] 录制只使用当前真实 Connector/Session/Engagement。
- [ ] Workspace 轻抓取与重抓取均使用权威 Section/Workspace identity，不通过名称分类；重抓取只覆盖选定 Workspace/capability。
- [ ] 任一 Feature 崩溃、升级或禁用不影响另外三个 Feature。
- [ ] 干净 Shell 的业务 Registry/导航为空；四个 Feature 只在各自独立包通过安装与健康门禁后出现。
- [ ] 每个 Feature 包可独立禁用、升级、回滚和恢复，且全部前序已验收包继续可用。
- [ ] 每个 capability 的四 Plane 实现映射与 action/schema/migration/operation/test ID 双向一致。
- [ ] Feature 与项目文档的 active/previous 版本在安装、升级、失败和回滚中始终一致。
- [ ] Local/Remote 走同一 Feature 和 Connector 合同。
- [ ] Remote Connector 可分层在线升级；首批业务变化优先升级 Operation Module，Core 更新不打断在途安全状态且失败不切 Local。
- [ ] 未完成的数据保留、Remote 安全或 Nova 协议不被前端入口伪装为已完成能力。
