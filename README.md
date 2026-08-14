# Omnia Agent v5

Omnia Agent v5 是 Windows Shell、独立 Feature 包和 Connector Next 的工作区。旧 Remote Connector/Bridge 已退出构建与发布链。开发前先读 [AGENTS.md](AGENTS.md) 与 [Agent 开发入口](docs/development/AGENT_START_HERE.md)。

## 公司电脑本地便携版

仓库当前可验证的公开 Tag 为 [v0.4.15-company-loopback-r1](https://github.com/coAtlus0916/omnia-agent-v2/releases/tag/v0.4.15-company-loopback-r1)。完整解压后双击 `Start Omnia Agent v5.cmd`；Shell 会自动在本机启动 Connector Next Server 与 Agent 并连接 `127.0.0.1`，不经过远程 Connector 服务器。

本工作区另有一份 2026-08-14 从 `c1b57b3` 干净快照生成、尚未由当前 Git Tag 表示的本地 `0.4.18` 自包含产物。其冻结内置集合为：Create & Associate `0.2.150 / sequence 152`、Recording `0.4.21 / sequence 34`、Delete Elements `0.3.32 / sequence 1786632995691`、Workpaper Preparation `0.1.71 / sequence 72`。ZIP 为 `160741402` 字节，SHA-256 为 `ECEC56AF636C17DA5FD750B6023583BA1F0D4CECD435727D85D4B1521FD64EE1`。本地产物不能自动解释为已经公开发布或已经通过真实 Pack canary。

## 当前源码状态

状态基线：`integration/remote@c1b57b3`，2026-08-14。Shell 源码版本是 `0.4.18`，唯一 Connector 实现为 Connector Next v3。四个官方 Feature 的便携冻结身份为：

| Feature | 当前构建身份 | 当前事实与验收边界 |
|---|---:|---|
| `omnia.create-associate` | `0.2.150 / sequence 152` | 已跟踪签名候选并进入 2026-08-14 本地便携产物；签名、摘要和内嵌 Operation 一致性已验证，真实 Pack live acceptance 仍 pending。 |
| `omnia.delete-elements` | `0.3.32 / sequence 1786632995691` | 已进入 2026-08-14 本地便携产物；当前精确 digest 的完整真实删除 canary 不能由历史版本继承。 |
| `omnia.recording` | `0.4.21 / sequence 34` | 已进入 2026-08-14 本地便携产物；历史现场录制证据不自动覆盖当前精确 digest。 |
| `omnia.workpaper-preparation` | `0.1.71 / sequence 72` | 已包含富文本 JSON 写回、嵌套制度 ZIP 和单制度模板重绑定，并进入本地便携产物；真实 Pack 写回 canary 仍 pending。 |

当前 `company-loopback-current` inventory、便携构建期望、复制列表、manifest 和使用说明已收敛到上述四个精确身份。产物使用 Shell 内置 Connector Next Server 与 Agent，仅监听 `127.0.0.1`；`remoteServerRequired` 为 `false`，不走远程 Connector 服务器。

上述“构建身份”“本地产物”和“真实 canary”是三个不同状态。候选文件、自动化测试、历史 hash 或历史 canary 都不能替代当前精确源码和 digest 的验收。

四 Feature 的独立性不变量、历史审计问题和当前关闭证据见 [四 Feature 独立性审计](docs/architecture/FEATURE_INDEPENDENCE.md)。自动化通过不替代未完成的当前版本 live acceptance。

## 安装与运行

从源码运行需要 Windows 10/11 和 Node.js 24；便携包自带运行时。

```powershell
npm install
npm run check
npm start
```

开发和构建：

```powershell
npm run dev
npm run build
```

Feature 候选打包：

```powershell
npm run package:create-associate-feature
npm run package:delete-feature
npm run package:recording-feature
node scripts/package-workpaper-preparation-feature.mjs
```

Workpaper 目前没有 `package.json` script；直接 Node 命令是当前事实，不代表四包发布工作流已统一。开发中工作树没有冻结前，不应运行发布打包命令或覆盖任何历史候选。

Shell 与 Connector Next 的候选命令：

```powershell
npm run package:windows
npm run package:connector-next-candidate
npm run package:connector-next-server
npm run package:create-associate-next-portable
npm run package:company-next-loopback-portable
```

公司电脑自包含版使用最后一条命令。该包在本机启动 Connector Next Server 与 Agent，Shell 自动连接 `127.0.0.1`，不经过远程 Connector 服务器。重复构建、核验与 GitHub Release 发布步骤见 [公司本地 Connector Next 便携包发布指南](docs/development/COMPANY_LOOPBACK_PORTABLE_RELEASE.md)。

正式发布只接受官方签名包。Feature/Operation 的签名、成员 digest、安装验签和 sequence 由工具验证；同一版本不得重签为另一 digest。

## 架构边界

- Shell 只渲染签名导航、Surface 和真实状态，不按 Feature ID 实现业务 UI。
- 每个 Feature 在独立 Worker 子进程运行，并拥有 `data/features/<featureId>/store.sqlite` 和 Feature-scoped Artifact 路径。
- Core 是 activation head、Run、Artifact、Command、Receipt 和恢复账本的 system of record。
- Connector 只负责 Transport、Session、Gate 和签名 Operation host；无 Local fallback，也不得包含 Feature 业务分支。
- Omnia mutation 必须经过官方签名 Operation、预检、显式确认、幂等身份和写后读回；结果不确定时禁止自动重放。

当前 Worker 隔离是进程故障隔离，不是 OS 安全沙箱；详细现状见 [系统架构](docs/architecture/SYSTEM_ARCHITECTURE.md) 与 [Feature Package 标准](docs/architecture/FEATURE_PACKAGE_STANDARD.md)。

## 文档入口

- [文档中心](docs/README.md)
- [四 Feature 独立性审计](docs/architecture/FEATURE_INDEPENDENCE.md)
- [系统架构](docs/architecture/SYSTEM_ARCHITECTURE.md)
- [Feature Package 标准](docs/architecture/FEATURE_PACKAGE_STANDARD.md)
- [统一合同](docs/contracts/CONTRACTS.md)
- [Connector Gate](docs/architecture/CONNECTOR_GATE.md)
- [Feature 包总览](docs/implementation/FEATURE_PACKAGE_CATALOG.md)

自动化合同测试、fixture、mock Connector、只读 probe 和候选打包都不等于真实 Omnia mutation。未在授权 Pack、公司电脑和精确当前 digest 完成的现场验证必须保持 `pending`，不能用 sample 或硬编码数据代替。
