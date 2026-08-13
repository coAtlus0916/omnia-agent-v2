# Omnia Agent v5 系统架构

状态：实现现状与目标边界（2026-08-13）

产品版本：Shell 源码 `0.4.18`
传输决策：Remote-only；无 Local Connector fallback

这份文档只描述当前可从源码验证的架构。四个官方 Feature 的独立性尚未通过发布门禁，详见 [Feature 独立性审计](FEATURE_INDEPENDENCE.md)。

## 1. 运行边界

```mermaid
flowchart LR
    UI["Shell / Renderer\n声明式导航与 Surface"]
    CORE["Main / Core\nPackageManager、Run、Artifact、Receipt"]
    W1["Feature Worker\n每 Feature 独立子进程"]
    OP["签名 Operation\nroute / effect / policy"]
    RC["Connector Next\nTransport、Session、Gate、Operation Host"]
    OMNIA["Omnia / 授权 Pack"]

    UI <-->|"类型化 IPC / action"| CORE
    CORE <-->|"版本化 Worker ports"| W1
    W1 -->|"精确 Feature/version/digest invocation"| CORE
    CORE -->|"注册并调用"| OP
    OP -->|"受限 HTTP route"| RC
    RC --> OMNIA
```

- Shell 只渲染签名导航和 Surface，不保存 Feature 业务真相。
- PackageManager 负责验签、不可变包目录、sequence、activation head、Worker 生命周期与 Operation 注册。
- 每个 Feature 在独立 Node 子进程运行；进程隔离目前不是 OS sandbox，Worker 仍继承父进程环境。
- Core 是 Run、Artifact、Command、Receipt、confirmation 和恢复账本的 system of record。
- Connector Next 只拥有凭据、Session、Pack binding、通用 Gate、声明式 Operation host 与 read-back transport。

## 2. 数据所有权

| 数据 | 物理位置/所有者 | 必须绑定的身份 |
|---|---|---|
| 激活头、包登记、发布 sequence | Core SQLite | `featureId + version + packageDigest + generation` |
| Run/Artifact/Command/Receipt | Core SQLite 与 `data/features/<featureId>/artifacts` | Feature、版本、Run、Operation digest、authority |
| Feature 私有状态 | `data/features/<featureId>/store.sqlite` | 单一 Feature namespace 与迁移版本 |
| Worker 临时文件 | Feature-scoped temp root | Feature、Run、handle、digest、TTL |
| Session/credential | Connector/平台保护存储 | Connector、authority、tenant/org、Pack、generation |

Core 共享表只应保存通用控制面事实。业务 Schema、Feature 专属恢复算法和特定版本兼容规则应留在签名 Feature 包，或通过通用版本化合同进入平台；不得作为 Feature ID 分支写入共享 Store。

## 3. 激活与故障语义

正常目标序列是：验签并落不可变候选 → 校验迁移/导航/Operation → 启动候选 Worker → 远端 Operation prepare/commit → CAS 切换 head → 停旧 Worker → finalize。启动或交接失败时旧 head 和旧 Worker 保持权威。

当前实现已有 durable Operation handoff ledger、activation-head CAS、按 Feature 的 supervisor map、Runtime `storePorts` 声明检查，以及 mutation Worker 超时/退出后的 fail-closed recovery。2026-08-10 独立性审计指出的 Operation 交接、回滚、私有迁移和共享资源 owner 问题在分支上已有后续修改，但尚未对 2026-08-13 精确工作树重新执行完整四 Feature 共存、升级、失败升级、回滚和恶意跨包矩阵。

因此当前仍不能从“代码存在”或“可安装候选”推导出“当前版本已独立升级、回滚和持久恢复”。发布冻结前必须刷新独立性审计的代码证据和行号，并以精确候选执行完整矩阵。

## 4. 安全与业务边界

- Connector Next 禁止包含 Feature ID、Feature 版本或 Feature 业务分支；业务只存在于独立签名 Feature/Operation 包。
- Mutation 必须由官方签名 Operation 发起，绑定精确 package digest、effect、route、authority、session generation、plan/request digest 和幂等身份。
- 响应丢失或进程崩溃后的 mutation 不自动重放；只能用 receipt 和只读 read-back 进入 reconcile。
- Worker 子进程不是强权限边界。正式安全声明前还需要最小环境、文件系统/网络限制、资源配额与逃逸测试。

## 5. 当前官方 Feature 源码候选

| Feature | 当前构建身份 | sequence | 当前说明 |
|---|---:|---:|---|
| `omnia.create-associate` | `0.2.150` | 152 | HEAD 已包含在途 mutation 重启门禁和包身份提升；本地未跟踪候选不是发布证据，当前精确 digest 的安装验证与 live acceptance pending。 |
| `omnia.delete-elements` | `0.3.31` | 1786522815131 | 构建脚本与本地便携内置产物存在；当前精确 digest live acceptance pending。 |
| `omnia.recording` | `0.4.21` | 34 | 构建脚本与本地便携内置产物存在；当前精确 digest live acceptance pending。 |
| `omnia.workpaper-preparation` | `0.1.58` | 59 | HEAD 已包含单表模板、写回胶囊和一步选择流程；直接 Node 打包入口存在，npm 发布入口仍缺失，本地未跟踪候选尚未形成发布或 live acceptance 证据。 |

“构建身份”仅指脚本当前会声明的包身份，不表示源码已经冻结、候选可重现、已安装、已推广或已在授权 Pack 通过。工作树修改与既有同版本候选不一致时，历史候选保持不可变，源码必须提升版本/sequence 后才能重新打包。

## 6. 相关合同

- [Feature Package 标准](FEATURE_PACKAGE_STANDARD.md)
- [Feature 独立性审计](FEATURE_INDEPENDENCE.md)
- [统一合同](../contracts/CONTRACTS.md)
- [Connector Gate](CONNECTOR_GATE.md)
- [数据与存储](../data/DATA_AND_STORAGE.md)

旧 Remote Connector/Bridge 已退出源码构建、发布资产与运行选择；当前唯一 Connector 实现为 Connector Next。
