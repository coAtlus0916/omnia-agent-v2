# Omnia Agent v5 主界面 UI 布局规范

状态：Shell 0.4.2 Remote-only 候选；继承 0.4.1 UI regression 修复，完整 Windows DPI 矩阵与公司电脑真实 Omnia canary 待执行
日期：2026-08-03  
适用范围：Windows 本地主窗口、标签式 Feature Surface、设置 Surface 与可弹出 Feature 窗口；0.4.2 保留 native attachment、Comments/Settings、统一 zoom 和 settings layout，并删除 Connector 设置页/Local 模式，首次配对只从顶部 Connect 进入

## 1. 设计结论

主界面继续保持三列，但重新分配职责：

```text
┌──────┬─────────────────────────────────────────────────────────────┐
│ OA   │ 全局会话状态栏：Connect / 刷新 / A / Pack / 安全锁  − 100% + │
│      ├────────────────────────┬────────────────────────────────────┤
│      │ 第二列：纯功能菜单       │ ☰ │ Comments │ 删除元素 │ 录制     │
│      │ 其他                    ├─────────────────────────── ↗  −  ×┤
│      │ ├─ 录制                │ 当前标签内容占满原聊天记录区域       │
│      │ └─ 删除元素            │ Comments 保存聊天/确认/结果          │
│      │                        ├────────────────────────────────────┤
│ 设置 │                        │        ↕ 可调整聊天输入框高度        │
└──────┴────────────────────────┴────────────────────────────────────┘
       第一列固定最小宽度         ↔ 仅第二/第三列边界可调整

点击 Feature 叶子 → 默认打开/聚焦第三列标签；可主动弹出或最小化为独立窗口
```

- 第一列只保留顶部 `OA` 品牌标识和底部“设置”。删除“首页”，也删除“其他 / 删除元素”等业务导航。
- 第二列只呈现后台注册的纯功能菜单/树和真实可用状态，不内联任何 Feature 工作台。
- 点击功能叶子后，默认在第三列浏览器式标签栏新增或聚焦 Feature；只有用户点击弹出/最小化才迁移为独立窗口。
- 第三列永久保留不可关闭的 `Comments` 标签和底部聊天输入区；Feature 标签占用原聊天记录区域，附件、真实进度、唯一确认卡、结果和 Artifact 归 `Comments`。
- 删除第三列原有的 Conversation Header：不再显示“Omnia Agent”“聊天、确认、进度与文件交付”或右侧常驻“AI Provider 未配置”状态。全局会话栏结束后直接进入标签栏。
- 连接、保活、当前 Pack、安全锁从第二列卡片提升为跨第二/第三列的全局会话状态栏。
- 全局 `− / 百分比 / +` 继续位于主界面右上角；“设置”不再重复出现在右上角。

本布局不新增第四列，不把未实现能力做成可点击入口，也不改变四 Plane 的职责边界。

## 2. 截图坐标到布局语义的映射

用户给出的百分比坐标表示“视觉锚点”，不是固定像素。运行时必须根据窗口大小、Windows DPI、UI scale 和用户保存的 Splitter 比例计算。

| 用户锚点 | 冻结后的布局语义 | 实现要求 |
|---|---|---|
| `x≈5.7%, y≈94%` | 第一列底部设置入口 | 固定在 Rail 底部安全边距内；窗口变高时仍贴底，不能随第二列滚动 |
| `x≈42.6%, y≈3.6%` | 顶部全局会话状态栏 | 状态栏跨第二、第三列；连接、保活、Pack、安全锁保持同一组并始终可见 |
| `x≈21.1%, y≈21%` | 第二列功能菜单区 | 后台驱动功能树直接从顶部会话栏下开始；不显示列标题，也不内联 Feature 工作台 |
| `x≈32.2%, y≈3.1%` | 功能菜单折叠按钮 | 位于第三列标签栏最左侧并紧邻列边界；参考 v4 三横线按钮，折叠后按钮仍可见 |
| `x≈34.3%, y≈8.4%` | 标签栏起点 | 固定 `Comments` 后按打开顺序显示真实 Feature 名称；多个 Feature 通过标签切换 |
| `x≈50.5%, y≈27.1%` | 当前标签内容区 | Feature 默认占满原聊天记录区域，不覆盖顶部会话栏、标签栏或底部聊天输入区 |
| `x≈95.6%, y≈13.2%` | 当前 Feature 窗口动作 | 仅 Feature 标签活动时显示 `↗ / − / ×`；Comments 不显示这组动作 |

在用户截图的约 `1271 × 778` 内容区域中，以上锚点分别落在左 Rail 底部、主内容顶部以及第二列内部；因此应保存的是区域语义和比例，而不是 `72px / 541px / 268px` 等一次性坐标。

## 3. Shell 区域

### 3.1 第一列：System Rail

第一列使用能够完整容纳 `OA` 与“设置”的最小固定逻辑宽度，100% 紧凑基线冻结为 `56px`。它跟随全局 UI scale/DPI 计算实际显示宽度，但用户不能左右拖动，也不保存 Rail 宽度偏好。若目标 ThinkPad 的 Windows 150%/200% 缩放验证发现文本或焦点被裁切，只能通过统一设计 token 迁移修正固定值，不能重新开放用户拖动。

从上到下仅允许：

1. `OA` 品牌标识；非业务导航，不承担“返回首页”动作；
2. 弹性空白区；
3. “设置”按钮，贴底并有文本或可访问名称。

产品表面不得在 Rail 空白区渲染“这里不放首页”“不放功能入口”等竖排或横排解释文字，也不得放设计标注、占位线或教学文案。此类说明只能出现在评审图外的注释层，不能进入最终 UI。

第一列禁止出现：

- “首页”按钮；
- “其他”分组；
- “删除元素”或任何 Feature 叶子；
- Pack、连接或安全锁状态灯；
- 未接真实 action 的占位入口。

设置入口调用真实 `openSettings` Shell action。若设置窗口无法打开，必须给出真实错误；不能只改变选中样式。

### 3.2 顶部：Global Session Bar

全局会话状态栏位于 Rail 右侧，跨第二列和第三列，建议逻辑高度 `44–52px`。它不随功能区或聊天滚动，也不允许 Feature 包覆盖。

推荐从左到右排列：

1. Remote Bridge/Connector 的只读状态；产品没有 Local/Remote 模式切换；
2. 连接主动作与真实连接状态；
3. 刷新会话/Pack 动作，仅在后台允许时启用；
4. 当前 Pack 的真实名称及必要的短 ID；没有权威身份时显示“未读取”或“状态未知”，禁止沿用旧名称；
5. 保活开关/状态及最近成功时间；
6. 安全锁状态与入口；没有连接、Pack 或权威 Workspace 层级时禁用并显示原因；
7. 右侧弹性空间；
8. 全局 `− / 百分比 / +`。

连接、刷新与保活的视觉和状态交互以 v4 的已验证实现为参考基线：

- 三者形成相邻的紧凑水平控件组，顺序固定为连接 → 刷新 → 保活；
- 连接使用圆角胶囊并展示 `Connect / Connecting / Connected`；`Connecting` 时 hover/focus 显示 `Cancel` 并调用真实取消 action，`Connected` 时 hover/focus 显示 `Connect` 并调用真实重连 action；
- 刷新使用紧邻连接按钮的圆形图标按钮，只有真实 refresh operation 执行时旋转；连接或取消不能让刷新图标伪装为刷新中；
- 保活使用紧邻刷新的圆形 `A` 按钮，关闭为灰色，开启为绿色，并用 `aria-pressed` 反映后台已确认状态；未绑定 Pack 且未开启时禁用，busy 时显示真实 busy 状态；
- 当前 Pack 名称使用 v4 `engagementName` 副标题的紧凑语义：已连接为绿色、连接中为琥珀色、未连接为灰色；v5 实际取值必须来自权威 Pack identity；
- tooltip、可访问名称和提示消息全部来自真实连接状态。保活周期不得照抄 v4 文案中的固定分钟数，必须显示 v5 后台当前策略或不显示周期。

推荐做成跨列状态栏，理由是：连接、Pack、保活和安全锁共同描述当前 Omnia 会话，既不属于某个 Feature，也不属于聊天；跨列后，切换 Feature、拖宽功能区或滚动聊天时不会丢失关键上下文，同时与用户给出的顶部锚点一致。

顶部状态栏不得展示由前端计时器或缓存猜测出的“已连接”“当前 Pack”或“安全”。每个值必须带后台 `stateVersion` 或来自同一会话快照。若组成状态来自不同版本，UI 显示“状态更新中”并暂时阻断危险动作。

#### 3.2.1 Connect、首次配对与修复

Connect 是 Remote-only 的单一入口：

- 没有有效 binding 时，点击 Connect 打开首次连接引导，显示由 Bridge pairing session 返回的短期一次性链接码和过期时间；文案明确要求在公司电脑 Remote Connector 输入。
- Shell 不搜索、列出或自动认领 waiting Connector，不显示匿名可见的公司电脑名称/完整 Connector ID。
- pairing matched 后同一流程继续验证 Bridge、Shell WSS、精确 Remote Connector、协议/版本，再发起浏览器 Connect。
- `Connecting` 可持续等待用户在受控 Edge 登录并打开 Pack；Authorization/hierarchy 稍后就绪时自动显示 Connected，不要求第二次点击。
- Connect 错误/详情允许真实“诊断连接”“重新配对”“解除绑定”。重新配对和解除绑定需要明确确认；candidate 失败保留旧 active。
- 连接详情只展示非敏感 identity/version/protocol/generation/freshness。token、链接码历史、poll secret、DPAPI/safeStorage 密文不显示、不复制、不导出。
- revoked 或 credential 不可恢复时显示 `repair_required`；普通 Shell/Connector/Bridge 重启和断网恢复不重新要求链接码。

Bridge reachable、Shell WSS online、Connector online、browser ready、Authorization 和 Pack identity 分别呈现，不能把前一项成功当成后一项成功。顶栏不显示 Local 标签或模式菜单；Remote 故障也不能出现“已自动切换 Local”。

默认使用单行。若当前逻辑宽度不足以同时满足按钮命中区和 Pack/安全锁最小可读宽度，则切换为受控两行：第一行保留 Transport、连接、当前 Pack、安全锁和缩放，第二行放刷新、保活及最近成功时间。关键状态不得折叠到不可见菜单，也不以截断名称冒充完整 Pack identity；完整值通过 tooltip/可访问名称读取。

### 3.3 第二列：纯 Feature 菜单

第二列默认占 Rail 之外可用宽度的约 `30%`，建议逻辑宽度 `280–360px`、最小 `240px`、最大不超过可用宽度 `42%`。它只包含：

- 后台 `FeatureNavigation` 返回的功能树；
- 真实安装/启用/兼容/健康/授权状态与简短禁用原因；
- 展开箭头、缩进、选中/聚焦态和必要的状态图标。

顶部会话栏下方直接开始功能树。第二列禁止显示“功能”“来自已安装 Feature 的真实导航”“v0.4.0”等标题、副标题或版本横栏；产品版本进入设置/关于、诊断或文档索引，不占用功能菜单空间。

第二列也禁止出现目录、表格、筛选、上传准备、计划摘要或其他内嵌 Feature 工作台。叶子点击调用真实 `openFeatureSurface(featureId, contextVersion, placement="docked")` Shell action；打开成功后在第三列新增或聚焦 Feature 标签，失败则在主 Shell 显示真实错误。相同 `featureId + FeatureContext` 已有 docked 标签时激活该标签，已有 detached/minimized 窗口时恢复或聚焦该窗口，不重复创建冲突实例。

菜单规则维持“最多三级”：一级为业务域；二级可直接是 Feature，也可为确有多个能力的分组；三级只能是 Feature。不得为了视觉一致强制补足三级，也不得在前端硬编码未注册菜单。

Feature 的目录、输入、预检、计划创建和结果浏览位于自己的隔离 Surface。默认 placement 是第三列 docked 标签，主动弹出/最小化后才是独立窗口。两种 placement 共享同一 `surfaceInstanceId`、FeatureContext、后台状态和 Feature 自己声明的公共 Splitter；不得修改 Shell 第二列宽度，也不得把 Feature DOM/CSS/Store 直接注入 Shell renderer。

未安装任何 Feature 时，第二列只显示 Registry 返回的真实空状态和可执行的真实安装说明；不得显示可点击的录制、删除、新建等假入口。

### 3.4 第三列：Tabbed Conversation & Feature Host

第三列占剩余空间，垂直分为三个稳定区域：

1. 顶部标签栏：左侧折叠按钮、固定 `Comments` 标签、已打开 Feature 标签；
2. 中部记录/功能区：显示当前活动标签；
3. 底部聊天输入区：始终可见并可上下拖动。

第三列不再有独立标题栏或说明栏。禁止在标签栏上方再渲染“Omnia Agent”、聊天说明、当前 FeatureContext 摘要或 AI Provider 常驻状态；这些内容不能以改名、缩小或合并成细条的方式重新出现。标签栏必须直接贴在 Global Session Bar 下方。

AI Provider 的真实配置状态仍保留在“设置 → AI 设置”。用户实际发送 AI 请求但 Provider 不可用时，由 `Comments` 中与该请求绑定的真实错误消息和发送按钮可用状态说明原因；不得重新增加全局常驻 Provider 横栏。

`Comments` 是首个永久标签，不可关闭、弹出或最小化，显示聊天消息流、附件上传状态、Feature 进度与结果、唯一高风险确认卡及 Artifact 交付。Feature 活动时，中部区域切换为该 Feature Surface 并占满原聊天记录区域；聊天记录仍在 `Comments` 保持挂载，底部输入区不消失。

标签标题来自后台 Registry 的真实 Feature 名称。相同上下文不重复开标签；多标签超过可用宽度时使用浏览器式压缩与水平滚动/溢出访问，不换成多行标签，不挤压右侧窗口动作。切换标签不取消后台 Run，也不把隐藏 Surface 的缓存当成事实。

聊天输入区默认逻辑高度冻结为 `150px`，最小 `88px`，最大为窗口可用高度的 `42%`，具体值由 `LayoutPreference` 约束。拖动中只预览，释放后由 Core 持久化；失败恢复上次确认高度。

第三列聊天不能替代业务状态：消息文字只做呈现；确认、取消、终止等控件必须调用绑定精确 Run/Plan/Confirmation 的真实 action。Feature 主动创建待确认计划时自动切到 `Comments` 并聚焦唯一确认卡；后台异步消息只给 `Comments` 标签增加真实状态标记，不抢走当前 Feature 焦点。

折叠按钮位于标签栏最左侧，语义参考 v4 `sidebarToggleBtn`：展开时可读名称为“收起功能栏”，折叠时为“展开功能栏”，并正确维护 `aria-controls/aria-expanded`。折叠第二列时同时移除第二/第三列 Splitter，第三列扩展到 Rail 右侧剩余宽度；不保留空白占位列。状态由 Core `LayoutPreference` 持久化，默认展开。

### 3.5 Feature Surface、标签与窗口动作

Feature 视觉上可 dock 在第三列，但安全架构不变：

- 每个已安装 Feature 在 manifest 中登记真实 Surface 入口、最小尺寸、合同版本和所需 capability；Shell 不硬编码 URL 或菜单叶子；
- Feature 包运行在 Shell 管理的独立无特权 sandboxed renderer/WebContents 中。docked 只是由 Shell 把隔离 Surface 合成到第三列 viewport，绝不直接 import Feature 包代码或共享 DOM/CSS/内存 Store；
- 标签先显示真实 bootstrap/loading 状态，成功后原子切换到工作台；失败保留明确错误和重试，不显示示例数据；
- 活动 Feature 内容头部右上角显示 `↗` 弹出、`−` 最小化、`×` 关闭。`Comments` 活动时不显示这组三按钮；
- `↗` 把同一 Surface 迁移为正常显示的独立窗口；主标签移除，菜单显示“已在独立窗口打开”。再次点菜单聚焦现有窗口；
- `−` 先把同一 Surface 迁移到独立窗口，待状态接续完成后直接调用 Windows 原生最小化，不能闪现第二套可操作界面；再次点菜单恢复并聚焦；
- `×` 关闭该 Surface UI 实例和标签，不卸载 Feature、不删除数据，也不自动取消已提交 Run。存在真实 dirty 状态时使用统一关闭确认；终止任务必须调用 Feature 内绑定 Run 的 action；
- detached 窗口不复制主 Shell Connect/刷新/保活或确认卡；它读取同一版本化会话快照，右上角继续继承全局缩放；
- 用户退出主应用时关闭全部 Surface。会话、Transport、Pack 或安全锁变化时，docked/detached Surface 都进入只读阻断并重新 bootstrap；孤立窗口不能继续提交 mutation；
- 首次实现不跨应用重启恢复 Feature 标签；重启后只打开 `Comments`。仍在 Core 中运行的任务通过真实消息恢复，不重新执行 mutation。

原生可见性由 Main `SurfaceWindowManager` 协调，而不是 DOM/CSS 层级。任意时刻最多附着一个活动 docked `WebContentsView`；切到 `Comments`、打开 Settings 或其他 Shell modal 时必须移除全部 docked child view。关闭 overlay 返回活动 Feature 时重新附着正确实例并按当前菜单、splitter、viewport 和 zoom 重新计算 bounds。隐藏只改变当前 attachment/visibility，不改变 placement，也不终止 Feature WebContents、Worker 或 Run。标签/窗口关闭、Renderer/Feature 崩溃时清理必须幂等。

### 3.6 设置界面：双列独立滚动

点击第一列底部“设置”后打开设置 Surface。设置不是主 Shell 的第一列，也不能复用固定 Rail 的宽度规则。它使用自己的两列布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ 设置                                                − 100% + │
├───────────────────┬──────────────────────────────────────────┤
│ 左列：设置菜单      │ 右列：当前设置项的具体内容               │
│                   │                                          │
│ AI 设置            │ Provider / Base URL / 模型 / Thinking / Key│
│ 安全锁等真实设置     │ 只呈现具有真实 Core action/state 的内容    │
│                   │                                          │
│     独立滚动 ↕      │                         独立滚动 ↕       │
└───────────────────┴──────────────────────────────────────────┘
                    ↔ 公共 Splitter
```

- 左列只显示有真实页面、真实读取 action 和真实保存 action 的设置入口；保留“AI 设置”、安全锁等真实页面。
- 整个 Connector 设置子菜单已删除：不得显示 Local/Remote、Bridge URL、候选 Connector ID、查找/匹配或 Pair ID，也不得放不可点击占位页。
- 未实现的常规、数据、诊断、更新等页面不得放入可点击菜单；若产品必须告知未来方向，应使用不可点击说明文字，不占用设置导航层级。
- 右列只显示当前选中设置项的真实表单、读取状态、保存/测试结果和错误；切换菜单不会丢失已成功持久化的状态。
- 左列菜单和右列内容必须是两个独立的 `overflow`/滚动容器。滚动右侧长表单不能移动左侧菜单位置；滚动左侧菜单也不能改变右侧滚动位置。
- 左右边界使用统一 `settings.main` 垂直 Splitter，支持 pointer、键盘、恢复默认和真实 `LayoutPreference` 持久化。
- 设置左列不是主 Shell 固定 Rail：设置页的两列可以调整；主 Shell 第一列仍固定最小宽度且无 Splitter。
- 建议左列默认逻辑宽度 `180px`，允许 `140–280px`；右列最小 `420px`。最终值随 Windows/UI scale 验收冻结。
- 设置标题栏右上角保留继承同一 `UserPreference` 的 `− / 百分比 / +`；不再放第二个“设置”入口。
- 设置外框宽高在切换真实子菜单时保持稳定，并按 viewport clamp；短内容不能令外框收缩，长内容只能在右侧内部滚动。左侧导航和右侧内容是两个独立滚动容器。
- 设置导航/内容之间使用 `settings.main` 公共 splitter；pointer、键盘和 reset 均持久化到 Core LayoutPreference。窗口临时变小或全局缩放只做运行时 clamp，不覆盖用户保存比例。
- 密钥输入和 Provider 测试必须调用真实 Core action。首次配对、诊断、重新配对和解除绑定属于顶部 Connect 状态机，不进入 Settings。
- DeepSeek 设置的新配置默认显示 `deepseek-v4-flash`，模型仍需真实 `/models` 验证；Thinking 由显式开关和 `low|high|max` 档位控制，图片与文字文件能力按 [DeepSeek V4 Flash 官方 API 差异评审](../reviews/DEEPSEEK_V4_FLASH_API_REVIEW.md) 如实呈现。

## 4. 删除元素的单点确认

删除元素的目标浏览、搜索、选择和“创建删除计划”位于“删除元素”Feature Surface；默认是第三列标签，用户也可主动弹出/最小化为独立窗口。创建计划后：

1. Shell 自动切换到 `Comments` 并聚焦唯一确认卡；detached 窗口只保留非交互提示和“前往主窗口”真实 action；
2. `Comments` 消息流顶部或当前可见位置出现唯一确认卡；
3. 确认卡绑定真实 `planDigest + confirmationId + stateVersion`；
4. 确认、取消、进度、终止、结果和 acknowledge 都由这一张卡承担；
5. 不在 docked/detached Feature Surface、第二列、弹窗或抽屉再显示第二套确认界面；
6. 删除进入 `completed` 后，后台触发所选 Workspace 的有界重抓取并绕过陈旧目录缓存；删除 Surface 读取新 `stateVersion` 自动刷新目录；
7. `failed / partial / uncertain` 不伪装成功；是否刷新、能否重试和下一动作依据后台终态合同显示。

“右上角消息栏”在本布局中解释为第三列上部的 Agent 消息/确认区域，不是 Windows 标题栏，也不是新的永久第四列。

## 5. 密度与视觉

“Navicat 风格”指紧凑、树状、专业，不复制品牌外观。

| Token/区域 | 100% 建议值 | 规则 |
|---|---:|---|
| 正文 | `12px` | 不用 14–16px 大正文填充桌面工作台 |
| 辅助文字 | `10–11px` | 保持可读对比度，不用浅灰隐藏错误 |
| 区域标题 | `13px / 600` | 避免大号营销式标题 |
| 功能树行高 | `24px` | Windows/DPI 验证后可在 `24–28px` 冻结 |
| 常规按钮高 | `26px` | 危险确认可适当更高，但不全局放大 |
| 顶部状态栏 | `44–52px` | 单行优先；空间不足按已评审策略换行/折叠 |
| 分隔线 | `1px` 可见、`6–10px` 命中 | hover/focus/拖动时增强 |

层级主要通过箭头、缩进、图标、细分隔线、选中态和状态文本表达；减少大面积卡片、重复边框和无意义留白。任何颜色状态必须同时有文本或图标语义。

## 6. Splitter 与响应式约束

`shell.main.v3` 至少定义：

| Splitter ID | 相邻区域 | 默认 | 约束 |
|---|---|---:|---|
| `feature-content` | Feature Menu / Tabbed Content Host | Feature Menu `30%` | 菜单展开时 ≥`240px`；内容区 ≥`420px`；折叠时菜单和 Splitter 均为 `0` |
| `chat-composer` | 活动标签内容 / 输入区 | 输入区 `150px` | 输入区 ≥`88px` 且 ≤可用高度 `42%` |
| `settings-navigation-content` | 设置菜单 / 设置内容 | 菜单 `180px` | 菜单 `140–280px`；内容 ≥`420px` |

第一列与第二列之间只有普通分隔线，没有 Splitter、拖动命中区或宽度偏好。其余 Splitter 共享现有 `LayoutPreference` 语义：pointer preview、释放提交、CAS、跨窗口同步、重启恢复、键盘调整和双击/Enter 恢复默认。拖动不得触发连接、上传、删除或确认。

当主窗口或 UI scale 无法同时满足最小宽度时：

- 第一列保持最小宽度和设置可用；
- 顶部状态项允许优先缩短文本、显示 tooltip 或受控换行，禁止隐藏安全锁真实状态；
- 第二列和第三列采用水平滚动/受控覆盖策略前必须另行做 Windows 验收；
- 不允许关闭 `Comments` 或聊天输入区；第二列只能通过专用折叠动作归零，不能用 Splitter 拖到 0。

## 7. 真实状态与控件映射

| UI | 真实 owner/状态 | 开放条件 | 失败行为 |
|---|---|---|---|
| 设置 | Shell/Core Settings action | 主进程可响应 | 显示真实错误，焦点留在设置按钮 |
| 连接 | `ShellService` / active Transport | 没有阻断中的切换或 mutation | 保留原状态，不静默切换另一 Transport |
| 刷新 | 会话/Pack read action | 已连接且没有互斥操作 | 标记失败与最近成功值，不制造新名称 |
| 保活 | Keepalive state/action | 已连接、Transport 支持 | 显示关闭/失败及后台原因 |
| 当前 Pack | 权威会话快照 | 取得 Pack identity | 未读取/未知；禁止沿用 v4 名称分类 |
| 安全锁 | 权威轻抓取 + lock action | 已连接、Pack ready、Section/Workspace 层级完整 | 禁用并显示缺失条件 |
| 功能树 | Feature Registry/Navigation | 节点真实注册 | 未安装不显示；不健康禁用并显示原因 |
| Feature 标签入口 | Feature Registry + SurfaceHost | installed + enabled + compatible + healthy + authorized + route registered | 禁用或报真实打开错误；不渲染假 Surface |
| Feature docked/detached Surface | Feature Runtime + Core bootstrap | FeatureContext、会话版本与 capability 一致 | 保持加载错误或只读阻断；不使用缓存冒充可运行 |
| 折叠功能栏 | LayoutPreference | Shell 可保存布局版本 | 保存失败恢复后台确认值；不隐藏切换按钮 |
| `↗ / − / ×` | SurfaceHost/WindowManager lifecycle | 当前活动标签为真实 Feature | 迁移/关闭失败保留原 Surface 和真实错误，不创建第二实例 |
| 确认卡 | Confirmation/Run/Event | 精确计划仍有效 | 过期或版本冲突时禁用并重读 |
| 缩放 | UserPreference | Core 可保存 | 恢复后台确认值 |
| Splitter | LayoutPreference | Core 可保存 | 恢复后台确认值 |

## 8. 状态组合

| 会话状态 | 顶部状态栏 | 第二列 | 第三列 |
|---|---|---|---|
| 未配对/未连接 | 显示 Remote unpaired/offline；Connect 进入链接码或现有 binding 验证，保活/Pack/安全锁禁用 | 功能可浏览；依赖 Omnia 的 Surface 入口禁用并说明 | Comments/本地聊天/附件按真实能力开放 |
| 连接中 | 显示 Connecting；hover/focus 可 Cancel | 菜单保持，但依赖连接的 Surface 入口禁用 | 保持当前标签；不虚构成功 |
| 已连接、Pack 未读取 | Pack 显示未读取；允许刷新 | 依赖 Pack 的 Surface 入口禁用 | Comments 说明下一步 |
| 已连接、Pack ready、安全锁未启用 | Pack 显示权威名称；安全锁入口可用 | 可打开只读 Feature；危险 Feature 按 capability 禁用 | 保持聊天 |
| 安全锁已启用 | 显示 Section/Workspace 摘要和版本 | 可打开 Feature；docked/detached Surface 读取同一锁版本 | Comments 确认卡复述同一目标摘要 |
| 状态未知/断线 | 显示未知或断线，阻断新 mutation | 菜单保留，相关窗口入口禁用 | 显示真实失败，允许只读对账入口时才开放 |
| `uncertain` | 阻断切换 Transport 与危险刷新语义 | 不提供原命令重试 | 只显示对账与终态消息卡 |

## 9. 键盘、焦点与可访问性

- 第一列 Tab 顺序为 `OA`（如非交互则跳过）→ 设置；不再经过已删除的首页/业务入口。
- 顶部状态栏按视觉顺序进入焦点，读出当前连接、Pack、保活和安全锁状态。
- 功能树支持上下移动、左右展开/折叠、Home/End 和 Enter；最多三级。Enter 对可用叶子调用真实“打开/聚焦 Feature Surface”action。
- 标签栏使用 `tablist/tab/tabpanel` 语义；左右方向键切换标签，`Home/End` 到首尾。`Comments` 不提供关闭动作；Feature 的 `↗ / − / ×` 均有可读名称。
- 打开设置或确认卡后，关闭时焦点回到触发控件。
- Splitter 使用 `role="separator"` 及 `aria-valuemin/max/now`；聊天输入区的水平 Splitter 有可读 label。
- 缩放至各档位后，键盘焦点、错误文字和危险确认不得被裁切。

## 10. 实施边界

本文件不授权直接修改生产 UI。进入开发时必须按以下顺序：

1. 调整 Shell 布局合同到 `shell.main.v3`，删除旧 Rail Splitter 偏好，迁移有效菜单宽度/输入区高度并新增后台确认的菜单折叠偏好；
2. 将全局会话快照作为单一后台 action/state 接入顶部状态栏；
3. 移除第一列首页和 Feature 导航，同时把设置入口迁到底部；
4. 第二列只接入真实 FeatureNavigation，删除标题栏和所有内嵌 Feature 工作台；
5. 建立 Shell-owned TabbedFeatureHost、隔离 sandboxed Surface、单实例键和真实 bootstrap/恢复合同；
6. 接入 docked/detached/minimized placement 状态机及 `↗ / − / ×` Surface lifecycle；
7. 保持 `Comments`、附件和聊天输入真实链路，Feature 标签打开时不得卸载这些后台状态；
8. 迁移删除元素唯一确认卡并验证 Comments 自动聚焦及 Surface 终态自动刷新；
9. 更新 UI/E2E、标签、弹出/最小化、Windows DPI、键盘、持久化与恢复测试；
10. 通过截图和真实 Omnia 测试后才能重新打包便携版/Feature 包。

禁止在迁移期间用 hardcoded Pack、假连接、假安全锁、假 Feature 或静态成功提示填补缺口。若某项后端合同尚未就绪，入口必须隐藏或禁用并写明原因。

## 11. 验收标准

- [ ] 第一列没有“首页”“其他”“删除元素”或其他业务入口。
- [ ] 第一列只有 OA 品牌标识和左下角设置；设置接真实 action。
- [ ] 第一列空白区没有“不放首页与功能入口”等竖排说明、设计标注或占位文案。
- [ ] 连接、刷新、保活、当前 Pack、安全锁位于跨第二/第三列的固定顶部状态栏，并来自同一真实会话快照。
- [ ] 连接胶囊、圆形刷新、圆形 `A` 保活的顺序和 Connect/Connecting/Connected/Cancel 状态符合 v4 证据，但 action/state 来自 v5 后台。
- [ ] 第二列顶部无“功能 / 来自已安装 Feature 的真实导航 / v0.4.0”横栏，会话栏下直接开始功能树。
- [ ] 第二列只含 Registry 功能菜单，不包含任何 Feature 工作台、目录、筛选、表格、上传或计划摘要。
- [ ] 标签栏左侧折叠按钮参考 v4，可折叠/展开第二列；折叠后无空白列或残留 Splitter，偏好真实持久化。
- [ ] `Comments` 固定为首个不可关闭标签；点击多个真实 Feature 后生成可切换的命名标签。
- [ ] Global Session Bar 下直接出现标签栏；不存在“Omnia Agent / 聊天说明 / AI Provider 状态”第三列标题横栏。
- [ ] 点击可用 Feature 叶子默认打开/聚焦第三列 docked 标签；Feature Surface 不直接注入 Shell DOM/CSS/Store。
- [ ] Feature 活动时右上角有 `↗ / − / ×`，Comments 活动时没有；弹出/最小化只迁移同一实例，不产生第二套可操作 Surface。
- [ ] 第三列底部聊天输入区始终保留；Comments 保存聊天、附件、真实进度、确认、结果和 Artifact，Feature 关闭/崩溃不影响它们。
- [ ] 删除元素只在 Comments 消息卡确认一次，docked/detached Surface 和第二列没有重复确认控件。
- [ ] 删除成功后删除 Surface 自动读取新目录状态，已删除元素不再出现。
- [ ] 全局缩放只在顶部右侧显示一套，设置入口不在顶部重复。
- [ ] 第一列为最小固定宽度，第一/第二列之间没有 Splitter 或拖动命中区。
- [ ] 第二/第三列及聊天输入区边界可拖动、可键盘调整、可恢复默认并真实持久化。
- [ ] 100% 默认字号和行高达到紧凑基线，且 Windows 100%/125%/150%/200% 下可读。
- [ ] loading/empty/disabled/error/partial/uncertain 全部由后台真实状态驱动。
- [ ] 未实现或依赖不满足的控件隐藏或禁用，没有可点击假功能。
- [ ] 设置界面为两列：左列真实菜单，右列对应具体设置；AI、安全锁等真实页面保持，整个 Connector 设置子菜单不存在。
- [ ] 首次链接码、诊断、重新配对和解除绑定只从顶部 Connect 流程进入；顶栏不显示 Local 标签或模式切换。
- [ ] 设置左右两列各自独立滚动，任一列滚动不会改变另一列位置。
- [ ] 设置两列边界使用公共 Splitter 并真实持久化；主 Shell 固定 Rail 仍无 Splitter。

## 12. 已冻结基线与真机校准

当前设计基线冻结为：Rail `56px` 且固定、第二列纯功能菜单默认展开并占 `30%`、折叠时菜单与 Splitter 均归零、`Comments` 为固定首标签、聊天输入区默认 `150px`/最小 `88px`/最大 `42%`。顶部优先单行，空间不足时使用本规范定义的受控两行。Feature 内部 Splitter 属于自己的隔离 Surface，docked 与 detached placement 共享同一偏好。

代表性 Win10/Win11 ThinkPad 仍需覆盖 100%/125%/150%/200% Windows 缩放、长 Pack 名称、键盘和焦点矩阵。若验证失败，应调整统一 design token、min/max 或换行阈值并提升布局版本；不得改变区域职责、恢复 Rail 拖动或隐藏关键状态。

## 附录 A：v4 证据与采用边界

本轮没有凭空复刻 v4；以下结论来自固定工作区 `D:\Codex\Projects\工作\omnia-agent-v4` 的现有源码、测试和 README。仓库内未找到可直接复用的 PNG/JPG UI 截图，因此以可执行源码和自动化断言作为主要证据。

| v4 证据 | 已证明的行为 | v5 采用方式 |
|---|---|---|
| `web/app-shell/shell.tsx:83-108` | Connect/Connecting/Connected 胶囊、相邻刷新圆钮、相邻 `A` 保活钮、Pack 副标题、安全锁与 Connector 状态 | 采用控件顺序、状态文字和紧凑显示；改接 v5 会话快照/action |
| `public/styles.css:647-833` | 胶囊/圆钮尺寸与颜色状态；Connected hover 显示 Connect；Connecting hover 显示 Cancel；刷新仅 refresh 时旋转；保活 active 为绿色 | 作为视觉/状态参考，不复制全局 CSS；由 v5 token 重建 |
| `public/app.js:1190-1219, 1328-1390` | engagementName、连接/刷新/取消/保活来自真实状态与 API；操作 busy 分离 | 保持不同 operation 状态分离，禁止一个 busy 伪装另一个 operation |
| `public/modules/omnia-connection.js` | load/connect/refresh/keepalive/cancel 是不同真实端点；可用性还检查 Connector 设备 | v5 保留分 action 合同，但不照搬 room API/数据模型 |
| `tests/omnia-connection-cancel.test.js` | Connecting 可取消、Connected 可重连、Connect/Cancel 不驱动刷新动画 | 转为 v5 UI/E2E 验收 |
| `tests/omnia-keepalive.test.js` | `A` 位于刷新后、`aria-pressed` 反映持久状态、真实 API 控制 | 转为 v5 UI/E2E 验收 |
| `web/app-shell/shell.tsx:83-100` | `sidebarToggleBtn` 位于内容标题左侧，按折叠状态切换可读名称、`aria-expanded` 与三横线状态 | 采用紧邻标签栏的折叠按钮语义，控制第二列 Feature 菜单 |
| `public/app.js:1244-1274` 与 `public/styles.css:562-618,7382-7393` | 折叠状态可恢复/持久化；折叠时侧栏及其 resizer 一起隐藏，主内容扩展 | 改由 v5 Core LayoutPreference 持久化，不复用 localStorage；折叠后菜单和 Splitter 都归零 |
| `public/app.js:1530-1599` | 多个流程/工具通过 `window.open` 进入可移动、可缩放独立窗口，已有窗口可被命名和聚焦 | 只采用用户主动弹出/最小化后的独立窗口交互；默认打开改为 docked 标签，Electron v5 不允许 Feature 任意打开 URL |
| `public/workspace-window-boot.js` 与 `public/app.js:330-410` | 独立窗口在真实 bootstrap 前显示专用加载页，失败保留错误/重试 | 采用真实 bootstrap 与原子切换，不露出 Shell 或 mock 状态 |
| `public/app.js:450-474, 2850-2864` | 独立删除窗口通过 opener/storage 通知主窗口刷新计划 | v5 改用 Core Event/Confirmation 合同，不复用 localStorage 作为事实 |
| `README.md:104-113` | 安全锁/删除使用独立窗口，Pack 状态不在窗口重复；确认最终只保留 Agent 消息卡；独立窗口与主窗口同步真实计划 | 采用单一 Comments 消息卡 owner；docked/detached Surface 都不复制确认控件，独立窗口只作为主动 placement |

明确不复制的 v4 部分：Room/Agent profile、任意 `window.open` URL、localStorage 作为跨窗口事实、巨型共享 CSS/DOM、窗口内重复确认，以及名称推断的 Pack/Workspace 分类。v5 仍使用 Feature Registry、受控 WindowManager、Core system of record、签名 Feature UI 和统一 Gate。
