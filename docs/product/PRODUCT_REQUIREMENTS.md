# Omnia Agent v5 产品需求

状态：Draft for Review  
适用阶段：开发前需求与验收基线  
规范用语：“必须/禁止”为强制要求；“应”为默认要求；`Proposed` 表示尚待评审或验证。

## 1. 产品愿景

Omnia Agent v5 是一个本地优先、契约驱动、模板优先、功能包隔离的桌面工作台。它让用户从稳定、最多三级的功能树进入真实业务能力，上传资料、查看后台真实进度、复核可追溯差异，并在明确确认后通过 Connector 安全访问 Omnia。

成功不以“页面看起来完整”为标准，而以一条真实闭环可被证明为标准：

```text
真实功能注册
  → 真实资料接收
  → 后台持久化 Run
  → 隔离 Feature Worker 处理
  → 真实验证/人工确认
  → Connector 受控执行（如需要）
  → 写后读回与 Evidence
  → 可下载 Artifact 或明确失败状态
```

## 2. 产品原则

1. **Remote-only Connector**：只维护一个桌面 Shell 和一条 Remote Connector 产品链；Shell 不提供 Local Transport、模式切换或 Local fallback，公司电脑 Remote Connector 是唯一 Omnia Session owner。
2. **后台唯一事实**：刷新、重启、多窗口都从后台恢复；前端内存状态不得冒充任务事实。
3. **真实入口**：按钮、菜单、统计、筛选、搜索、导出和详情入口只有在真实后端、真实数据或真实状态逻辑闭环存在时才开放。
4. **安全写入**：所有 Omnia mutation 必须预检、冻结计划、明确确认、幂等、使用并发令牌并写后读回；`uncertain` 禁止自动重试。
5. **模板优先**：缺失不等于默认；全默认也必须生成 Run 专属不可变副本和 provenance；一般场景只应用白名单最小 Patch。
6. **故障可见**：连接或模块故障必须明确显示，不静默 fallback，不用前端计时器制造成功进度。
7. **最小权限**：前台、Feature Worker、后台和 Connector 按合同交换最少数据，秘密不跨越其所有权边界。
8. **实现可追溯**：每个 Feature 的每个能力都记录 Delivery、Execution、Control & Data、Integration 四 Plane 的实际实现；代码与项目文档同版本安装、升级和回滚。
9. **管理内容可复用**：Agent 创建、修改或删除的对象、关系和关键业务字段由后台保存当前已验证投影与不可变变更历史，供 Phase 2 等后续能力通过合同读取。
10. **权威层级**：Workspace 归属只使用 Omnia 返回的 Section/部分与 Workspace 不可变身份；禁止用 `TEST`、`20000`、`IT Elements` 或其他显示名称猜分类。

## 3. 用户与角色

| 角色 | 主要目标 | 权限边界 |
|---|---|---|
| 业务用户 | 选择功能、提交资料、复核差异、确认执行、取得成果 | 不接触数据库、密钥、内部路径或任意 Connector 命令 |
| 模板/规则负责人 | 审核场景、模板、默认规则、白名单 Patch 和校验器 | 用户本人或持有该用户针对精确 TemplateVersion/digest 的单次授权的 Codex 可发布；记录授权/签名/validation/Evidence；不能原地修改已发布模板 |
| 本机管理员 | 管理官方签名功能包、配置 Provider、从 Connect 流程诊断/修复 Remote binding、checkpoint/恢复、查看脱敏诊断 | 管理操作必须审计；不能读取明文 Key/Connector credential、导入第三方/未签名包或关闭安全门禁 |
| 开发/发布人员 | 构建签名包、运行合同测试和真实 canary | 不因开发便利绕过签名、确认、对账或数据隔离 |

本地单用户形态不等于“无授权”。管理员能力与普通业务入口仍必须在合同和审计上区分。

## 4. 范围

### 4.1 v5 产品范围

- Windows 本地桌面 Shell；
- 服务端驱动、最多三级且允许二级直接作为 Feature 的功能树；
- 三列主界面：应用 Rail、Feature 树、聊天与交付工作区；
- 首批“其他”模块下的新建与关联、删除元素、删除聊天记录和录制；
- 资料上传、quarantine、Run 状态、确认、Artifact 交付；
- 隔离 Feature Package 的安装、启停、升级、回滚和健康；
- Feature 文档清单、四 Plane 实现映射、Documentation Registry 和已安装文档索引；
- Core DB、模块私有数据域、Artifact/Secret/Evidence Store；
- Agent Managed Content Registry/Store：对象、关系、RAIT/Factors 等类型化业务字段的 current/revision/change/tombstone；
- 权威 Workspace 轻抓取（Section + Workspace）和按 Feature/选定 Workspace 有界的重抓取（Section + Workspace + 必要元素）；
- 模板目录、场景选择、Run 专属模板实例和最小 Patch；
- DeepSeek 与 OpenAI-compatible Custom Provider 配置；Nova 协议验证暂缓，未来实测后再决定专用 adapter；
- 唯一 Remote Connector Transport；没有 Shell Local Transport、Local 子进程、模式切换或 fallback；
- 顶部 Connect 中的首次一次性链接码、长期受保护设备 binding、撤销、重新配对和 Remote Pack Connect 状态机；
- Remote Connector 的签名分层在线升级：优先独立升级 Operation Module，必要时安全升级 Connector Core；
- 仅从官方受控发布服务取得并激活官方签名的 Feature/Operation 包；首版不开放第三方或任意离线包导入；
- 程序 release 与可变 data 在同一稳定产品根内分离；更新不得覆盖 data，Secret 使用 Windows 保护且迁机后重新配置；
- 统一 Run/Step/Event/Lease/Confirmation/Artifact 合同；
- 签名受限的 Connector Operation/Capability Module；
- 真实状态、审计、诊断、备份恢复和发布门禁。

### 4.2 非目标

- 面向用户维护一套独立在线版产品；
- Shell 内置 Local Connector、Local/Remote 双模式、隐藏 Local fallback 或 Connector 设置子菜单；
- 延续 v4 的多 Agent、Employee、Group Room 或“+ 添加 Agent”信息架构；
- 通用低代码工作流设计器、任意脚本执行或任意 HTTP 代理；
- 让前台解析 Excel/PDF/Word、直接调用 AI、直连数据库或 Omnia；
- 让 Connector 决定模板、运行 AI 或编排业务流程；
- 让每个新 Feature 都升级整个 Connector，或通过任意 URL/脚本实现在线更新；
- 在“新建与关联”已批准的窄范围之外提前迁入完整 v4 Phase 1、Phase 2、Controls 或 EMS；
- 用 mock/sample/hardcoded 业务数据制作“可用”入口；
- 一次性原样搬迁 v4 巨型 server、UI、Connector Gateway 或 settings 大 JSON。
- 把 Agent Managed Content Registry 做成 Omnia 全量镜像、任意 JSON 数据湖，或用本地投影替代危险操作的实时 Omnia 预检。
- 用名称/编号正则推断 Workspace 所属部分，或把重抓取做成全 Pack 无界 dump。

### 4.3 首个交付：Shell Baseline

首批业务 Feature 开发前，先交付一个不内置业务功能的真实 Shell Baseline：

- 包含三列 Shell、Core、Feature Registry、Package Manager、Documentation Registry、Managed Content Registry、公共合同、Store/Broker、真实健康与诊断；
- 包含本地会话/聊天和 FeatureContext 的真实基础状态；没有真实 Provider 时不得生成模拟 AI 回复；
- 未安装 Feature 时，第二列显示 Registry 的真实空状态，不硬编码录制、删除或新建菜单；
- 未安装业务 Feature 时，Managed Content Registry 为空，不预置 APP/DB/GRA 或 RAIT/Factors 样例记录；
- 设置、诊断、缩放、Splitter 和包管理操作必须接真实 Core action/data/state；
- 不包含四个首批 Feature 的业务 Worker、业务 UI、私有 migration 或 Connector Operation；
- 该交付用于验证独立包平台，不得宣传为已经具备首批业务能力的完整产品。

随后按“录制 → 删除元素 → 删除聊天记录 → 新建与关联”逐个安装独立签名 Feature 包。每个包必须独立启停、升级、回滚、恢复，并证明不影响 Shell 和已安装的其他包。详见 [ADR-0022](../adr/0022-shell-first-independent-feature-packages.md)。

## 5. 核心用户旅程

### 5.1 首次启动

1. 本地应用启动后台并读取持久配置；没有有效 Remote binding 时保持真实 `unpaired`，不启动 Local Connector。
2. 后台验证 Core DB、Secret Store、Artifact Store、模块 registry、Bridge 配置和已有 Remote binding；只有实时验证后才投影在线状态。
3. Shell 获取真实功能导航快照；只有 `installed + enabled + compatible + healthy + authorized` 的叶子可进入。
4. 任一必要组件失败时，显示真实失败原因和可执行的诊断/修复入口；不得展示虚构业务结果。

### 5.2 安装首个独立 Feature 包

1. 干净 Shell 从后台读取空 Feature Registry，业务树没有硬编码叶子。
2. Package Manager 从官方受控测试/发布源取得官方签名候选包，验证签名、hash、SBOM、publisher sequence、合同和平台兼容。
3. 安装器验证 Feature 文档 manifest、必备文件、四 Plane 实现映射、digest、链接、敏感信息和安全渲染，并暂存不可变候选文档。
4. 候选只迁移自己的私有数据域，并在隔离 Worker 中通过健康和合同测试。
5. 单一 activation record 同时绑定 Feature/Documentation 的 active 版本后，两个 Registry 投影同一发布事实；Shell 再读取导航和项目文档索引，对应叶子才出现。
6. 禁用、升级、回滚或候选失败时，其他 Feature 和 Shell 继续运行；UI 显示真实包状态和原因。

生产首版只接受官方签名包，不开放第三方或任意手工离线导入。未来可兼容官方签名离线包，但必须另行评审管理员导入与撤销合同；测试入口不得接受任意未签名包。

### 5.3 执行一个功能

1. 用户从二级或三级 Feature 叶子进入结构化工作区。
2. 前台从后台读取该 Feature 的版本化输入合同和当前真实状态。
3. 用户上传文件；前台只传输字节流和用户声明。
4. 后台创建持久 Run、Artifact 元数据并将文件置于 quarantine。
5. 解析 sandbox 与 Feature Worker 处理，事件持续落库；前台订阅或重读事件。
6. 若可全默认，后台仍创建不可变模板副本和 provenance；若有差异，仅应用白名单 Patch。
7. 结构、业务、视觉验证通过后，用户查看真实差异和证据。
8. 不需要 Omnia 写入时交付 Artifact；需要写入时进入明确确认流程。

### 5.4 Omnia 写入与不确定结果

1. 后台实时只读预检目标，冻结身份、作用域、并发令牌、计划摘要和安全锁。
2. 用户看到具体目标、影响和 diff 后确认；确认有期限且只绑定该计划摘要。
3. 后台经当前 active Transport 提交幂等 Connector Command。
4. Connector Operation Module 执行 allowlisted 操作并从 Omnia 重新读取。
5. 证据完整才成功；提交后断线或无法证明结果时进入 `uncertain`。
6. 创建/修改/删除经读回证明后，后台追加 Managed Content revision/change 并原子推进 current；删除写 tombstone。
7. `partial/uncertain` 只更新已证明部分，计划值不能写成当前值；Phase 2 遇到不新鲜或未解决状态时失败关闭。
6. `uncertain` 时禁止自动重放，禁止切换 Transport；用户只能启动只读 reconcile。
7. 对账证明已应用则原命令/Run 成功；证明未应用则原命令转为 `closed_not_applied`、Run 转为 `failed`，任何重试都必须形成新 Run、新计划、新确认和新命令。

### 5.5 Remote 首次配对、恢复和解除绑定

1. 用户第一次点击顶部 Connect；Shell 发现没有有效 Remote binding，创建短期 pairing session 并展示一次性链接码。
2. 用户在公司电脑 Remote Connector 输入该码。Bridge 校验产品、协议、角色、expiry 和单次消费；禁止匿名 discovery 或候选设备枚举。
3. Connector identity、版本、协议和健康验证成功后，Bridge 激活 `pairId + generation`；Connector 以 DPAPI CurrentUser 保存设备 credential，Shell 以 safeStorage/实例加密保存 Shell credential。
4. 后续 Shell、Connector、Bridge 普通重启或网络恢复自动复用 binding，不再次显示链接码。实时健康未恢复前不得因 token 存在显示 connected。
5. 用户在 Connect 错误/详情流程明确确认“重新配对”时建立 candidate；candidate 失败保留旧 active，成功才原子切换并撤销 previous generation。
6. “解除绑定”只撤销 Connector identity/credential，不删除聊天、Feature、Evidence、附件、文档或其他用户数据。
7. credential 被撤销、不可恢复或设备重装时显示 `repair_required`；不得无限重试旧 token，也不得 fallback Local。

### 5.6 Remote Connector 在线升级

1. 后台从官方受信发布服务自动取得并验证签名更新 offer，显示当前版本、目标版本、更新层级、真实状态和阻断原因。
2. Remote Connector Supervisor 在 inactive slot 下载并验证产品、通道、平台、签名、hash、SBOM、兼容范围和单调 sequence。
3. 业务变化优先安装 side-by-side Operation Module；活动 Run 固定旧版本，新 Run 才使用健康的新版本。
4. 只有 Transport、Session、Gate、安全边界、受控 SDK 或基础兼容变化时才升级 Connector Core。
5. Core 候选独立健康后等待真实安全窗口并自动激活；在途 mutation、未解决 `uncertain`、Artifact 上传或状态未知会阻断激活。
6. 原子切换后重新验证 Connector 身份、Session/Engagement、capability 和 active lease，再恢复 Remote 命令领取。
7. probation 失败恢复 previous，但不重放 Omnia mutation、不降低发布 sequence，也不自动 fallback 到 Local。

默认策略固定为 `automatic_safe_window`：服务器自动下发，Remote Connector 自动取得/验证，在真实安全窗口自动激活。签名、A/B、probation、回滚以及 active mutation/`uncertain` 阻断均不可关闭；更新失败保持 Remote 并恢复 previous，不切 Local。

高危/严重更新到达签名 offer 的 `newRunStopAt` 后停止新的高风险 Run；到达 `maxDrainUntil` 仍不得强杀或重放已提交 mutation。完整策略见 [ADR-0028](../adr/0028-remote-automatic-safe-window-rollout.md)。

### 5.7 Workspace 轻抓取与重抓取

1. 进入需要 Workspace 的 Feature 时先执行轻抓取：从当前 Pack 权威读取 Section/部分及其直接 Workspace identity、实时名称、层级和最小 capability。
2. 安全锁和 Workspace 选择只使用轻抓取；没有权威父级 identity 时显示“无法取得权威层级”并失败关闭，不用名称猜测。
3. 删除、新建元素、关联或编辑底稿需要元素目录时，再对用户选定 Workspace 执行重抓取。
4. 重抓取只读取当前 Feature capability 声明的元素类型和必要字段，必须分页、可取消、可观测并有 deadline；禁止默认爬完整 Pack 的全部正文/关系。
5. 历史读取结果可以带新鲜度复用，但 Sync 只是可选性能优化。生成 mutation 计划和提交前仍分别执行窄范围实时检查。
6. Remote Worker 的 `WorkstationOmniaSession` 使用同一签名 profile、scope、分页、Evidence 和错误合同；Shell 不实现第二套本地读取。完整决定见 [ADR-0025](../adr/0025-authoritative-light-heavy-workspace-reads.md)与 [ADR-0035](../adr/0035-remote-only-connector-and-link-code-pairing.md)。

## 6. 前台信息架构

### 6.1 最多三级的混合深度功能树

功能路径规则：

```text
一级：业务域
├─ 二级：Feature 入口
└─ 二级：能力组
   └─ 三级：Feature 入口
```

一级只能是分组；二级可以直接是 Feature，也可以是确有多个相关能力的分组；三级只能是 Feature。禁止第四级，不为单一业务入口强行制造二级分组。

实际节点必须全部来自后台 `FeatureNavigation` 合同，不在前端硬编码尚未交付的业务功能。Feature 是否可运行由 `kind=feature` 和真实可用状态决定，不由它位于二级还是三级决定。应用 Rail 只保留底部“设置”；系统设置、诊断和模块管理若有真实 owner，则位于设置 Surface 的真实菜单中，不冒充业务 Feature。

首批树结构见 [首批 Feature 范围](INITIAL_FEATURE_SCOPE.md)：

```text
其他
├─ 元素管理
│  ├─ 新建与关联
│  └─ 删除元素
├─ 删除聊天记录
└─ 录制
```

“删除元素”只是“删除安全锁内元素”的用户可见名称调整，后台安全锁边界保持不变。

首批开发顺序固定为“录制 → 删除元素 → 删除聊天记录 → 新建与关联”。“新建与关联”作为第四项完成首批四 Plane 综合验收；它的首个 canary 只开放同一 Workspace 中的一个 Generic Application、一个 Generic Database、两个 GRA core 和唯一 DB → APP 关系，其他对象、Risk/Control 后处理和关系按 capability matrix 逐类开放。

每个叶子至少由后台给出：

- `featureId`、`featureVersion`、稳定节点 ID、层级/parent 与本地化 label；
- `route`、`availability`、`healthReason`、`requiredPermissions`；
- 当前合同版本、是否需要上传/确认/Connector/AI；
- `stateVersion`，用于刷新与防止陈旧点击。

### 6.2 可用性决策

| 后台事实 | UI 行为 | 是否可点击 |
|---|---|---|
| 未安装 | 默认不显示；模块管理可显示真实 catalog 记录 | 否 |
| 已安装但禁用 | 树可按用户设置隐藏或显示禁用原因 | 否 |
| 不兼容/签名失败 | 显示安全失败；不得提供绕过入口 | 否 |
| Worker 不健康 | 禁用并显示最新真实健康原因与时间 | 否 |
| 未授权/缺 Provider/缺 Capability | 禁用并显示缺失依赖 | 否 |
| 健康且依赖满足 | 进入真实后端工作区 | 是 |
| 后端状态未知 | 显示“状态未知/需刷新”，不得乐观开放 | 否 |

搜索、筛选、统计卡、导出和详情必须遵守同一规则：没有可查询的真实 API、权限、空状态、错误状态和测试闭环就不实现；可延期项应隐藏或明确“未开放”，不能做成可点击假入口。

### 6.3 删除“+ Agent”

- Shell 不提供添加 Agent、选择 Agent profile 或删除 Agent 的入口。
- 新 Run 由 `featureId + sessionContext` 创建，不依赖用户可见 Agent Room。
- 如内部需要会话上下文，后台将其建模为不可直接管理的 Session/Run 关联，不复活多 Agent 产品概念。
- v4 历史 Agent/Room 首版不迁移、不投影到 v5 导航；以后仅在用户点名该数据类别时只读打捞。

### 6.4 三列与聊天

- 第一列为最小固定宽度的应用 Rail，只保留 OA 品牌标识和底部设置；删除首页以及“其他 / 删除元素”等全部业务入口，第一/第二列之间不提供 Splitter。
- 连接、刷新、保活、当前 Pack 和安全锁位于跨第二/第三列的固定顶部会话状态栏；全局缩放仍在右上角，设置不在右上角重复出现。
- 第二列只容纳后台驱动、最多三级且允许二级/三级 Feature 叶子的纯功能树；顶部会话栏下直接开始树，不显示功能标题、副标题或产品版本栏。
- 点击可用 Feature 叶子后默认打开或聚焦第三列 docked Feature 标签；用户可通过 `↗ / −` 把同一 Surface 弹出或最小化为独立窗口，主 Shell 不导航离开。
- 第三列永久保留不可关闭的 `Comments` 和底部聊天输入区；Feature 标签占用原聊天记录区域。Comments 保存上传、进度、唯一确认卡、结果和 Artifact 交付。
- 第三列不设置独立“Omnia Agent / 聊天说明 / AI Provider”标题横栏；Global Session Bar 下直接进入 Comments/Feature 标签栏。AI 配置状态进入设置和真实请求错误。
- 第三列标签栏最左侧提供参考 v4 的功能栏折叠按钮；折叠第二列时其 Splitter 同时归零，按钮仍可展开并真实持久化状态。
- 选择 Feature 后建立后台持久的 `FeatureContext`，不把聊天文字直接当作业务状态或写入授权。
- 不新增永久第四列；完整布局、坐标语义和状态规则见 [主界面 UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md)。
- docked/detached Feature Surface 使用隔离 sandboxed renderer/WebContents，读取同一后台 FeatureContext/会话快照并继承全局缩放，但不复制连接控件、Pack 卡或删除确认；状态漂移时只读阻断并重新 bootstrap。

### 6.5 删除元素的简洁交互

- 删除工作台保留 React 组件架构，位于隔离 Feature Surface，默认 dock 在第三列标签中，只承担真实目录、搜索、选择和创建计划；
- `Comments` 消息卡是删除确认、进度、终止和结果的唯一交互位置；创建计划后自动切到该卡；
- 不在 docked/detached 删除 Surface 或第二列重复展示第二套计划/确认界面；
- 删除计划进入终态后自动绕过陈旧缓存并重新读取真实元素目录；
- 删除模式采用紧凑两栏并移除常驻“待删除元素”篮子；底栏显示数量，完整清单在确认消息卡复核；
- UI 简化不得改变后台安全锁、计划 digest、一次性确认、Connector Gate、写后验证或 `uncertain`。

## 7. 紧凑桌面 UI 要求

“Navicat 式”只描述信息密度和树形工作方式，不要求复制其品牌或视觉。

| 领域 | 要求 |
|---|---|
| 密度 | `Proposed`：正文 12–13px、树行 24–28px；最终值待 Windows 100%/125%/150%/200% 缩放可用性基准测试 |
| 布局 | 最小固定宽度 Rail + 可折叠/调整的第二列纯功能菜单 + 第三列 Comments/Feature 浏览器式标签；Feature 可主动弹出/最小化；只持久化允许调整的边界与折叠状态 |
| 层级 | 依靠缩进、展开箭头、图标、分隔线和选中态；避免大标题和装饰性卡片 |
| 键盘 | 树支持上下、左右展开折叠、Home/End、Enter；Tab 顺序稳定，危险确认不得只靠颜色 |
| 焦点 | 所有交互有可见焦点；弹窗关闭后焦点回到触发点 |
| 状态 | loading/empty/disabled/error/uncertain 均来自后台并有文本说明 |
| 无障碍 | `Proposed`：以 WCAG 2.2 AA 为目标；具体桌面控件适配待可访问性验证 |
| 持久化 | 展开节点、列宽、最近 Feature 可持久化；不得持久化上传内容、Key 明文或伪造 Run 状态 |

### 7.1 全局界面缩放

- 所有一级界面和独立工具窗口右上角显示统一的 `− 百分比 +`；
- 调整字体、行高、图标、间距和控件的整体视觉比例，不改变 Windows 窗口物理尺寸；
- 弹窗、消息卡和子面板继承全局值，不重复增加控制；
- 设置由后台 UserPreference service 持久化，修改后同步全部已打开窗口并在重启后恢复；
- 首次为 100%；100% 本身仍使用紧凑设计；
- Artifact、模板、导出文档和 Omnia 页面不随 UI 缩放；
- 精确范围和技术实现见 [全局界面缩放控制](GLOBAL_UI_SCALE.md)与 [ADR-0016](../adr/0016-global-ui-scale-control.md)。

### 7.2 功能分区边界可调整

- 每两个相邻、长期存在且承担不同功能的区域之间提供统一可拖动边界；
- 第一列为明确的最小固定宽度系统 Rail，是上述规则的产品级例外；第一/第二列之间没有 Splitter；
- 主界面只允许第二列/第三列 Tabbed Host、活动标签内容/聊天输入区以及 Feature Surface 内部长期并列或上下分区使用公共 Splitter；第二列折叠时其 Splitter 同时禁用；
- 支持鼠标、触控板、方向键、Home/End 和双击/Enter 恢复默认；
- 每个区域有最小/最大尺寸，危险确认、状态和错误原因不能被拖动隐藏；
- 拖动中只做视觉 preview，释放后通过后台 LayoutPreference 真实持久化；
- 保存失败恢复上次确认布局，重启后恢复最后一次成功值；
- 布局比例、全局 UI scale 和窗口大小是三个不同状态，不能相互覆盖；
- 完整设计见 [统一可调整分区系统](RESIZABLE_LAYOUT_SYSTEM.md)与 [ADR-0017](../adr/0017-unified-resizable-layout.md)。

### 7.3 设置两列

- 设置 Surface 使用两列：左列为真实设置菜单，右列为当前设置的具体内容；保留 AI、安全锁等具有真实 Core action/state 的设置。
- 设置中不得存在 Connector 子菜单、Local/Remote 按钮、Bridge URL、候选 Connector ID、查找/匹配或 Pair ID；首次/重新配对和解除绑定只从顶部 Connect 流程进入。
- 两列分别拥有独立 overflow/滚动容器，滚动互不影响。
- 两列边界使用公共 `settings.main` Splitter 并持久化；这一规则不改变主 Shell 第一列的最小固定宽度。
- 没有真实读取、保存、测试和错误状态合同的设置项不得做成可点击菜单。
- 详细规则见 [主界面 UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md#36-设置界面双列独立滚动)。

## 8. 功能性验收标准

### 8.1 入口真实性

- [ ] 删除所有“+ Agent”及相关 profile 创建入口。
- [ ] 业务叶子只由真实模块 registry 生成。
- [ ] 第二列叶子通过受控 SurfaceHost 默认打开/聚焦真实 docked Feature 标签；`↗ / −` 才迁移为独立窗口，视觉嵌入不合并 Feature 与 Shell 的 renderer/DOM/CSS/Store。
- [ ] 每个开放按钮至少有成功、空、权限不足、后端失败、重启恢复测试。
- [ ] 统计/筛选/搜索/导出/详情若存在，使用真实数据查询并有分页、权限与错误合同。
- [ ] 禁用原因来自真实 health/dependency 状态，不写前端固定“稍后再试”冒充诊断。
- [ ] 所有一级界面右上角的缩放控制接入真实 UserPreference，并跨窗口、跨重启一致。
- [ ] 除最小固定宽度的第一列外，所有允许调整的相邻长期功能区域使用统一 Splitter，并接入真实 LayoutPreference。
- [ ] 已安装 Feature 文档索引由 Documentation Registry 生成；未安装、未激活或版本不匹配的包不得显示为当前实现。

### 8.2 运行闭环

- [ ] 上传进入 quarantine；前端包中无业务解析、AI Provider 或 DB 客户端。
- [ ] Run、Step、Event 在执行前持久化，刷新和重启可恢复。
- [ ] 模块崩溃不使其他模块失去服务；其自身 Run 得到明确可恢复状态。
- [ ] 输出 Artifact 可追溯到输入、模板、Patch、模块和验证器版本。
- [ ] 验证失败时失败关闭，不交付“尽力而为”的成果。
- [ ] 每个 capability 有四 Plane 实现映射，且 action/schema/operation/migration/test ID 与包内容双向一致。
- [ ] Feature 安装、升级和回滚时，代码、合同与项目文档版本原子一致；历史 Run 可打开其冻结版本文档。
- [ ] Agent 创建/修改/删除对象或关系后，Managed Content current、revision、change、关系和 Evidence 与真实读回一致。
- [ ] RAIT、Factors Considered 等后续 Phase 2 所需字段通过类型 Schema 保存并有 provenance。
- [ ] 删除写 tombstone；partial/uncertain 不覆盖最后已验证 current；投影提交失败不重放 Omnia mutation。
- [ ] Phase 2 只通过版本化查询读取，并根据 schema、freshness 和 unresolved change 失败关闭。

### 8.3 Connector 与写入

- [ ] Shell 只有 Remote Transport；构建、进程、IPC、设置和运行时不存在 Local adapter、Local 子进程、模式切换或 fallback。
- [ ] 首次链接码短期、单次、角色/会话绑定且不落日志；匿名调用者不能枚举或自动认领 Connector。
- [ ] 配对后 Shell/Connector/Bridge 普通重启和网络恢复不要求链接码；撤销/凭据不可恢复进入 `repair_required`。
- [ ] 重新配对 candidate 失败保留旧 active，成功后 previous generation 失效；解除绑定不删除其他用户数据。
- [ ] Bridge WSS、Connector online、browser/CDP、Authorization、Engagement 和 Pack hierarchy 分开验证；不得仅凭 token 或 socket 显示 connected。
- [ ] 故障明确失败且不静默 fallback；在途 mutation 或未解决 `uncertain` 继续遵守禁止重放和只读 reconcile。
- [ ] mutation 完成预检、计划冻结、确认、幂等、并发令牌和写后读回。
- [ ] `uncertain` 不自动重试，只允许只读 reconcile。
- [ ] 真实 Omnia canary 经 Shell → 后台 → Feature → Connector → 已登录 Omnia 会话完成。
- [ ] Remote Connector 可在线升级 Operation Module 和 Core；默认优先模块升级，安全窗口、A/B、probation、回滚和不 fallback 均有真实状态。
- [ ] 轻抓取只返回权威 Section + Workspace；重抓取仅覆盖选定 Workspace 与 Feature capability 声明的元素，且分页、可取消、可观测。
- [ ] 同名 Workspace、Pack 改名和缺失父级 identity 不触发名称推断或历史分类复用。
- [ ] Remote Connector 自动取得官方更新并仅在真实安全窗口激活；任何 active mutation/`uncertain` 都保持阻断。

### 8.4 AI 设置

- [ ] 设置真实展示 provider、Base URL、模型来源/选择和测试连接结果。
- [ ] DeepSeek 新配置默认使用 `deepseek-v4-flash`；`deepseek-chat/deepseek-reasoner` 不再作为可用默认模型。
- [ ] 调用显式声明 thinking 模式；普通聊天默认关闭，复杂任务由 capability 显式开启并只提交 `low|high|max`。
- [ ] `/models` 未返回所选模型时不得进入 ready；`finish_reason=length`、空 content 或未知 tool call 不得记作完整成功。
- [ ] DeepSeek 图片只保存在本地并明确标记未送入模型；验证后的文字文件可转换为文字输入。
- [ ] Key 保存后不回显，前端和 Feature Worker 从不持有明文。
- [ ] 模型发现失败时可手工填写模型 ID并标记为 manual。
- [ ] Custom endpoint 通过 SSRF、DNS rebinding 和 metadata IP 防护。
- [ ] Nova 未验证前不展示为已兼容。

DeepSeek 正式版合同差异与实施清单见 [DeepSeek V4 Flash 官方 API 差异评审](../reviews/DEEPSEEK_V4_FLASH_API_REVIEW.md)。

## 9. 非功能验收摘要

- 安全、可靠性和隐私门禁见 `../operations/SECURITY_RELIABILITY_TESTING.md`。
- 性能与容量数字均需通过代表性模板、Artifact 和 Omnia 环境基准测试后冻结；文档中的未测数字不得变成营销承诺。
- 安装、升级、回滚不得丢失 Core DB、模块私有数据、Artifact、模板或 Evidence。
- 程序 release 与稳定 `data` 根分离；更新、回滚和清理旧 release 不得覆盖或删除 `data`。
- 含客户正文的 Store/Artifact 使用实例 DEK 静态保护，DEK 由 Windows Secret Store 包装；复制便携根不能直接绕过保护。
- 当前无公司级保留期限；默认不按年龄自动删除业务数据，用户显式清理且引用/`uncertain` 可阻断物理删除。
- 目标设备为普通 Win10/Win11 ThinkPad；生命周期、ESU 和补丁状态用于兼容性/风险提示，不作为统一安装、连接或使用门槛。最低/推荐配置通过代表性真机测试形成建议值。
- 诊断包仅包含 allowlist 字段和逻辑标识，不泄露本机绝对路径、Key、Cookie、客户正文或生产私密信息。

## 10. 已确认的产品决定

| 编号 | 决定 | 状态 |
|---|---|---|
| P-01 | 主界面保持三列，第三列保留聊天 | Accepted，见 ADR-0010；列职责更新见 ADR-0032 |
| P-02 | 首批为新建与关联、删除元素、删除聊天记录、录制 | Accepted，见 ADR-0018 |
| P-03 | Remote Connector 面向全部版本；2026-08-03 起进一步收敛为唯一 Transport | Accepted；ADR-0008 的双模式部分由 ADR-0035 取代 |
| P-09 | Nova 协议当前不验证，不阻塞首批范围 | Deferred，见 ADR-0013 |
| P-11 | 开发顺序为录制 → 删除元素 → 删除聊天记录 → 新建与关联；第四项完成四 Plane 综合验收 | Accepted，见 ADR-0021；新建与关联范围/canary 见 ADR-0018 |
| P-13 | Remote Connector 保留分层在线升级能力，并尽量少升级 Core | Accepted，见 ADR-0019 |
| P-15 | 功能菜单最多三级，二级或三级均可作为 Feature 叶子 | Accepted，见 ADR-0020 |
| P-16 | 先交付无业务 Feature 的真实 Shell Baseline，再按既定顺序用四个独立 Feature 包验证安装、隔离、升级和回滚 | Accepted，见 ADR-0022 |
| P-18 | 每个 Feature 记录各 Plane 的实际实现；安装 Feature 时将其签名文档原子发布到项目 Documentation Registry | Accepted，见 ADR-0023 |
| P-19 | 后台保存 Agent 创建、修改、删除内容的当前投影和不可变变更登记，供 Phase 2 等后续能力读取 | Accepted，见 ADR-0024 |
| P-04 | 生产只允许官方签名 Feature/Operation 包；首版无第三方或任意离线导入，未来仅可兼容官方签名离线包 | Accepted，见 ADR-0026 |
| P-05 | 无公司保留规定；数据集中在产品根的独立 `data`，默认不按年龄删除，Secret 由 Windows 保护，更新不得覆盖 data | Accepted，见 ADR-0027 |
| P-06 | 模板由用户本人或经其单次授权的 Codex 发布；记录请求者、发布者身份、精确 digest、签名、validation 和 Evidence；首版不强制双人审批 | Accepted，见 ADR-0029 与模板管线 |
| P-07 | v5 首版不迁移 v4；需要时只读、按数据类别打捞 | Accepted，见 ADR-0027 与迁移路线 |
| P-08 | 支持安全更新期内的 Windows 11，以及仍受支持 LTSC 或有效 ESU/补丁达标的 Windows 10 普通 ThinkPad；最低配置由 D5 冻结 | Accepted，见 ADR-0027 |
| P-14 | Remote Connector 由服务器自动下发更新，并在真实安全窗口自动激活；安全阻断不可关闭 | Accepted，见 ADR-0028 |
| P-20 | Workspace 读取分权威轻抓取和有界重抓取，禁止显示名称推断，Sync 降级为可选优化 | Accepted，见 ADR-0025 |
| P-10 | 删除聊天正文立即物理删除，无引用聊天专属附件清理；Omnia effect、`uncertain`、共享引用和必要 Evidence 分离保留 | Accepted，见 ADR-0015 |
| P-21 | 删除元素使用紧凑两栏，不保留常驻选择篮；底栏显示数量，右上角消息卡独占确认/进度/结果，终态自动刷新 | Accepted，见删除元素 UX 复核 |
| P-22 | 删除与录制以 v4 固定证据基线启动重新认证，不要求专用 Pack；开放前仍使用届时已有非生产环境做最小当前复核 | Accepted，见 ADR-0030 |
| P-23 | 第一列为只含 OA 与底部设置的最小固定 Rail；顶部会话栏跨第二/第三列；设置采用可调双列独立滚动 | Accepted，见 ADR-0032 与主界面 UI 布局规范 |
| P-24 | 第二列只保留无标题栏的真实功能树；第三列聊天事实和唯一确认保持；连接控件参考 v4 的胶囊/刷新/A 状态；默认 Feature placement 已由 P-25 更新 | Accepted，见 ADR-0033、ADR-0034 与主界面 UI 布局规范 |
| P-25 | 第二列可通过 v4 式按钮折叠；第三列使用固定 Comments + 多 Feature 标签；Feature 默认 docked，支持弹出、转为独立窗口后最小化及关闭 UI 实例 | Accepted，见 ADR-0034 与主界面 UI 布局规范 |
| P-26 | v5 为 Remote-only：删除 Shell Local Transport/子进程/模式设置；顶部 Connect 使用一次性链接码，后续保存长期设备 binding；公司电脑 Remote Connector 独占 Omnia Session | Accepted，见 ADR-0035 |

## 11. 仍待用户确认

| 编号 | 问题 | 决策影响 | 当前状态 |
|---|---|---|---|
| P-12 | 新建与关联 canary 使用哪个非生产 Workspace、模板版本、APP/DB 测试对象和清理 owner？ | 真实 mutation 验收与测试数据治理 | 开发前必须确认 |
| P-17 | “新建与关联”默认文档尚未准备；需完成来源/许可、默认字段、保护区域、Validator、审批和 TemplateVersion 发布 | 第四 Feature 的 DoR、全默认/最小 Patch 和真实 canary | Pending Project；见[默认文档准备项目](../planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md) |
