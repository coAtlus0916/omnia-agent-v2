# v5 Shell 与 Feature 包总览

状态日期：2026-08-03  
用途：说明功能层级、当前真实状态、交付形态和额外部署要求。这里是状态索引，不替代 Feature 的四 Plane 实现文档、合同测试或真实 Omnia canary。

## 1. 交付层级

```text
v5 便携产品根
├─ Shell 原装平台（随 Shell 0.4.2 开箱存在）
│  ├─ 首页 / 三列聊天 / 设置 / 缩放 / Splitter
│  ├─ Core SQLite / Feature Registry / Documentation Registry
│  ├─ 通用 Feature Worker、Store/Event/Managed Content ports
│  └─ RemoteConnectorTransport、Remote binding 与 Gate 基础设施（无 Local）
├─ 内置独立 Feature（官方签名 .ofp，随 Shell 携带并自动安装）
│  └─ omnia.recording 0.1.1
├─ 后装独立 Feature（官方签名 .ofp，按需安装）
│  └─ 删除元素 0.1.2
├─ Connector Operation 包（官方签名 .ofop，按 Feature/capability 装载）
│  └─ 通过公司电脑 Remote Operation host 执行固定 step gate
└─ 必需的 Remote 额外部署
   ├─ v5 Bridge 0.4.1
   └─ v5 Remote Connector 0.3.5 / sequence 8
```

“Shell 原装”是平台能力，不等于把业务写死在 Shell；录制虽然随 Shell 携带，仍是独立签名、独立 Worker、可独立升级的 Feature。“后装”表示干净 Shell 不带该业务，安装 .ofp 后才登记和启用。“Operation 包”只承载经过签名的具体 Omnia 能力，不允许把任意 URL/method/body 交给 Connector。“额外部署”表示仅安装 Feature 仍不够，还需 Remote Connector、Bridge 或对应 Operation 能力。

## 2. Shell 原装平台

| 能力 | 真实状态 | Remote-only 实现 | 额外配置/边界 |
|---|---|---|---|
| 连接、刷新、保活、安全锁 | Shell 0.4.2 候选；删除 Local 和 Settings 配对 | 顶部 Connect 链接码 → Bridge → Remote Worker → WorkstationOmniaSession | 公司电脑真实 Pack hierarchy/授权 canary 未通过/待 canary |
| 三列聊天、附件、输入区 | 已实现 | 不依赖 Connector | Provider 未配置时只保存，不造假回复 |
| DeepSeek / OpenAI-compatible Custom | 已实现 | 不依赖 Connector | Nova 专有协议未校验 |
| 全局缩放、可拖动分隔线 | Shell 0.4.1 已验证并由 0.4.2 回归 | 不适用 | Shell/Settings/docked/detached/新建窗口一致；偏好写入 Core 数据库 |
| Feature 安装、升级、回滚、文档投影 | Shell 平台已实现 | Worker/Store/Event/Managed Content；Connector effect 只经 Remote Operation host | 包由工具自动签名、摘要和验签；具体业务 capability 仍按 Feature canary 判断 |

## 3. 独立 Feature 状态

首批开发顺序：**录制 → 删除元素 → 删除聊天记录 → 新建与关联**。菜单可以按二级或三级组织，菜单深度不改变 Feature 的包边界。

| 顺序 | Feature | 当前版本/状态 | 交付方式 | Remote-only 状态 | 模板依赖 | 下一步 |
|---:|---|---|---|---|---|---|
| 1 | 其他 → 录制 | 官方签名 omnia.recording 0.1.1 / sequence 2，随 Shell 自动注册 | 独立 .ofp 随便携包内置；不是 Shell 硬编码业务 | Worker、详细只读抓取/导出和 Remote 传输代码已接通；公司电脑真实录制待 canary | 无 | 在授权 Pack/公司电脑完成现场录制 canary |
| 2 | 其他 → 删除元素 | 官方签名 .ofp 0.1.2，独立后装 | 安装后登记，按真实依赖启用 | 自动化 Operation 闭环存在；0.1.2 不因 Shell 升级被改写，真实 Remote 删除待公司电脑 canary | 无 | 用最终 Remote Connector 完成目标 Pack canary；不得 fallback 到历史 Local 路径 |
| 3 | 其他 → 删除聊天记录 | 未交付，仅产品设计 | 未来独立后装 .ofp | 不依赖 Omnia 的本地事务仍未实现 | 无 | 开发真实本地事务、附件引用清理和恢复测试；没有闭环前不要显示入口 |
| 4 | 其他 → 元素管理 → 新建与关联 | 未交付，仅设计/评估 | 未来独立 .ofp + 创建/关联 .ofop | Remote 传输具备，业务 Operation 未交付/canary | 有 | 以 Phase 1 母版、首个 TemplateVersion、Managed Content 和签名 Operation 为前置 |

### 3.1 录制的准确边界

omnia.recording 0.1.1 是独立签名 patch 包但随 Shell 内置自动安装；业务合同与 0.1.0 兼容，patch 只把 Registry 导航改为 `other / 其他 → 录制` 并更新随包文档。0.1.0 不可变且继续作为显式 rollback 目标；若用户已回滚，0.4.1 后续启动不会强制重激活 0.1.1。它调用统一 recording command，详细抓取当前目标 GRA/IT Element/Risk/Control/RAIT 只读证据，并把 Feature 文档投影到 v5 文档登记。目录缺少必需身份或 endpoint 时返回 incomplete/blocked，不会推断 Higher/Lower 适用性或 link_required。自动化 fixture/合同通过不等于真实 Pack canary。

`omnia.delete-elements@0.1.2` 仍是独立后装包。安装后 package manager 按相同 `other` group id 合并为唯一“其他”分组，同时显示“录制”和“删除元素”；Shell 不内置删除业务，干净 data root 不伪造删除入口。Shell 0.4.0→0.4.1 升级验收验证已安装包、activation head、Feature store 和便携 `data/` 均保持。

详见 [录制实现](RECORDING_FEATURE.md)、[录制产品设计](../product/RECORDING_FEATURE.md) 和 [v4 证据基线](../research/V4_DELETE_RECORDING_EVIDENCE_BASELINE.md)。

### 3.2 删除元素的准确边界

.ofp 0.1.2 是后装官方包，包含 Worker、后台状态和签名 Operation 声明；Remote-only 决策前完成的 Local 自动化只保留为历史合同证据，不能当作 Remote 现场证明。0.4.2 必须通过真实 Remote capability negotiation 判定该包能否运行；没有用户 Omnia 登录的自动化不冒充实机删除，未连接、安全锁无效、package compatibility 或目标 Remote capability 不满足时必须明确禁用，不能回退 Local。

## 4. Phase 1、模板与 Phase 2

| 项目 | 层级 | 当前状态 | 依赖 |
|---|---|---|---|
| Phase 1 母版 | 治理输入，不是运行时 Feature | Sol 已完成 7 sheets/183 字段/68 关系/21 v4 证据/180/180 源字段追溯/公式错误 0 | 用户整理业务值；随后发布首个 TemplateVersion |
| 新建与关联首切片 | 未来独立 Feature | 尚未交付 | 母版、默认文档、模板版本、Managed Content ledger、创建/关联 Operation |
| Phase 2 | 未来能力集合 | 尚未交付 | 只能通过版本化 Managed Content 查询 current/revision/relation/tombstone，不得读 Feature 私库猜测 |

母版最终文件见 [Phase 1 模板待办](../planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)。它用于模板治理、映射、规则和发布，不直接承载运行时用户上传值。

## 5. 额外部署与安装判断

1. 只处理 Core 本地数据的 Feature（未来删除聊天记录）只需安装 .ofp。
2. 读取/修改 Omnia 的 Feature 需要 .ofp 及其官方签名 .ofop 能力；公司电脑 Remote Operation host 只执行固定、签名、可审计的 step gate。
3. 所有 Omnia Feature 都需要 v5 Bridge 可达和独立 Remote Connector。首次路径是顶部 Connect 生成链接码 → 公司电脑 Connector 输入 → 同一 Connect 流程等待 Pack；Settings 没有 Connector 表单，不依赖旧 v4 脚本或静默回退。
4. 普通 Feature 不修改 Connector Core；优先新增或升级 Feature/Operation 包。只有公共 Gate/Transport/Supervisor 合同不足时才发布新 Connector 版本。
5. 构建器自动完成签名、成员 digest、安装验签和 sequence 检查；日常开发不要求人工逐文件 SHA。正式发布仍只接受官方签名包。

## 6. 状态词和维护规则

状态词按证据使用：设计、源码已实现、候选包已生成、可安装、运行时已接通、Local 已实测、Remote 已实测、已发布、待 canary。其中任何一项都不能自动推导下一项。

每次 Feature 开发或安装必须同步更新：Feature 包内四 Plane 文档、测试、版本/manifest、文档登记簿投影、实现/验收记录和本总览。若历史文档保留旧状态，必须明确标注“历史快照”，不得覆盖本页当前状态。
