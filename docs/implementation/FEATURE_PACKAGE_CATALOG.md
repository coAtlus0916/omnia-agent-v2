# v5 Shell 与 Feature 包总览

状态日期：2026-08-04
用途：说明功能层级、当前真实状态、交付形态和额外部署要求。这里是状态索引，不替代 Feature 的四 Plane 实现文档、合同测试或真实 Omnia canary。

## 1. 交付层级

```text
v5 便携产品根
├─ Shell 原装平台（随 Shell 0.4.9 开箱存在）
│  ├─ 首页 / 三列聊天 / 设置 / 缩放 / Splitter
│  ├─ Core SQLite / Feature Registry / Documentation Registry
│  ├─ 通用 Feature Worker、Store/Event/Managed Content ports
│  └─ RemoteConnectorTransport、Remote binding 与 Gate 基础设施（无 Local）
├─ 内置独立 Feature（官方签名 .ofp，随 Shell 携带并自动安装）
│  ├─ omnia.recording 0.3.0
│  └─ omnia.create-associate 0.2.3
├─ 后装独立 Feature（官方签名 .ofp，按需安装）
│  └─ 删除元素 0.1.2
├─ Connector Operation 包（官方签名 .ofop，按 Feature/capability 装载）
│  └─ 通过公司电脑 Remote Operation host 执行固定 step gate
└─ 必需的 Remote 额外部署
   ├─ v5 Bridge 0.4.4
   └─ v5 Remote Connector 0.3.10 / sequence 13（已发布 v5 stable；公司端激活待读回）
```

“Shell 原装”是平台能力，不等于把业务写死在 Shell；录制虽然随 Shell 携带，仍是独立签名、独立 Worker、可独立升级的 Feature。“后装”表示干净 Shell 不带该业务，安装 .ofp 后才登记和启用。“Operation 包”只承载经过签名的具体 Omnia 能力，不允许把任意 URL/method/body 交给 Connector。“额外部署”表示仅安装 Feature 仍不够，还需 Remote Connector、Bridge 或对应 Operation 能力。

## 2. Shell 原装平台

| 能力 | 真实状态 | Remote-only 实现 | 额外配置/边界 |
|---|---|---|---|
| 连接、刷新、保活、安全锁 | Shell 0.4.9：安全锁绑定完整 Connector/authority/tenant/Pack/engagement/Workspace 身份，保存及 Feature action 前实时复核 | 顶部 Connect → Bridge 0.4.5 → Remote Worker 0.3.12 固定读取 → Core 解析/持久化 | 公司电脑真实 Pack 授权 canary 仍待执行；缺 Section 不阻断精确 Workspace 授权 |
| 三列聊天、附件、输入区 | 已实现 | 不依赖 Connector | Provider 未配置时只保存，不造假回复 |
| DeepSeek / OpenAI-compatible Custom | 已实现 | 不依赖 Connector | Nova 专有协议未校验 |
| 全局缩放、可拖动分隔线 | Shell 0.4.1 已验证并由 0.4.2 回归 | 不适用 | Shell/Settings/docked/detached/新建窗口一致；偏好写入 Core 数据库 |
| Feature 安装、升级、回滚、文档投影 | Shell 平台已实现 | Worker/Store/Event/Managed Content；Connector effect 只经 Remote Operation host | 包由工具自动签名、摘要和验签；具体业务 capability 仍按 Feature canary 判断 |

## 3. 独立 Feature 状态

首批开发顺序：**录制 → 删除元素 → 删除聊天记录 → 新建与关联**。当前 Shell 功能栏扁平显示已安装 Feature，不再显示“其他/元素管理”等业务分组；这项展示规则不改变 Feature 的独立包边界。

| 顺序 | Feature | 当前版本/状态 | 交付方式 | Remote-only 状态 | 模板依赖 | 下一步 |
|---:|---|---|---|---|---|---|
| 1 | 录制 | 官方签名 omnia.recording 0.3.0 / sequence 4，已内置 Shell 0.4.8 | 独立 .ofp 随便携包内置；不是 Shell 硬编码业务 | 播放器式 start/pause/resume/stop/export；当前页自动采集 Risk/Control；分块进入 Core Artifact；公司电脑真实录制待 canary | 无 | 在授权 Pack/公司电脑完成现场录制 canary |
| 2 | 删除元素 | 官方签名 .ofp 0.1.2，独立后装 | 安装后登记，按真实依赖启用 | 自动化 Operation 闭环存在；0.1.2 不因 Shell 升级被改写，真实 Remote 删除待公司电脑 canary | 无 | 用最终 Remote Connector 完成目标 Pack canary；不得 fallback 到历史 Local 路径 |
| 3 | 删除聊天记录 | 未交付，仅产品设计 | 未来独立后装 .ofp | 不依赖 Omnia 的本地事务仍未实现 | 无 | 开发真实本地事务、附件引用清理和恢复测试；没有闭环前不要显示入口 |
| 4 | 新建与关联 | `omnia.create-associate@0.2.3 / sequence 5` 候选包 | 独立 .ofp + .ofop；随 Shell 0.4.9 内置并自动升级 | 保留真实三步状态机、返回上传、重新开始与 APP/DB/OS/TOOL Return；authority Workspace 类型已修正 | 有 | 完成真实 SAP ECC canary；AI review 仍为 `not_evaluable` warning |

### 3.1 录制的准确边界

omnia.recording 0.3.0 是独立签名包并随 Shell 0.4.8 内置自动安装；0.1.x、0.2.0 保持不可变 rollback 历史。0.3.0 使用通用 `recorder` Surface 和 Remote-only recording command，暂停/继续保持同一 recordingId，停止与导出分离，当前页 GRA/Risk/Control 自动只读采集；Bridge 传输按 512 KiB 分块进入 Core Artifact Store。目录缺少必需身份或 endpoint 时返回 incomplete，不会推断 Higher/Lower 适用性或 link_required。本地签名与产物核验通过不等于真实 Pack canary。

`omnia.delete-elements@0.1.2` 仍是独立后装包。安装后 package manager 按相同 `other` group id 合并为唯一“其他”分组，同时显示“录制”和“删除元素”；Shell 不内置删除业务，干净 data root 不伪造删除入口。Shell 0.4.0→0.4.1 升级验收验证已安装包、activation head、Feature store 和便携 `data/` 均保持。

详见 [录制实现](RECORDING_FEATURE.md)、[录制产品设计](../product/RECORDING_FEATURE.md) 和 [v4 证据基线](../research/V4_DELETE_RECORDING_EVIDENCE_BASELINE.md)。

### 3.2 删除元素的准确边界

.ofp 0.1.2 是后装官方包，包含 Worker、后台状态和签名 Operation 声明；Remote-only 决策前完成的 Local 自动化只保留为历史合同证据，不能当作 Remote 现场证明。0.4.2 必须通过真实 Remote capability negotiation 判定该包能否运行；没有用户 Omnia 登录的自动化不冒充实机删除，未连接、安全锁无效、package compatibility 或目标 Remote capability 不满足时必须明确禁用，不能回退 Local。

## 4. Phase 1、模板与 Phase 2

| 项目 | 层级 | 当前状态 | 依赖 |
|---|---|---|---|
| Phase 1 母版 | 治理输入，不是运行时 Feature | V8 已固化 9 sheets/187 字段/68 关系/21 v4 证据/180 条源追溯/公式错误 0 | 仅作为签名治理资产，不当用户输入或运行时默认数据 |
| 新建与关联首切片 | 独立 Feature | 0.1.0 自动化候选已实现；真实 canary 未完成 | Remote-only；签名 Operation、TemplateVersion/Instance、Run/intent/command/receipt、Managed Content 与 reconcile |
| Phase 2 | 未来能力集合 | 尚未交付 | 只能通过版本化 Managed Content 查询 current/revision/relation/tombstone，不得读 Feature 私库猜测 |

母版最终文件见 [Phase 1 模板待办](../planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)。它用于模板治理、映射、规则和发布，不直接承载运行时用户上传值。

## 5. 额外部署与安装判断

1. 只处理 Core 本地数据的 Feature（未来删除聊天记录）只需安装 .ofp。
2. 读取/修改 Omnia 的 Feature 需要 .ofp 及其官方签名 .ofop 能力；公司电脑 Remote Operation host 只执行固定、签名、可审计的 step gate。
3. 所有 Omnia Feature 都需要 v5 Bridge 可达和独立 Remote Connector。首次路径是顶部 Connect 生成链接码 → 公司电脑 Connector 输入 → 同一 Connect 流程等待 Pack；Settings 没有 Connector 表单，不依赖旧 v4 脚本或静默回退。
4. 普通 Feature 不修改 Connector Core；优先新增或升级 Feature/Operation 包。只有公共 Gate/Transport/Supervisor 合同不足时才发布新 Connector 版本。
5. 构建器自动完成 Feature/Operation/Connector release manifest 的签名、成员 digest、安装验签和 sequence 检查；日常开发不要求人工逐文件 SHA。Shell 与 Bridge 可执行文件当前仍标记 `organization_code_signing_required_before_distribution`，正式分发前必须完成组织代码签名。

## 6. 状态词和维护规则

状态词按证据使用：设计、源码已实现、候选包已生成、可安装、运行时已接通、Local 已实测、Remote 已实测、已发布、待 canary。其中任何一项都不能自动推导下一项。

每次 Feature 开发或安装必须同步更新：Feature 包内四 Plane 文档、测试、版本/manifest、文档登记簿投影、实现/验收记录和本总览。若历史文档保留旧状态，必须明确标注“历史快照”，不得覆盖本页当前状态。
# omnia.create-associate 0.1.0

Candidate package: `feature-packages/create-associate/candidates/create-associate-0.1.0.ofp`; independent nested-equivalent Operation package: `create-associate-operation-0.1.0.ofop`. Sequence is 1. Offline conversion and the complete Return control loop—including structured intent, actionable confirmation, durable execution/readback/reconcile, and verified-current projection—are implemented and covered by automated tests. Production mutation remains disabled because scoped capability evidence and the exact-authority real Omnia canary are still missing; this is an independent release gate.

## omnia.create-associate 0.2.0 / omnia.recording 0.2.0

0.2.0 候选收紧为通用三步 Surface，不在 Renderer 硬编码 Feature 业务分支。create-associate 随包携带签名 `Phase1-用户填写模板V3.xlsx` 源模板并可精确导出；用户选择与拖放都建立真实 Run/输入 Artifact。升级不更改已有 `data/`、Remote binding、Pack 观测或历史 Run。自动化已通过；Feature 候选文件 SHA-256 为 `4b947b7d759f854fec68df254350c91a0302278f0e47b767e71058ccd874d1b8`，Operation 候选文件 SHA-256 为 `b60253ef82ebc57c6917d2a613632c8dcbccdf408607f603bfec5646b8d52260`；便携升级与真实 Omnia canary 仍待完成。

## omnia.create-associate 0.2.3 / omnia.recording 0.3.0 / Shell 0.4.9

0.2.3 是当前开发版本。它保留 0.2.2 的返回上传、重新开始、APP/DB/OS/Tool Review 与真实 Return 闭环，并把 authority Workspace 查询修正为 v4 已验证 Facet Type。Shell 0.4.9/Connector 0.3.12 同时把安全锁改为 Connector 原始读取、Core 处理和实时复核。源码实现、候选包、远程发布和真实 canary 的证据必须分别记录；真实 Pack canary 仍待执行。
