# Connector Next v3

Connector Next 是旧 Remote Connector 的完全隔离替代产品，不是旧实现的升级分支。它只提供 Connector 平台能力，不包含录制、新建与关联、删除、底稿或任何 Feature 业务实现。

## 产品边界

- Product：`com.deloitte.omnia-agent.connector-next`
- Protocol：`omnia.connector-next/v3`
- API：`/connector-next/v3/*`
- 独立安装根：`%LOCALAPPDATA%/Programs/Omnia Agent Connector Next v3`
- 独立数据根：`%LOCALAPPDATA%/Omnia Agent Connector Next v3/data-v3`
- 独立 Startup：`Omnia Agent Connector Next v3.cmd`
- 独立 SQLite：服务端、Agent 身份、运行门和日志 spool 分库
- 不读取、导入或迁移旧 Pair、token、credential、managed-state、安装根、数据根或更新状态
- 旧 Bridge v2、`src/remote-connector` 与 `src/bridge` 已从工作区和构建链移除；不得重新引入。

Connector 唯一内建的非通用 operation 是自身诊断 `connector.next.system-health.read/v1`，返回真实 OS/Node/CPU/内存状态。Pack 操作通过独立签名 Operation 能力包注册并由通用宿主执行；Connector 不包含 Feature ID、元素类型、Risk-Control 映射或 Feature 状态机。未知 operation 和未经授权的 mutation 均 fail-close。

当前已发布客户端为 `0.1.21 / sequence 22`，服务端为 `0.1.8`。客户端在既有持久任务协议上增加最多八任务批量领取、服务端长轮询、Shell 对同一 job ID 的断线重附着，以及仅限明确 pre-effect 错误的 Pack 会话恢复。响应丢失的 mutation 仍不得重放。更早候选保留不可变历史，但不得用于新安装。

2026-08-11 的 Lower 回传期间观察到一次 Pack/Connector 会话丢失；同一 Run 的 durable command/receipt 状态未丢失，经过只读刷新后继续完成。该事实保留在发布记录中，不被描述为新版性能验收。按用户要求，本候选只做离线协议验证，不再开启新的真实回传测试。

发布顺序为服务端 `0.1.7 → 0.1.8`、Shell `0.4.14 → 0.4.15`、公司电脑 Agent `0.1.20/21/generation 17 → 0.1.21/22/generation 18`。Agent offer `ocn3.offer.623c63f2-3be3-4561-bfb3-7d619357c5d6` 已由 exact target 完成 candidate/probation 心跳并提交为 `succeeded`；该升级过程没有创建 Pack operation。

## 组件

```text
Shell/Core binding + control client
  -> Connector Next Server (SQLite + HTTPS API)
  -> durable jobs/results/logs/update offers

fixed Bootstrap
  -> current signed slot runtime/node.exe
  -> current signed updater.cjs
  -> current signed agent.cjs
```

固定 Bootstrap 只负责校验当前不可变槽并托管当前 Updater Runtime。Agent、Updater Runtime 和 Node Runtime 都属于同一个 Ed25519 签名版本，因此升级逻辑与运行时本身可以随 N→N+1 在线更换，不会再次要求人工覆盖 Updater。

## Agent 精确匹配

Shell 侧以 `agentId + deviceId` 为稳定主键，只生成并持久化一个 `connectorInstanceId`。一次性 Enrollment code 最长十分钟，仅可被 exact 三段身份消费一次。服务端只保存 token hash；后续请求同时校验：

- exact agent/device/connector instance；
- product/protocol；
- version/sequence/generation；
- capabilities；
- OS execution-principal subject；
- Agent、Updater、Bootstrap 或 Installer 的进程角色。

Shell binding 数据库和 Connector 数据库相互独立。`binding-enroll`、`binding-status`、`binding-get` 可完成稳定身份创建与状态调和，不允许每次启动随机生成新 Connector 身份。

## 全量日志回传

Agent、Updater、Bootstrap、Installer、protocol、task 和 audit 日志先以 `FULL synchronous` 写入本地 SQLite spool。上传到服务端后，服务端以 `target + clientRecordId` 幂等提交并返回 exact ACK；客户端只删除 ACK 的记录。断网或服务失败时保留未确认日志并持续重试。

spool 默认上限 16 MiB。超过硬上限时受控淘汰最旧记录，同时写入 `spool.capacity_eviction` 审计记录，避免无限占盘。认证、cookie、password、secret、token、credential、enrollment code 等字段在本地入库前和服务端落库前双重脱敏。

服务端日志查询必须携带 exact agent/device/connector instance，可再按版本与 generation 过滤。

## 远程在线升级

1. 服务端登记 Ed25519 签名 manifest 和 gzip Connector package，再为 exact target 创建 offer。
2. Updater 每 15 秒轮询；下载后校验 product/protocol/key/signature/size/package digest 和每个成员 digest。
3. 包含 `agent.cjs`、`updater.cjs`、`runtime/node.exe` 的版本落入不可变 `slots/<a|b>/<sequence>-<manifestDigest>/`。
4. 候选 Agent 以 health-only 模式向真实服务端做 target/token/new-generation heartbeat，不领取业务 job。
5. Updater 原子关闭 admission，等待 read-only lease 排空；任何 active/uncertain mutation 均阻断升级。
6. 停旧 Agent，写 previous/current 指针，启动新 Agent probation；服务端和本地 exact generation 均提交后才重新开放 admission。
7. 新代提交后旧 Updater Runtime 退出；固定 Bootstrap 重新读取签名 current slot，并以新 Node Runtime 启动新 Updater Runtime。
8. 候选启动或 probation 失败时恢复 previous pointer 并重启旧 Agent。服务端已提交而本地状态尚未落盘的崩溃窗口，会在 Bootstrap 重启后通过 exact identity API 幂等补完。

一次初始安装后，后续升级只需在服务端创建 offer，公司电脑无需再次手动执行安装包。

## 服务端运行

本机开发可使用 loopback HTTP。任何非 loopback 监听都必须提供 TLS key/certificate，否则服务端启动即失败。

```powershell
$env:OMNIA_CONNECTOR_NEXT_SERVER_DATA_ROOT='D:\ConnectorNextServerData'
$env:OMNIA_CONNECTOR_NEXT_CONTROL_TOKEN='<至少24字符的独立控制令牌>'
$env:OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID='<publisher key id>'
$env:OMNIA_CONNECTOR_NEXT_PUBLISHER_PUBLIC_KEY='<PEM>'
$env:OMNIA_CONNECTOR_NEXT_SERVER_HOST='0.0.0.0'
$env:OMNIA_CONNECTOR_NEXT_SERVER_TLS_KEY_FILE='D:\tls\server.key'
$env:OMNIA_CONNECTOR_NEXT_SERVER_TLS_CERT_FILE='D:\tls\server.crt'
npm run connector-next:server
```

控制令牌、TLS 私钥和 publisher 私钥都不得写入仓库或候选包。

## 构建与发布

```powershell
npm run build
npx tsx --test tests/connector-next-e2e.test.ts

$env:OMNIA_CONNECTOR_NEXT_PACKAGE_VERSION='0.1.0'
$env:OMNIA_CONNECTOR_NEXT_PACKAGE_SEQUENCE='1'
$env:OMNIA_CONNECTOR_NEXT_PUBLISHER_KEY_ID='<key id>'
$env:OMNIA_CONNECTOR_NEXT_PUBLISHER_PRIVATE_KEY_FILE='<repo外的Ed25519 PKCS8 PEM>'
npm run package:connector-next-candidate
```

候选输出到 ignored 的 `connector-next/candidates/<version>-<sequence>/`，包含自带 Node Runtime、Installer、Bootstrap、签名 package、manifest、公钥和 `InstallConnectorNext.ps1`。目录已存在时拒绝覆盖。

服务端可用 `npm run package:connector-next-server` 生成独立部署目录；控制令牌与 TLS 私钥仍由部署环境提供。

## 当前验收与未完成项

已通过的窄验收覆盖：远端明文 HTTP 拒绝、非 loopback 无 TLS 拒绝、稳定 Agent/device/instance Enrollment、真实 OS health job/result、日志落盘/上传/查询/ACK 删除、离线 spool 上限、mutation uncertain 升级阻断、连续 N→N+1→N+2 签名更新、真实候选 heartbeat/probation、旧进程退出和多代不可变槽。

此外，冻结的 `0.1.2 / sequence 3` 已在隔离根完成真实自包含安装；服务端随后向该实例推送临时 `0.1.3 / sequence 4`，验证旧 Updater 退出、Bootstrap 从新签名槽启动新 Updater Runtime、服务端与本地 generation 提交为 2，以及升级后的 Agent 继续完成 health job。该验收不触碰旧 Connector 根或公司电脑。

尚未执行公司电脑安装、正式 HTTPS 服务部署、组织代码签名或真实 Omnia/Pack canary。Feature 业务不属于 Connector Next 源码范围，也不得作为“补全 Connector”的方式加入本目录。
