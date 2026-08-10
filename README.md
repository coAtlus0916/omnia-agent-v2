# Omnia Agent v5

Omnia Agent v5 是 Remote-only Windows Shell、独立 Feature 包和 Remote Connector 的工作区。开发前先读 [AGENTS.md](AGENTS.md) 与 [Agent 开发入口](docs/development/AGENT_START_HERE.md)。

## 当前源码状态

Shell 源码版本是 `0.4.15`。四个官方 Feature 的构建脚本当前指向：

| Feature | 源码候选 | sequence | 当前验收状态 |
|---|---:|---:|---|
| `omnia.create-associate` | `0.2.103` | 105 | 当前版本 live acceptance pending |
| `omnia.delete-elements` | `0.3.20` | 29 | 当前版本 live acceptance pending |
| `omnia.recording` | `0.4.19` | 32 | 当前版本 live acceptance pending |
| `omnia.workpaper-preparation` | `0.1.3` | 4 | npm 发布入口与当前版本 live acceptance pending |

这些是源码候选，不表示已安装、已推广或已在授权 Omnia Pack 通过。历史版本的候选、hash 和 canary 只证明对应历史产物。

四 Feature 独立性当前**未通过发布门禁**：Core 仍含 Feature ID/版本业务特判且未执行 Runtime Store allowlist，Operation 升级/回滚协议未闭环，Windows Builtin catalog 要求 Create `0.2.48` 而打包脚本复制 `0.2.43`。证据、影响与关闭条件见 [四 Feature 独立性审计](docs/architecture/FEATURE_INDEPENDENCE.md)。

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

Workpaper 目前没有 `package.json` script；直接 Node 命令是当前事实，不代表四包发布工作流已统一。

Shell、Remote Connector 与 Bridge 的候选命令：

```powershell
npm run package:windows
npm run package:remote-connector-candidate
npm run package:bridge
```

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
