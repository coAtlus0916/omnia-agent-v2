# 公司本地 Connector Next 便携包发布指南

## 1. 目标

本指南用于把当前 Omnia Agent v5 工作区打成公司电脑可直接使用的自包含 ZIP。启动后：

1. `Start Omnia Agent v5.cmd` 启动包内 `portable-launcher.cjs`；
2. 启动器只监听本机 `127.0.0.1`，启动 Connector Next Server；
3. 启动器创建或读取受当前 Windows 用户保护的本地 Connector 身份；
4. 启动 Connector Next Agent，完成本地 enrollment 和健康检查；
5. 将本地 Server URL 与精确 agent/device/instance 身份写入 Shell Core Store；
6. 启动 Shell，Shell 自动使用 Connector Next，不依赖旧 Connector、Bridge、远程 Connector 服务器或配对码。

Connector Next 只能承载通用 Pack Session、Gate 和签名 Operation。Feature 业务代码、Feature ID 分支和业务模板不得写入 `src/connector-next` 或包内 `connector-next/*.cjs`。

## 2. 当前固定内容

便携 profile 为 `company-loopback-current`，唯一来源是：

```text
src/main/features/builtin-release-inventory.ts
```

当前冻结集合：

| Feature | 版本 | sequence |
|---|---:|---:|
| `omnia.create-associate` | `0.2.134` | `136` |
| `omnia.recording` | `0.4.20` | `33` |
| `omnia.delete-elements` | `0.2.1` | `8` |

Workpaper 当前保持 post-install，不得在没有已接受不可变包时伪装成内置 Feature。

## 3. 构建前提

- Windows x64；
- 当前仓库依赖已安装；
- `.codex-tmp/python-runtime/cpython-3.13.14-embed-amd64` 已由项目脚本准备；
- 三个候选文件存在且与 inventory 中的文件 SHA、签名身份和 package digest 完全一致；
- 工作树不得包含 API key、`.env`、SQLite 数据、Chromium profile、Connector 本地身份或日志。

API key 只能在运行时由 Windows 保护的设置存储提供，不得写入源码、脚本、Feature 包、便携 ZIP 或 GitHub Release 文案。

## 4. 一条命令构建

```powershell
npm run package:company-next-loopback-portable
```

脚本会：

- 以 `OMNIA_AGENT_BUILTIN_PROFILE=company-loopback-current` 构建 Shell 与 Connector Next；
- 再次验证每个内置 Feature 的官方签名、版本、sequence、文件 SHA 和 package digest；
- 复制 Electron、包内 Python、Playwright CDP 运行依赖、三个 Feature 和 Connector Next；
- 写入 `portable-root.json`、`current` 与 `release-manifest.json`；
- 生成带 UTF-8 BOM 的 `使用说明.txt`；
- 原子发布目录并生成不可变 ZIP；目标已存在时拒绝覆盖。

输出位于：

```text
artifacts/Omnia-Agent-v5-<Shell版本>-Company-Loopback-Portable-<日期>-r<修订>/
artifacts/Omnia-Agent-v5-<Shell版本>-Company-Loopback-Portable-<日期>-r<修订>.zip
```

如需重打，必须提升文件名中的修订号或版本；不得覆写已经分发的同名 ZIP。

## 5. 必做核验

读取产物中的 `release-manifest.json` 和 `portable-root.json`，必须同时满足：

```text
builtinProfile = company-loopback-current
connectorTransport = connector-next-loopback
topology = embedded-loopback
remoteServerRequired = false
```

并核对：

- `resources/app/builtins` 只有 inventory 声明的当前集合；
- `connector-next` 包含 `server.cjs`、`agent.cjs`、`portable-launcher.cjs`；
- `portable-launcher.cjs` 的运行 URL 是动态本地端口 `http://127.0.0.1:<port>/connector-next/v3/`；
- `connector-next` 目录没有官方 Feature ID；
- 包中没有远程 Connector endpoint、API key、`.env`、`data` 运行内容或 `connector-next-data-v3`；
- 计算并记录 ZIP SHA-256 与字节数。

当前 `20260812-r1` 核验值：

```text
文件：Omnia-Agent-v5-0.4.15-Company-Loopback-Portable-20260812-r1.zip
字节：160427807
SHA-256：2CC9E34ACF070B9D1F126AD5F5D6CE5E064E13C7070266C11E7485CD37DB8F5F
```

## 6. 公司电脑使用

1. 完整解压 ZIP 到当前用户可写的本地目录；不得直接在 ZIP 内运行；
2. 双击 `Start Omnia Agent v5.cmd`；
3. 不要直接运行版本目录中的 `Omnia Agent v5.exe`；
4. 可变数据位于便携根的 `data` 与 `connector-next-data-v3`；替换版本时先保留这两个目录；
5. 日志位于 `connector-next-data-v3/logs`。

本模式不连接远程 Connector 服务器，因此没有服务器下发的 Connector 更新。更新方式是发布新的不可变 ZIP；启动器仍会自动完成新包内 Shell 与本机 Connector Next 的连接。

## 7. GitHub 发布

源码只进入 Git `main`；大 ZIP 作为 GitHub Release asset 上传，不进入 Git 对象：

```powershell
gh release upload v0.4.15 `
  artifacts/Omnia-Agent-v5-0.4.15-Company-Loopback-Portable-20260812-r1.zip `
  --repo coAtlus0916/omnia-agent-v2
```

Release 文案必须列出精确 Feature 版本、loopback 拓扑、SHA-256、未包含 Secret，以及“候选/已验收”的真实状态。新资产确认可下载且 digest 正确后，才能删除被其替代的旧资产。

## 8. 下次更新清单

1. 只在新候选已经冻结且验签后更新 `COMPANY_LOOPBACK_CURRENT_FEATURE_RELEASE_INVENTORY`；
2. 更新 inventory 中版本、sequence、文件 SHA 和 package digest；
3. 若 Shell 或 Connector Next 变更，提升相应版本/sequence；
4. 修改打包脚本中的不可变 artifact 修订名；
5. 构建、核对 manifest、扫描 Secret、计算 ZIP SHA；
6. 提交源码；
7. 上传新 Release asset；
8. 在公司电脑完整解压并从 CMD 入口启动，验证本地自动绑定与 Pack connect；
9. 在新包得到实际确认前保留上一份可回退 ZIP。
