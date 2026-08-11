# 剩余评审项说明与建议

状态：For User Review  
日期：2026-07-30  
边界：本文件只解释和收敛设计，不授权创建应用脚手架或开始业务开发。

## 1. 已经确认、不再讨论的产品结论

| 项目 | 已确认结论 |
|---|---|
| 首批 Feature | “其他”下的新建与关联、删除元素、删除聊天记录、录制 |
| 开发顺序 | 录制 → 删除元素 → 删除聊天记录 → 新建与关联 |
| 四 Plane 综合验收 | 第四项“新建与关联”；用真实 APP/DB/GRA/关系验证完整链路 |
| Agent 管理内容 | 后台保存 create/update/delete current + revision/change/tombstone；Phase 2 走版本化查询 |
| 首个工程交付 | 不内置业务 Feature 的真实 Shell Baseline，不是静态 UI demo |
| Feature 交付 | 四个首批功能分别作为独立签名包安装、启停、升级和回滚 |
| 删除功能名称 | “删除安全锁内元素”改名为“删除元素”，后台安全锁不取消 |
| 主界面 | 保留三列；第一列应用 Rail，第二列功能树，第三列聊天/交付 |
| 菜单深度 | 最多三级；二级或三级都可以直接是 Feature |
| Remote 范围 | 面向全部版本，不做版本或用户档位限制 |
| Remote Connector 升级 | 必须支持签名在线升级；优先 Operation Module，尽量少升级 Core |
| Remote 更新默认策略 | 服务器自动下发；Supervisor 自动取得/验证，在真实安全窗口自动激活，安全阻断不可关闭 |
| Feature/Operation 包来源 | 生产只允许官方签名包；首版不开放第三方或任意离线导入 |
| Workspace 读取 | 权威轻抓取 Section + Workspace；有界重抓取选定 Workspace 下能力所需元素；禁止名称推断 |
| 数据与更新 | 同一产品根内分离 immutable releases 与 stable data；默认无按年龄自动删除；更新不得覆盖 data |
| 模板发布 | 用户本人或持有单次精确 digest 授权的 Codex；记录授权、签名、validation 和 Evidence；首版不强制双人审批 |
| v4 数据 | 首版不迁移；需要时只读按类打捞 |
| Windows | 普通 Win10/Win11 ThinkPad 均可安装、连接和使用；SKU/build/补丁用于风险提示和排障，建议配置由真机测试形成 |
| 录制深度 | 沿用 v4 详细采集；Secret 源头剔除、完整性证明、Local/Remote 等价 |
| 删除/录制测试资料 | 以 v4 固定证据基线和原测试方法开始，不要求专用 Pack；开放前使用届时已有非生产环境最小复核 |
| 删除元素交互 | 紧凑两栏，无常驻选择篮；底栏显示数量，右上角消息卡负责完整清单、确认、进度和结果 |
| 删除聊天记录 | 正文立即物理删除；无引用聊天附件清理；Omnia effect、`uncertain`、共享引用和最小 Evidence 分离保留 |
| Nova | 精确协议暂不校验，不阻塞首批范围；验证前不显示为已支持 |

“Remote 面向全部版本”只决定谁可以使用，不等于 Remote Bridge 可以不做身份、加密、重放防护和数据保留设计。

## 2. 产品决策解释与待确认项

### D-00（已确认）：录制和删除如何使用 v4 证据

**是什么意思**

开发顺序已经确定，但“排第一”不等于可以跳过开发就绪条件。录制需要接触真实 Omnia 会话并产生可能包含客户信息的 Artifact；删除元素紧随其后，会产生不可自动重放的真实 mutation。两项都必须有安全的验收目标和数据边界，但不要求用户再准备专用 Pack。

**决定**

- 录制先使用 v4 当前 Recorder、完整录制和测试建立详细采集等价基线；首次现场验收使用届时已有的非生产会话；
- 首版由当前已认证本地产品用户录制、查看、导出和销毁自己的 Artifact；Feature Worker、AI/Codex 和其他会话默认无权读取正文；
- 认证 header、Cookie、Token 和 Secret 必须双层脱敏；
- Local/Remote 使用同一录制合同，各有真实链路证据；Remote Bridge 未满足身份、加密、续传和 TTL 门禁时，Remote 录制入口禁用；
- 删除元素从 v4 完整录制、Handoff、当前源码/测试和写后证据生成候选 capability matrix，再按证据等级逐类开放；
- 删除计划必须独立确认，逐项写后读回；结果未知进入 `uncertain`，不能为了测试方便自动重放或连带删除关联对象。

不要求用户提供专用 Pack。删除和录制都以 [v4 删除与录制证据基线](../research/V4_DELETE_RECORDING_EVIDENCE_BASELINE.md)开始；现场验收沿用 v4 方法，在届时已有的非生产 Pack/Workspace 中选择最小安全目标。capture allowlist 和删除 capability matrix 由静态证据审计、synthetic 测试和首次当前环境复核产生，不把历史名称、ID、数量或顺序写死。详见 [ADR-0030](../adr/0030-v4-evidence-seeded-recertification.md)。

### D-01：“新建与关联”canary 到底要确认什么

**是什么意思**

产品范围和第四项的综合验收定位已经确定，但 v5 默认文档尚未准备，目前也没有可供 canary 使用的已发布 `TemplateVersion`。这里不是再问“要不要做”或是否调整顺序，而是先完成[默认文档准备项目](../planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md)，再指定真实 Omnia mutation 可以安全发生在哪里、用什么规则判定成功、由谁负责测试对象。

**建议**

“新建与关联”的首个能力 canary 固定为：

- 一个隔离非生产 Engagement/Workspace；
- 一份已发布官方模板；
- 一个全新 Generic APP、一个全新 Generic DB；
- DB 只关联该 APP；
- 创建并读回两个 IT Element、两个 GRA core；
- 从关系双方读回唯一 DB → APP 关系；
- 不包含 Risk/Control 后处理、OS、Tool、SAP、批外引用或多 APP；
- 清理由独立“删除元素”计划完成，不由创建 Run 自动回滚。

**需要确认**

首先需要用户/业务负责人提供或认可候选默认文档，并确认其来源/许可、默认字段、保护区域和批准人；同时冻结写入 Agent Managed Content Registry 的类型 Schema，包括 APP RAIT、Factors Considered、DB 有效/继承 RAIT、GRA/关系身份、provenance，以及 Phase 2 必须读取的字段和 freshness。随后还要确认测试 Workspace、测试对象命名、保留时间、清理责任，以及 Local/Remote 是否使用两个隔离的 canary 目标。没有正式 `TemplateVersion` 和域 Schema 时可以继续完善通用合同，但不能实现模板处理链、执行真实 mutation 或开放入口。

### D-02（已确认）：“其他”下面不强制三级目录

**是什么意思**

功能树现在采用“最多三级”：

```text
其他
├─ 元素管理
│  ├─ 新建与关联
│  └─ 删除元素
├─ 删除聊天记录
└─ 录制
```

一级是业务域。二级既可以直接是 Feature，也可以在确有多个相关功能时作为分组；三级只能是 Feature。当前“元素管理”包含两个相关功能，所以保留三级；删除聊天记录和录制直接使用二级。

Feature ID、route、权限和历史 Run 不依赖菜单 parent，因此以后调整分组不会破坏业务身份。不得为单一叶子强行创建分组，也不得增加第四级。

### D-03（已确认）：删除聊天记录究竟删除什么、能否恢复

**是什么意思**

这里删除的是 v5 本地主界面第三列中的当前聊天，不是 Omnia 平台里的聊天、评论或业务记录。需要提前定义四类数据：

| 数据 | 可选处理 |
|---|---|
| 消息正文 | 立即物理删除，或先进入可恢复状态 |
| 仅被消息引用的上传附件 | 随消息删除，或延迟清理 |
| Feature Run/业务结果 | 保留、归档，或在无外部 effect 时删除 |
| 审计/Evidence | 为证明危险操作发生过而继续保留，但应去除不必要正文 |

如果不先确定，界面上的“已删除”可能和磁盘上的真实状态不一致。

**决定**

- 用户确认后，消息立即从正常会话中消失；
- 消息正文和只被聊天引用的附件执行物理删除，不设置普通用户回收站，避免“删除”名不副实；
- 已产生 Omnia effect、`uncertain`、合规 Evidence 或仍被 Feature Run 引用的数据不得随聊天一起删除；
- 删除前有活动 Run、录制或未解决 `uncertain` 时阻断；
- 删除结果明确列出“已删除”和“因业务/审计要求保留”的数量，不声称整库抹除；
- 是否提供管理员级备份恢复由统一备份策略决定，不在聊天入口承诺恢复。

用户已经接受上述语义。首版不提供普通用户回收站；具体事务、附件清理和重启恢复按 [ADR-0015](../adr/0015-chat-history-immediate-deletion.md) 验证。

### D-04（已确认）：独立 Feature 包从哪里安装

**是什么意思**

Feature 必须是独立签名包，首批先交付真实 Shell Baseline，再逐包测试安装、启停、升级和回滚。生产分发已经收敛：

1. 每个 Feature/Operation 都由官方信任根签名并从官方受控更新源取得；
2. 首版不允许第三方、未签名或任意手工离线包。

两者都保留独立包能力，第二种会额外引入信任根、恶意包、依赖冲突、降级攻击和支持成本。

**决定**

生产首版使用“官方签名的独立 Feature/Operation 包 + 受控更新器”，不要求整套应用重装。测试阶段只使用与生产隔离的官方测试根。未来可以兼容官方签名离线包，但必须另行评审管理员导入、介质来源和撤销新鲜度；不因此提供任意包入口。见 [ADR-0026](../adr/0026-official-signed-package-supply-chain.md)。

### D-05（已确认产品边界）：数据、更新、保留和导出

**是什么意思**

这不是单纯“选一个数据库”，而是回答：

- 电脑磁盘被复制时，数据库、附件、录制是否仍可读；
- 升级失败或数据库损坏时如何恢复；
- 聊天、日志、录制、Evidence 各保留多久；
- Agent 管理内容的 current、历史 revision、change 和删除 tombstone 各保留多久；
- 用户能否导出一套可验证、可恢复的数据包；
- 删除动作是否同时影响备份。

**决定**

- API Key/Secret 只进入 Windows 保护的 Secret Store，不进入普通数据库、日志或备份明文；
- 公司当前无保留期、备份位置、云同步或不可恢复删除规定；
- 同一产品根内分离不可变 `releases` 和稳定 `data`；更新、回滚、旧 release 清理不得覆盖 data；
- 业务数据默认不按年龄自动删除，由用户显式清理；引用、active mutation、`uncertain` 和必要 Evidence 可阻断物理删除；
- 首版无定时自动备份承诺；破坏性升级/migration 前创建受控 checkpoint，未来真实导出包包含 manifest、schema/version、digest 和缺失项；
- 复制根目录后 Secret 不可用，要求重新配置/配对，不能为便携性保存明文。

具体低磁盘、配额、checkpoint/恢复阈值仍由 D5 证明，不再作为用户产品决策。见 [ADR-0027](../adr/0027-portable-data-root-and-update-boundary.md)。

### D-06（已确认）：模板由谁发布和回滚

**是什么意思**

模板是后台生成交付文件的起点。若任何 Feature 或用户都能覆盖模板主文件，同一个输入可能在不同时间生成不同结果，且无法解释来源。

**决定**

- 模板生命周期统一为 `draft → review → published → superseded|revoked`；
- validation 是独立结果 `pending|passed|failed`，不是生命周期状态；只有 owner approval、签名和 validation passed 同时满足才能进入 `published`；
- 发布后内容不可变，修改产生新版本；
- 首版由用户本人或持有该用户针对精确 TemplateVersion/digest 的单次授权的 Codex 发布；
- 记录 requestedBy、授权 publisher、authorizationRef、签名、validation 和发布 Evidence；Codex 不得自授权；
- 首版不强制第二人审批；
- Run 永远复制已发布版本，不直接修改模板主文件；
- 回滚是把默认指针切回旧的已发布版本，不删除历史版本；
- 每个模板记录来源、许可、适用 Omnia/Feature 版本和 digest。

该词汇以[模板与文档管线](../data/TEMPLATE_AND_DOCUMENT_PIPELINE.md)为规范来源；不得把“自动校验通过”显示为“已发布”，也不使用 `validated/deprecated` 作为生命周期同义 enum。

现有模板的来源/许可仍须在每个 TemplateVersion 发布时逐份证明；这属于模板 DoR，不再是“谁能发布”的开放产品决定。

### D-07（已确认）：v4 哪些数据进入 v5

**是什么意思**

迁移可以包括旧聊天、附件、Run、模板、设置、EMS 数据、Connector 配对和 Key。全部照搬会把 v4 的数据模型和历史风险一起带入 v5；完全不迁又可能丢失必要业务资产。

**决定**

- v5 运行库从空库开始，不原地升级 v4 数据库；
- 首版不迁移 v4 聊天、附件、Run、模板、设置、EMS、Key 或配对；
- 以后用户提出具体需要时，只对点名数据类别做只读 inventory、按类打捞、扫描、验证和导入；
- 被打捞的 v4 聊天、Run 和 Evidence 只读归档，不伪装成 v5 的实时状态；
- v4 没有完整 Agent Managed Content ledger，不从日志猜造 create/update/delete 历史；只能导入可证明 snapshot 或 legacy Evidence；
- 不迁移 API Key、Cookie、Connector 配对、active lease、在途任务或 `uncertain` 命令；
- 除“新建与关联”的首个窄 canary 外，完整 Phase 1、Phase 2、Controls 和 EMS 不提前导入可运行状态；
- 导入器只读、幂等、可演练，每一类数据单独批准。

### D-08（已确认产品范围）：支持哪些 Windows 电脑

**是什么意思**

需要知道目标 Windows 版本、CPU/内存、磁盘、显示缩放、是否有管理员权限、杀毒/代理限制和典型文件规模。这些信息会影响 Electron/runtime、sandbox、数据库并发、字体密度和本地 Connector。

**决定**

- 支持普通 Windows 10 和 Windows 11；不以生命周期、ESU、补丁状态或强隔离认证设置统一阻断；
- 目标硬件为普通 ThinkPad 类办公电脑；
- 最低/推荐 CPU、内存、磁盘和缩放通过代表性真机测试形成非阻塞建议；
- 不要求用户选择 IPC、数据库、sandbox 或其他实现技术。

### D-09（已确认）：Remote Connector 在线升级默认策略

**是什么意思**

“支持在线升级”已经确定，指远程 Connector 能自行取得受信候选、验证、暂存、切换和回滚，不需要现场复制文件。但还需要决定什么时候真正激活：

- `automatic_safe_window`：后台自动下载，检测到安全窗口后自动安装；
- `notify_then_apply`：后台下载并通知，管理员点击后等待安全窗口安装；
- `manual_maintenance`：只提示新版本，由管理员安排维护窗口。

三种策略只影响触发时机，不改变签名、A/B 槽、在途 mutation/`uncertain` 阻断、probation 和回滚。

**决定**

首版默认 `automatic_safe_window`，与 v4 的服务器下发体验保持一致：服务器自动下发官方签名 offer；Supervisor 自动取得、验证和暂存；真实安全窗口满足后自动激活。

高危/严重更新还携带停止新高风险 Run 的时间和最大 drain 期限；到期后可以收紧新任务准入，但不能强杀或重放已提交 mutation。规范见 [ADR-0028](../adr/0028-remote-automatic-safe-window-rollout.md)。

业务功能变化优先在线升级 Operation Module，不重启 Connector Core；只有 Transport、Session、Gate、安全边界、受控 SDK 或基础 Omnia 兼容发生变化时才升级 Core。

签名、A/B、active mutation/`uncertain` 阻断、probation、previous 回滚和不 fallback 到 Local 不允许被用户设置关闭。

### D-10（已确认）：权威轻抓取、重抓取与 Sync 降级

**是什么意思**

工作区读取不再以首次完整 Sync 为中心：

- 轻抓取读取 Omnia 权威 Section/部分 + Workspace，用于安全锁和 Workspace 选择；
- 重抓取只读取选定 Workspace 下当前 Feature capability 所需元素，用于删除、新建元素、关联、编辑底稿；
- 禁止用 `TEST`、`20000`、`IT Elements` 等名称猜分类；
- 重抓取按 Pack/选定 Workspace/capability 有界、分页、可取消、可观测，不做全包无界 dump；
- Pack 历史和 observation 可以保留，但 Sync 降级为可选性能优化。

**决定**

- 每次连接可以保存最小 PackRecord；
- Feature 默认实时轻抓取，元素级需要时再做有界重抓取；
- Feature 内刷新创建真实 read Run；
- partial/failed Sync 不替换上一份成功快照；
- Sync 只使用 allowlisted read-only Connector Operation，不做任意网页爬虫；
- Pack Snapshot 与 Agent Managed Content 分开存储和标记来源。

删除在生成计划和实际 mutation 前仍分别做一次目标级实时检查。详细评估见 [Pack 轻/重抓取与 Sync 降级评估](PACK_SYNC_CACHE_EVALUATION.md)及 [ADR-0025](../adr/0025-authoritative-light-heavy-workspace-reads.md)。

## 3. 需要架构原型证明、不是让用户直接选技术名词

### T-01：Runtime 与 IPC

Runtime 是桌面壳、后台 Core 和 Worker 分别运行在哪里；IPC 是它们如何通信。这个评审要证明 UI 崩溃不会带倒持久任务、Renderer 不能直接碰数据库/Secret、消息有版本和身份边界。

当前建议方向是 Electron + React/TypeScript Shell、独立 Core 进程、独立 Feature Worker；本机通信优先使用受限命名管道或等价本地 IPC，不让 Renderer 获得 Node/文件系统权限。最终选型需要安全与性能原型。

### T-02：Core DB 与 Module Store

这决定“后台独立数据库”和“Feature 彼此隔离”在磁盘上如何落实。当前建议是 Core DB 一份、每个 Feature 独立 Store 文件、Artifact 正文单独存储；任何 Feature 不得跨库直连，只能通过有版本的 Core API。SQLite/加密层/WAL/备份方式需用真实并发和故障恢复测试决定。

### T-03：Windows sandbox

单独进程不等于安全隔离，独立 UI bundle 也不等于前端隔离。要限制 Worker 能访问的目录、网络、进程、注册表和系统能力，并在崩溃或超时时可强制回收；Feature UI 还必须与 Shell/其他 Feature 的 DOM、CSS、路由、store、Node、网络和浏览器存储隔离。当前建议同时验证受限 token、Job Object、按任务临时目录、默认禁网，以及声明式 view/独立 sandboxed renderer、隔离 origin/partition、CSP 和版本化 UI Bridge；是否采用 AppContainer 或具体 Electron view 技术取决于兼容性与攻击测试。

### T-04：Remote Bridge 技术设计

Remote 已确定面向全部版本，但还要决定：

- Bridge 部署在哪里、由谁运维；
- Agent、Bridge、Connector 如何互相证明身份；
- 命令/事件/Artifact 是否端到端加密；
- 离线消息保留多久、超时后如何失败；
- 大文件断点续传、重放防护、限流和审计；
- Connector 更新包是经独立更新通道下载，还是由 Bridge 只做不透明分块中继；
- 服务中断时是否达到可接受的恢复目标。

当前建议把 Bridge 限定为短期中继，不承载第二套业务后台，不保存 API Key，不解释业务命令；Agent 与 Connector 使用设备级身份和端到端加密，命令有短 TTL、序列/幂等键和 active lease fencing。具体时长和部署拓扑必须经过威胁模型和断网/重连原型。

## 4. 已延后事项

### Nova 精确协议

“暂时不校验”在文档中的准确含义是：

- 不为 Nova 猜测 endpoint、认证方式、模型列表或兼容协议；
- 不在设置中显示“Nova 已支持”；
- 首批 Feature 和通用 AI Provider 架构不依赖 Nova；
- DeepSeek 和 Custom Provider 仍必须通过真实连接测试后才能保存为可用；
- 以后拿到 Nova 真实资料时，重新打开 ADR-0013 并做专用 Adapter。

## 5. 建议的评审顺序

先评产品语义，再评技术：

1. D-01 新建与关联 canary 环境、模板数据和清理 owner（P-12/P-17）；
2. T-01～T-04 与轻/重抓取的 D5 原型计划和验收指标；
3. 基于 v4 evidence baseline 冻结录制 capture policy 候选与删除 capability 候选；
4. 按录制 → 删除元素 → 删除聊天记录 → 新建与关联完成四份 Feature 技术合同；
5. 主 Agent 进行下一次文档验收；
6. 用户明确批准后才进入开发。
