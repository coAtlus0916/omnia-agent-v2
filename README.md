# Omnia Agent v5

这是 Omnia Agent v5 的独立工作区。开发者先阅读根目录 [AGENTS.md](AGENTS.md)，再按 [Agent 开发入口](docs/development/AGENT_START_HERE.md) 的固定必读包和专项路由工作。

## 当前候选状态（2026-08-03）

| 层级 | 当前事实 | 未完成边界 |
|---|---|---|
| Shell | `0.4.2` Remote-only 候选；继承 0.4.1 UI regression 修复，删除 Local/模式切换/Connector Settings | 自动化/便携结果以验收记录为准；真实目标 Pack 与完整 Windows DPI 矩阵仍需授权环境 canary |
| 内置独立 Feature | 官方签名 `omnia.recording 0.1.1 / sequence 2` 随 Shell 放入并首次启动自动升级/注册；不是 Shell 硬编码业务，显式 rollback 保持 | 录制真实公司 Pack/Remote 跨 Bridge 现场仍待 canary |
| 后装独立 Feature | 官方签名“删除元素”`0.1.2`；安装和状态逻辑已接通，旧 Local 自动化仅保留为历史合同证据 | 目标 Pack 的真实 Remote 删除待公司电脑 canary；不允许 fallback Local |
| 未交付 Feature | 删除聊天记录、新建与关联 | 仍只有设计/评估，不应显示假入口 |
| Phase 1 母版 | Sol 已完成：7 sheets、183 字段、68 条 Risk-Control 关系、21 条 v4 证据、180/180 源字段追溯、公式错误 0 | 用户整理业务值，之后发布首个 `TemplateVersion`；母版是治理输入，不是运行时用户值 |
| Remote | 唯一 Connector 产品链；候选 Remote Connector `0.3.5 / sequence 8`、Bridge `0.4.1`，首次一次性链接码、后续 protected binding、heartbeat/state、无 Local fallback | 公司电脑真实 Pack canary 未通过/待 canary；0.3.4/0.4.0 和 v4 更新通道不变 |
| AI | DeepSeek 与 OpenAI-compatible Custom 可配置 | Nova 专有协议当前不校验 |

完整层级和“原装/内置/后装/Operation/额外部署”边界见 [Feature 包总览](docs/implementation/FEATURE_PACKAGE_CATALOG.md)。

## 安装与运行

Windows 10/11、Microsoft Edge 和 Node.js 24（从源码运行时）是支持环境；便携包自带运行时。

```powershell
npm install
npm run check
npm start
```

开发运行或仅构建：

```powershell
npm run dev
npm run build
```

当前便携包命令：

```powershell
npm run package:windows
npm run package:recording-feature
npm run package:delete-feature
npm run package:delete-feature-installer
npm run package:remote-connector
npm run package:bridge
```

Feature/Operation 的签名、成员 digest、安装验签和 sequence 检查由工具自动完成；开发者不需要逐次手工计算或复制 SHA。正式发布只接受官方签名包。

## Remote-only Connector

Shell 不再包含 Local Connector、Local/Remote 模式切换或 fallback。第一次点击顶部 Connect 时，Shell 建立短期 pairing session 并显示一次性链接码；用户在公司电脑 Remote Connector 输入。配对成功后 Shell/Connector 分别以 safeStorage/DPAPI 保护长期 credential，正常启动、重启和断线恢复不再需要链接码。

诊断、重新配对和解除绑定都从 Connect 错误/详情进入；Settings 没有 Connector 子菜单。Remote 使用独立 v5 Bridge、安装根、数据根和更新通道，不读取、停止、升级或复用 v4 Connector。架构见 [ADR-0035](docs/adr/0035-remote-only-connector-and-link-code-pairing.md)，部署与版本见 [Remote Connector 0.3.5 发布记录](docs/implementation/REMOTE_CONNECTOR_0_3_5_RELEASE.md)和 [Bridge 部署合同](docs/implementation/V5_BRIDGE_DEPLOYMENT.md)。

## 数据根与安全边界

稳定产品根下的 `data/` 保存 v5 Core SQLite、附件、模板、Evidence、文档登记和运行状态；凭据由 Main/平台保护，不返回 Renderer，不写日志。便携数据与 release/update 目录隔离。Omnia 写入只能经官方签名 Operation，必须有预检、确认、幂等、写后读回以及 `uncertain/reconcile` 处理。

四 Plane 的责任是：前台只负责交互和资料接收；中台负责 Feature 编排；后台负责模板、Managed Content、Evidence 和版本；Connector 只负责 Transport/Session/Gate/Operation host。详见 [系统架构](docs/architecture/SYSTEM_ARCHITECTURE.md)、[统一合同](docs/contracts/CONTRACTS.md) 和 [Connector Gate](docs/architecture/CONNECTOR_GATE.md)。

## 文档入口

- [Agent 开发入口](docs/development/AGENT_START_HERE.md)
- [文档中心](docs/README.md)
- [开发手册](docs/development/DEVELOPMENT_PLAYBOOK.md)
- [Shell 实现映射](docs/implementation/SHELL_IMPLEMENTATION_MAP.md)
- [v4 复用清单](docs/implementation/V4_REUSE_MANIFEST.md)
- [录制实现](docs/implementation/RECORDING_FEATURE.md)
- [Remote-only 迁移说明](docs/implementation/REMOTE_ONLY_MIGRATION.md)
- [Shell 0.4.2 Remote-only 验收](docs/reviews/SHELL_0_4_2_REMOTE_ONLY_ACCEPTANCE.md)
- [Phase 1 母版待办与最终工作簿](docs/planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)
- [新建与关联四 Plane 评估](docs/research/V4_CREATE_ASSOCIATE_FOUR_PLANE_GAP_ASSESSMENT.md)

## 真实验证声明

自动化合同、安装、状态、签名包和 Bridge/Remote 传输测试不等于真实 Omnia mutation。凡未在授权 Pack、公司电脑或真实 Provider 上完成的部分，文档和 UI 必须保持“待 canary/不可用”状态，不得用 fixture、sample 或硬编码数据代替。

## 历史快照

仓库内的旧 `0.1.x`、`0.2.x` 验收记录以及 v4 研究报告保留作为当时证据。它们可能写着“无 v5 Feature”“Remote host 未发布”或“Phase 1 尚未制作”；这些都是历史快照，不覆盖本页和 [Feature 包总览](docs/implementation/FEATURE_PACKAGE_CATALOG.md) 的当前状态。
