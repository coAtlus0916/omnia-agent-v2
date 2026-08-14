# v5 Shell 与 Feature 包总览

状态日期：2026-08-14

源码基线：`integration/remote@9ab6d5f`

用途：区分 Shell 平台、内置清单、源码构建身份、候选包、本地便携产物和真实 Omnia canary。任何一层都不能自动推导下一层。

## 1. 交付层级

```text
v5 产品根
├─ Shell 0.4.18 平台
│  ├─ Electron Renderer / typed preload / Main IPC
│  ├─ Core SQLite / Feature & Documentation Registry
│  ├─ PackageManager / 每 Feature Worker / Store & Artifact ports
│  └─ ConnectorNextTransport（唯一 Connector；无旧 Local/Bridge fallback）
├─ 官方签名 Feature 包（.ofp）
│  ├─ manifest / navigation / declarative Surface
│  ├─ Worker / 可选 Python sidecar / 私有迁移
│  ├─ 随包文档与测试清单
│  └─ 可选的官方签名 Operation 包（.ofop）
└─ Connector Next v3
   ├─ Server：durable jobs/results/logs/update state
   ├─ exact target Agent：Pack Session 与 Operation host
   └─ remote-test 或 company-loopback 部署 profile
```

业务只存在于签名 Feature/Operation 包。Shell 不按 `featureId` 实现业务 UI；Connector Next 不包含 Feature 业务分支，也不接受任意 URL、method、body 或系统命令。

## 2. 三套必须分开的版本事实

### 2.1 标准 Shell baseline

`BUILTIN_FEATURE_RELEASE_INVENTORY` 是普通 Shell 的固定内置基线：

| Feature | 版本 | sequence | 交付状态 |
|---|---:|---:|---|
| `omnia.recording` | `0.3.0` | 4 | standard baseline 内置 |
| `omnia.create-associate` | `0.2.43` | 45 | standard baseline 内置 |
| `omnia.delete-elements` | `0.2.1` | 8 | standard baseline 内置 |
| `omnia.workpaper-preparation` | — | — | standard baseline 明确为 post-install |

这套固定 baseline 不等于最新 Feature 源码。Feature-only 升级应走签名后装通道，不应为了追随每个候选而改写历史 baseline。

### 2.2 Company loopback 当前清单与本地产物

`COMPANY_LOOPBACK_CURRENT_FEATURE_RELEASE_INVENTORY` 当前冻结：

| Feature | 版本 | sequence |
|---|---:|---:|
| `omnia.create-associate` | `0.2.150` | 152 |
| `omnia.recording` | `0.4.21` | 34 |
| `omnia.delete-elements` | `0.3.32` | 1786632995691 |
| `omnia.workpaper-preparation` | `0.1.81` | 82 |

2026-08-14 从 `main@7d3e803` 生成的本地 `0.4.18` company-loopback r2 产物，其 `release-manifest.json` 冻结了上述 0.1.81 集合。历史 `c1b57b3` r1 仍冻结 Workpaper 0.1.71。两者都是本地不可变产物事实；r2 当前没有对应 Git Tag，不能描述为已经公开发布，也不能替代当前精确 digest 的真实 Pack canary。

`company-loopback-current` inventory、便携构建期望、复制列表、manifest 和使用说明已收敛到上述四个精确身份。构建仍会逐项验证官方签名、文件 SHA 和 package digest，任何身份漂移均失败关闭。

### 2.3 当前源码构建身份

| Feature | 构建身份 | 源码/工作树状态 | 当前验证边界 |
|---|---:|---|---|
| Create & Associate | `0.2.150 / 152` | HEAD 支持真实校验进度持久化/流式投影、仅补齐仍缺失 Risk identity，并禁止在 mutation 仍处于 `prepared/submitted/executing/verifying` 时重启 Run | 签名候选已跟踪并进入当前便携包；真实 Pack live acceptance pending。 |
| Delete Elements | `0.3.32 / 1786632995691` | 支持单侧删除、真实目录、冻结删除图、确认、逐步 mutation/readback、uncertain/reconcile | 已进入当前本地便携产物；当前精确 digest 的完整删除 canary pending。 |
| Recording | `0.4.21 / 34` | HEAD 构建入口；真实 start/pause/resume/stop、分块流、Core Artifact 与 24 小时 Feature staging | 已进入本地便携产物；当前精确 digest 的现场录制与导出验收不能从历史版本继承。 |
| Workpaper Preparation | `0.1.81 / 82` | 已包含六类 APP 程序矩阵、富文本占位回传、全正文页签动态 token、OE1–4 精确 procedure ID 和一步选择流程 | 签名候选已通过定向测试与本地安装/启动冒烟；当前精确 digest 的真实 Pack 写回 canary pending。 |

四个冻结候选均已进入干净快照并通过构建期官方签名、文件 SHA 和 package digest 校验。官方包仍具有 `featureId + version + sequence + digest` 不可变性；本地便携构建不等于公开发布，也不替代当前 digest 的真实 Pack canary。

## 3. Shell 平台当前状态

| 能力 | 真实实现 | 边界 |
|---|---|---|
| 启动与 Surface | `src/main/index.ts`、`SurfaceWindowManager`、声明式 Feature Window | Renderer 无 Node；窗口不能打开任意 URL；Surface 状态来自 Core/Worker。 |
| Feature 生命周期 | `FeaturePackageManager`、activation head、每 Feature supervisor、Operation handoff ledger | 安装/候选/active/previous 必须保持签名和版本事实；未重新跑完整矩阵前不宣称独立升级/回滚已验收。 |
| 持久状态 | Core SQLite、Feature 私有 Store、Artifact、Command/Receipt/Evidence | 业务真相不放 Renderer；跨 Store 不假装分布式事务。 |
| Connector | `ConnectorNextTransport` → Server durable job → exact target Agent → Session/Operation host | Connector 不可用时失败关闭；company loopback 只是相同协议的本机部署，不是 Local fallback。 |
| 安全锁 | authority observation + exact Workspace IDs + CAS + session generation | 在线不等于授权有效；恢复必须重新读取真实 authority，Renderer 不能自行解锁。 |
| 聊天 | 用户消息先持久化并立即投影，Provider 回复异步形成第二次真实刷新 | Provider 未配置或失败时不创建假 assistant；系统 persona 明确保密与专业判断边界。 |
| 交互日志 | SQLite start/success/failure、崩溃恢复、trace、严格脱敏；1 天/20,000 行 | 当前主导航隐藏日志菜单；无清空/导出入口；诊断不替代 Run/Event/Evidence。 |

## 4. Feature 四 Plane 与依赖

| Feature | Delivery | Execution | Control/Data | Integration |
|---|---|---|---|---|
| Create & Associate | 三步声明式 Surface、模板下载/上传、实时验证进度 | Worker + Feature-owned Python 解析/确定性规则/DAG | Run、Artifact、计划、确认、命令、读回、Managed projection | 自身签名 Operation；APP/DB/OS/Tool/DCNO 等仅在已有真实合同范围内启用，未知类型 fail-close |
| Delete Elements | 真实目录、多选、状态/动作底栏 | Worker 冻结依赖删除图并调度单步操作 | 计划、确认、Command/Receipt、终态重读 | 自身签名 Operation 执行目录读取、预检、删除和只读 reconcile |
| Recording | recorder Surface 与 Artifact 导出 | Worker + Feature-owned Python staging/rebuild | recording 状态、流、Artifact、24 小时清理 | 页面 observation/managed stream 与签名读取 Operation |
| Workpaper Preparation | 底稿分组下的声明式工作台 | Worker + Feature-owned Python 工作簿/政策处理 | 一步选择、输入 Artifact、写回胶囊和状态 | 自身签名目录/Control/readback Operation；当前精确 digest 尚待安装与 live acceptance |

读取或修改 Omnia 的 Feature 同时需要 `.ofp`、对应 `.ofop`、可用的 Connector Next Session、精确 Pack binding 和真实安全锁。缺任一依赖，入口必须真实禁用或动作明确失败，不能回落到旧 Connector 或 Renderer 本地状态。

## 5. 未交付与发布门禁

- 删除聊天记录仍只有产品设计；真实本地事务、附件引用清理和恢复合同未交付，不能显示可点击入口。
- 新的 company-loopback 产物在 inventory 与便携期望收敛前不得构建或发布。
- Create & Associate HEAD 已是 `0.2.150 / sequence 152`，但不得用未跟踪候选替代确定性核验、安装冒烟或 live canary。
- Workpaper 当前冻结身份为 `0.1.81 / sequence 82`；定向测试与本地安装/启动冒烟已通过，仍需在公司电脑授权 Pack 完成当前精确 digest 的真实写回 canary。
- 四 Feature 的 2026-08-10 独立性审计已是历史快照；下一次发布候选必须刷新行号与结论，执行共存、升级、失败升级、回滚、Worker crash、Connector reconnect 和恶意跨包矩阵。
- 自动化、fixture、候选签名、本地安装或历史 canary 都不能替代当前精确 digest 在授权 Omnia/Pack 的 live acceptance。

## 6. 构建入口

```powershell
npm run build
npm run package:create-associate-feature
npm run package:delete-feature
npm run package:recording-feature
node scripts/package-workpaper-preparation-feature.mjs
```

Workpaper 尚无对应 npm script。开发内环只运行定向测试，不反复签名或生成候选；候选冻结后才执行一次打包。公司便携使用 `npm run package:company-next-loopback-portable`；当前 inventory、构建期望和候选精确身份已收敛到 0.1.81，任何后续漂移仍必须失败关闭。

## 7. 状态词

统一使用以下状态，禁止混称：

```text
设计
→ 源码已实现
→ 定向自动化通过
→ 候选包已生成且源码冻结
→ 已安装/启动冒烟
→ 本地便携产物已生成
→ 真实目标 Pack canary 通过
→ 已发布
```

历史候选和发布记录保留其当时事实。它们不随当前源码更新，也不能被后续文档重新解释为当前版本证据。
