# 公司本地 Connector Next 单 EXE 便携包发布指南

## 1. 发布目标

公司便携包是一个完全本地、自包含的 Windows ZIP。用户完整解压后，直接运行版本目录中的 `Omnia Agent v5.exe`；根目录的 `Start Omnia Agent v5.cmd` 只是一条兼容快捷入口，不再承载 Server、Agent 或监听窗口。

主 EXE 负责启动并持有同一进程树中的：

- Shell 主进程与 Renderer；
- Connector Next loopback Server；
- Connector Next Agent；
- 当前已签名 Feature 的独立 Worker。

关闭主窗口时，主 EXE 会等待 Connector、Feature Worker 和本地 Server 退出。Connector Next Server 与 Agent 的脚本位于版本目录的 `resources/app/connector-next`，不再作为便携包根目录外置组件，也不要求用户保持一个空白 CMD 窗口。

本模式只监听 `127.0.0.1`，不依赖远程 Connector 服务器、旧 Connector、Bridge v2 或配对码。

## 2. Feature 边界

便携 profile 固定为 `company-loopback-current`，唯一清单来源为：

```text
src/main/features/builtin-release-inventory.ts
```

当前集合必须与在线测试版一致：

| Feature | 版本 | sequence |
|---|---:|---:|
| `omnia.create-associate` | `0.2.150` | `152` |
| `omnia.recording` | `0.4.21` | `34` |
| `omnia.delete-elements` | `0.3.32` | `1786632995691` |
| `omnia.workpaper-preparation` | `0.1.81` | `82` |

Feature 包位于 `resources/app/builtins`，安装后各自在独立 Worker 中运行。Connector Next 只能实现通用 Pack Session、传输、Gate、签名 Operation 注册与调用；不得包含 Feature 业务规则、Feature ID 分支、模板或业务数据。

## 3. 构建前提

- Windows x64；
- npm 依赖完整；
- `.codex-tmp/python-runtime/cpython-3.13.14-embed-amd64` 已准备；
- 四个候选 OFP 均已冻结，并与清单中的官方签名、版本、sequence、文件 SHA 和 package digest 完全一致；
- 工作树和产物不得包含 API key、`.env`、SQLite 运行数据、Chromium profile、Connector 身份或测试日志。

API key 只能由运行时的 Windows 保护存储提供，严禁写入源码、脚本、Feature 包、便携 ZIP 或发布说明。

## 4. 构建命令

```powershell
npm run package:company-next-loopback-portable
```

构建脚本会：

1. 使用 `company-loopback-current` 清单构建 Shell 与 Connector Next；
2. 校验四个 Feature 的签名、身份和摘要；
3. 把 Server、Agent、Playwright CDP 运行依赖放入 EXE 版本目录；
4. 写入 `portable-root.json`、`current` 和 `release-manifest.json`；
5. 生成 CMD/PowerShell 兼容快捷入口与使用说明；
6. 原子发布目录并生成 ZIP；同名产物已存在时拒绝覆盖。

输出：

```text
artifacts/Omnia-Agent-v5-<Shell版本>-Company-Loopback-Portable-<日期>-r<修订>/
artifacts/Omnia-Agent-v5-<Shell版本>-Company-Loopback-Portable-<日期>-r<修订>.zip
```

## 5. 必做验收

`portable-root.json` 与 `release-manifest.json` 必须满足：

```text
builtinProfile = company-loopback-current
connectorTransport = connector-next-loopback
launchMode = single-exe-host
topology = embedded-exe-host
remoteServerRequired = false
```

还必须验证：

- 便携根没有外置 `connector-next` 目录；
- `resources/app/connector-next` 只有通用 Server、Agent 和运行依赖；
- `resources/app/builtins` 精确包含清单中的四个签名 Feature；
- 从干净目录启动主 EXE 后，Renderer、Server、Agent 和四个 Feature Worker 都是主 EXE 的受控子进程；
- Core 数据库中四个 `feature_activation_heads` 均为 `runtime_enabled=1`，registry 均为 `active/ready`；
- 正常关闭主窗口后，同一版本 EXE 的整个进程树归零；
- ZIP 不包含 `data`、`connector-next-data-v3`、测试日志、API key 或 `.env`。

## 6. 当前验收产物

```text
文件：Omnia-Agent-v5-0.4.18-Company-Loopback-Portable-20260814-r2.zip
来源：main@7d3e803
字节：160774159
SHA-256：97C298DD3806BF7D347EF8A05911DD71E12637C631690BCF18B39C7C79255FF9
```

r2 已确认 ZIP CRC、250 个文件逐项与发布目录一致、四个签名 Feature 精确身份、关键文件 manifest 摘要以及 `connector-next-loopback / embedded-exe-host / remoteServerRequired=false`。便携根没有外置 Connector 目录，ZIP 不含运行数据库、日志、`.env`、`connector-next-data-v3` 或非空 `data`。本机构建未启动 Omnia；公司电脑上的真实 EXE/Pack canary 仍需单独执行。

## 7. 上一份验收产物

```text
文件：Omnia-Agent-v5-0.4.18-Company-Loopback-Portable-20260814-r1.zip
来源：integration/remote@c1b57b3
字节：160741402
SHA-256：ECEC56AF636C17DA5FD750B6023583BA1F0D4CECD435727D85D4B1521FD64EE1
```

该 r1 产物已确认 ZIP CRC、248 个文件逐项一致、四个签名 Feature 精确身份、关键文件 manifest 摘要以及 `connector-next-loopback / embedded-exe-host / remoteServerRequired=false`。它仍冻结 Workpaper 0.1.71，属于历史产物；当前 0.1.81 清单必须生成新的 r2。真实 EXE、四个 Feature 激活和公司电脑 Pack canary 仍需在公司电脑执行，不能由本机构建替代。

## 8. 公司电脑使用

1. 完整解压 ZIP 到当前用户可写的本地目录，不能直接在 ZIP 内运行；
2. 直接双击 `<版本>\Omnia Agent v5.exe`；也可双击根目录 `Start Omnia Agent v5.cmd`，它只负责启动同一个 EXE；
3. 不需要单独启动 Connector，不需要保持 CMD 窗口，不需要填写本地 Connector 配置；
4. 可变数据保存在便携根的 `data` 与 `connector-next-data-v3`；更新版本时应保留这两个目录；
5. 本模式不连接远程 Connector 更新服务器。更新时发布新的不可变 ZIP，由新包内主 EXE继续自动连接其内置 Connector Next。

## 9. 下次更新

1. 新候选冻结并验签后，更新 `COMPANY_LOOPBACK_CURRENT_FEATURE_RELEASE_INVENTORY`；
2. 同步版本、sequence、文件 SHA 和 package digest；
3. 提升 Shell 版本或产物修订号，禁止覆写已分发 ZIP；
4. 构建后执行上述单 EXE、四 Feature、关闭进程树和 Secret 扫描；
5. 记录 ZIP 字节数和 SHA-256；
6. 在新包真实确认前保留上一份可回退 ZIP。
