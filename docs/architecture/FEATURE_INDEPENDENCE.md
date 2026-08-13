# 四 Feature 独立性合同与架构审计

审计时间：2026-08-10

> 2026-08-13 状态说明：本页保留为 2026-08-10 的完整审计快照。其后 `integration/remote` 已修改 Package Manager、Runtime Store、builtin release inventory 和四个 Feature，原行号及部分 P0/P1 结论已漂移；当前源码版本和发行阻断见 [系统架构](SYSTEM_ARCHITECTURE.md)、[Feature 包总览](../implementation/FEATURE_PACKAGE_CATALOG.md)与[文档中心](../README.md)。下一次候选冻结前必须重新执行完整审计，不能把本页旧行号或曾经关闭的测试直接当作 2026-08-13 精确工作树的通过证据。

范围：`omnia.create-associate`、`omnia.delete-elements`、`omnia.recording`、`omnia.workpaper-preparation`
结论：**未满足独立开发、打包、安装、激活、回滚、运行和持久化的发布门禁。** Connector/Bridge 的通用边界基本成立，但 Core Store、Operation 交接、发布清单和测试矩阵仍有阻断项。

本页是当前独立性状态的单一事实源。P0 表示发布阻断或可能跨 Feature 破坏；P1 表示在独立升级/恢复前必须修复；P2 表示证据、命名或文档债务。行号对应本次审计工作树，后续代码移动时应同时刷新。

## 1. 不变量

对任意 Feature `F` 的开发、安装、升级、回滚、启动、崩溃或重连：

1. 另外三个 Feature 的 activation head、digest、Worker、Store、Run/Artifact/Receipt 和导航语义不得变化。
2. 四包之间不得 import、打开或写入对方 Store，不得靠 Feature ID/版本硬编码协作。
3. Core/Shell/Connector 只能提供通用、声明式、版本化合同；Feature 业务和版本恢复策略属于签名包。
4. Worker 只能调用 Runtime Contract 明确授权的端口；Core 每次读写都验证 Feature、版本和资源 owner。
5. Operation 升级与回滚必须先证明远端交接可完成，再用 CAS 切换 activation head；失败保持旧版本可运行。
6. 同一 Feature 版本/digest 不可变，发布 sequence 单调；回滚通过显式 generation/digest 授权完成，不能污染 publisher high-water。
7. 自动化候选、mock 和历史 canary 不得冒充当前版本 live acceptance。

## 2. P0 — 发布阻断

### P0-1 Core 含 Feature 业务与版本特判，Store 授权可被绕过

- `src/main/features/package-manager.ts:1189-1192` 把 `omnia.create-associate` 的恢复源版本固定为 `0.2.60`；`src/main/features/package-manager.ts:4134-4137` 按 Feature ID 和业务 capability 特判 AI review。
- `src/main/features/feature-runtime-store.ts:830` 固定 Create & Associate GRA operation；`:945-978`、`:1224-1236`、`:1292-1338`、`:1612-1645` 固定 Recording ID/版本/业务 Schema；`:2807`、`:2816-2819`、`:2981-2998`、`:3445-3454` 是 Create & Associate 专属确认和业务投影。
- 签名 Runtime Contract 的 `storePorts` 只在 `src/main/features/package-manager.ts:1906-1922` 检查为数组；实际 `storeCall` 在 `:4113-4124` 直接转发任意 method。`src/main/features/feature-runtime-store.ts:438-490` 向所有 Worker 暴露整套 method dispatch。
- `saveReturnReconcileSpec` 在 `src/main/features/feature-runtime-store.ts:514-523` 只按 `commandId + runId` 查写，没有验证该 Run 属于当前 `context.featureId + featureVersion`。共享表 `feature_commands`/`feature_command_specs` 也没有数据库外键或 Feature owner 字段（`src/main/database.ts:526-552`）。知道身份的另一官方 Worker 可覆盖该命令的 reconcile spec。

影响：Create/Recording 业务升级需要同步改 Core，且一个 Feature Worker 可以调用未声明 Store 方法或触及另一 Feature 的共享命令数据。四包不能视为独立。

修复门禁：把 Feature 专属逻辑移回签名包；Runtime 建立 method→permission→owner 校验表并执行 `storePorts` allowlist；所有共享资源入口用 `featureId + featureVersion + run/command` 联合校验，数据库补充可行的 FK/owner 约束和恶意跨 Feature 测试。

### P0-2 Operation 升级与回滚协议不可达

- 交接兼容要求目标 sequence 严格增加且 `capabilityFingerprint` 完全相同（`src/main/features/package-manager.ts:144-180`）；fingerprint 又包含 operations、handler SHA 和 policy SHA（`:2135-2144`）。正常 handler/policy 演进会失败，回滚到旧 sequence 必然失败。
- `rollback()` 对 resource-owner 包复用同一个“目标 sequence 必须增加”断言（`src/main/features/package-manager.ts:3039-3079`）；Connector 还拒绝不高于 durable high-water 的注册（`src/connector/operation-host.ts:906-918`）。
- 对没有 resource owner 的包，安装不会创建交接候选（`src/main/features/package-manager.ts:2826-2839`），而是先更新 Core activation head（`:2948-2987`）。Operation 只在首次 invocation 时注册（`:3444-3484`）；Connector 在已有旧注册时要求显式 resource-owner handoff（`src/connector/operation-host.ts:422-431`）。

影响：Recording 的版本演进/回滚受 fingerprint 和 high-water 阻断；Create/Delete/Workpaper 在长寿命 Connector 已注册旧 Operation 后，升级可先替换 Core head，首次动作再被拒绝，且没有自动恢复旧 head。

修复门禁：所有 Operation replacement 都使用统一 durable prepare/commit/CAS/finalize；兼容声明应描述稳定 owner、合同范围和迁移能力，不能要求 handler digest 相同；为显式 rollback 定义独立的 signed target digest + activation generation 协议，并保留旧注册直到新 head 已证实可调用。

### P0-3 Windows Builtin 清单无法构成一致发行物

- 运行时 Builtin catalog 要求 Recording `0.3.0`、Create `0.2.48`、Delete `0.2.1`（`src/main/features/builtin-features.ts:6-9`）。
- Windows 打包脚本复制 Create `0.2.43`，release manifest 也登记 `0.2.43`（`scripts/package-windows.mjs:94-103`、`:112-121`）。启动按 catalog 的精确文件名查找，缺失即失败（`src/main/features/builtin-features.ts:27-30`）。Workpaper 未列入两者。

影响：当前 Windows 产物的 Builtin catalog 与实际复制文件不一致，可在启动时失败；Feature 版本升级还需要手改 Shell 发布清单，不能独立交付。

修复门禁：从单一、可验证的 release inventory 生成 Builtin catalog、复制列表和 manifest；构建时校验每个 filename/version/digest 存在且一致；Builtin 固定基线与后装 Feature 更新通道分离。

### P0-4 生产逐字复制与共享 engine/bridge 入口已清零

`tests/feature-business-isolation.test.ts` 已成为独立静态发布门禁，并由 `scripts/lint.mjs` 直接执行。它不只搜索
Feature ID，而是同时解析/核验：

- JS/TS 的静态 `import`、`require`、动态 `import()`，Python/JSON/JS 中的跨包路径、精确 Feature ID 和跨包 semver 依赖；
- 生产 JS/TS AST 函数与 Python `def` 的规范化实现指纹、四个 Python engine 的完整内容指纹；
- `STATE/STORE/DB/DATABASE` 路径和 namespace 静态绑定；
- 四个 packager 的 `entryPath`、`bridgePath`、入口存在性、入口 basename 唯一性和跨 Feature 发布路径/版本引用。

`source/docs`、`source/tests`、`__pycache__` 和工具性的 `node_modules` 不参与生产实现指纹。只有双方都位于独立
`protocol/canonical/codec/contracts/serialization/serializer/wire` 模块的协议/序列化函数可豁免；位于
`<feature-slug>-engine.py`、Worker、Operation handler、Store/security 或 Feature-owned bridge 内的同样函数不豁免。

截至本页更新时，负例 fixture 的跨包 import、复制 JS/Python 业务函数、复制 engine、共享状态路径/namespace、
跨包版本依赖以及同名 engine/bridge 入口全部被拒绝。最新真实 source 扫描中，生产 JS/Python exact-copy 已为零；
入口身份冲突已按签名 Feature slug 收口。

四包 packager 现在分别声明 `python/<feature-slug>-engine.py` 与
`middle/<feature-slug>-python-bridge.cjs`。Core 从已签名 `featureId` 的最后一段派生严格 lowercase slug，
对两条路径做 exact 校验且不保留共享旧名 fallback。

本轮早期只读审计发现过 5 组 Python exact-copy：Create `security.py` 与 Recording `recording_store.py` 的
`_public_path`、`_within`、`install`，以及 Delete/Workpaper Feature-specific engine 的 `canonical` 和错误类 `__init__`。
同一轮还发现过 Create/Delete Operation handler 的 `catalogRows`，以及 Delete/Workpaper Python bridge 的
`startHeartbeat`、`fail`、`close`、`terminate`，以及 Create/Recording Python bridge 的 `terminateTree` 和匿名 kill
callback。这些已由并行 Feature owner 在当前 source 中改写，最新门禁不再报告；对应既有候选字节已陈旧，不能沿用旧版本或旧签名宣称关闭。

逐文件关闭建议（由各 Feature owner 执行，本审计任务不修改 Feature 源码）：

1. 四个 packager/runtime contract/随包自检已同步为唯一 slug 入口。
   源码门禁全绿后，各包仍须分别升版、重签、安装/升级/回滚验证；旧 candidate 不得原地覆盖。

因此 P0-4 的 source 隔离门禁已关闭；当前 release 仍因旧 candidate 字节陈旧且尚未完成升版、重签、安装/升级/回滚验证而
blocked。不得通过原地覆盖旧 candidate、沿用旧签名或把生产文件移入 `tests`/`docs` 来伪造关闭。

## 3. P1 — 独立升级与恢复缺口

### P1-1 私有 Store 有隔离路径，但没有可演进迁移链

正向事实：安装和运行均使用 `data/features/<featureId>/store.sqlite`（`src/main/features/package-manager.ts:2851-2858`），Artifact 也落在 Feature-scoped 路径并做路径逃逸/digest 检查（`src/main/features/feature-runtime-store.ts:1983-2050`、`:2086-2120`）。

缺口：PrivateMigration 类型和解析器只接受 `version: 1`（`src/main/features/package-manager.ts:2148-2175`），执行器只做 `CREATE TABLE IF NOT EXISTS` 与 `INSERT OR IGNORE`（`:2210-2227`）。更重要的是，迁移在不可变目录/activation 事务完成前直接修改 live Store（`:2851-2858`）；未来真实 schema migration 失败时可能污染仍在运行的旧版本。

### P1-2 导航 group 冲突会静默改变另一 Feature 的 UI

包内只校验自身导航；合并时相同 group ID 由先出现者静默获胜（`src/main/features/package-manager.ts:4582-4595`）。当前四包没有已知冲突，但合同允许某 Feature 安装后改变另一包叶子的 group label/order/parent。

门禁：安装时做全局 group/leaf/route 身份校验；相同 group 必须逐字段完全一致或由独立、版本化 Shell taxonomy 声明，否则拒绝安装。

### P1-3 Worker 是进程隔离，不是权限隔离

每个 Feature 有独立子进程和 supervisor（`src/main/features/worker-supervisor.ts:81-132`），mutation timeout/exit 会关闭进程并进入 fail-closed recovery（`:134-175`、`:237-310`）。但 Worker 继承完整 `process.env`，并得到包、临时目录和 Store 路径（`:83-95`）；没有 OS 文件/网络 sandbox 或资源配额。

门禁：最小环境 allowlist、文件系统/网络 broker、CPU/内存/时间配额和逃逸测试；在此之前只能称“进程故障隔离”，不能称安全沙箱。

### P1-4 静态源码门禁已接线，但四 Feature 动态发布矩阵仍缺失

- `tests/independence.test.ts:21-37` 只检查不依赖前代 v4 workspace。
- `tests/feature-business-isolation.test.ts` 已覆盖生产 source 静态边界和独立负例，并由 lint 执行；当前 source 门禁通过。
- `tests/feature-package.test.ts:174-214` 只覆盖单包 install/upgrade/rollback activation head。
- `tests/feature-surface-workflow.test.ts:15-31` 检查通用 renderer 和部分 Feature-ID 分支，没有扫描 Core 的 Create/Recording 特判。
- `tests/workpaper-preparation-feature.test.ts:31-64` 是候选包隔离安装；`:98` 起使用测试 harness 验证 action chain，不是四包共存或真实现场。
- `package.json:17-19` 有 Create/Delete/Recording 打包脚本，Workpaper 只能直接运行 `scripts/package-workpaper-preparation-feature.mjs`。

剩余门禁：增加四包共存快照测试、跨 Store/Run 攻击测试、Operation 升级/回滚/崩溃矩阵和同一 Windows inventory smoke，并将其设为发布必过任务。静态 source 门禁不能替代这些动态行为证据。

### P1-5 安装器不执行签名 self-test

`validateFeatureBundleContracts` 只校验 tests manifest、vector inventory 和 `selfTestPath`，并要求状态字面量仍是 `declared`（`src/main/features/package-manager.ts:1906-1922`）；安装流程没有执行包内 `tests/self-test.cjs`。候选测试可以在仓库外层主动运行 self-test，但安装器无法据此拒绝一个“签名完整、运行自检失败”的包。

门禁：在 activation head 切换前，以候选包的隔离 Worker/runtime 执行签名 self-test，记录精确包 digest、退出码和有界日志；失败保持旧 head/Store/Operation 不变。发布测试还应证明安装器确实执行而不是只读取路径。

## 4. P2 — 证据与文档债务

- `tests/independence.test.ts` 名称容易被误读为四包独立性证明，应改成 predecessor-workspace independence，并新增真正的 feature-isolation suite。
- Delete Operation 源码/文档仍用“recorded create-associate catalog shapes / create-associate verified risk catalog”描述风险目录来源（`feature-packages/delete-elements/source/connector-capability/operation/handler.cjs:421`、`feature-packages/delete-elements/source/docs/OPERATION.md:16`）。当前没有跨包 import，但应改为稳定的通用 catalog contract，避免语义依赖继续扩散。
- Create 与 Recording 将较完整的 CONTRACT/TESTING/VERSION 文档签入包；Delete/Workpaper 的打包脚本只签 `FEATURE.md` 与 `IMPLEMENTATION_MAP.md`（`scripts/package-delete-feature.mjs:478-486`、`scripts/package-workpaper-preparation-feature.mjs:103-105`）。四包发布证据格式不一致。

## 5. 已验证的正向边界

- 对 `src/connector`、`src/bridge`、`src/remote-connector` 的源码扫描未发现四个 Feature ID；当前 Connector 的注册、digest、effect、route 和 binding 校验是通用机制。
- 四个 Feature 源码目录未发现对另外三个 Feature ID 的 import、另一 Feature `store.sqlite` 路径或 `ATTACH DATABASE`。
- 新静态门禁的负例已证明跨包 import/路径/版本、复制函数/engine 和共享 state path/namespace 会失败；真实 source 门禁已通过，但这不能替代候选升版、重签与安装/回滚发布证据。
- Feature package install 已验证官方签名、内容 digest、`featureId + version` 不可变性与 feature-scoped publisher sequence（`src/main/features/package-manager.ts:2767-2825`）。
- Operation handoff 已有 durable ledger 和阶段 CAS（`src/main/features/package-manager.ts:209-233`、`:571-877`）；启动恢复会在候选交接失败时保留旧 head/Worker（`:3306-3377`），成功时先替换 supervisor 再停止旧进程（`:4328-4366`）。
- 多数 Run/Artifact 路径已有 Feature owner 与 CAS 校验；这些正向事实不能抵消 P0-1 的未授权入口。

## 6. 当前候选与验收状态

| Feature | 源码候选 | sequence | 离线/候选证据 | 当前版本 live acceptance |
|---|---:|---:|---|---|
| Create & Associate | `0.2.103` | 105 | 包脚本、候选包与 targeted tests 存在 | pending |
| Delete Elements | `0.3.20` | 29 | 包脚本、候选包与 targeted tests 存在 | pending |
| Recording | `0.4.19` | 32 | 包脚本、候选包与 targeted tests 存在 | pending |
| Workpaper Preparation | `0.1.3` | 4 | 直接包脚本与候选 test 存在 | pending |

版本来自 `scripts/package-create-associate-feature.mjs:333`、`scripts/package-delete-feature.mjs:786`、`scripts/package-recording-feature.mjs:8-9`、`scripts/package-workpaper-preparation-feature.mjs:8-9`。这里不继承旧版 live evidence，也不把 fixture/mock/离线测试改写为现场通过。

## 7. 关闭条件

只有以下条件全部满足，才能把总体结论改为“独立”：

- P0 全部修复并有回归测试；Core/Connector 全目录 Feature-ID/business-branch scanner 为零。
- `tests/feature-business-isolation.test.ts` 的真实四包 source gate 为绿；所有 engine/bridge 入口 basename 唯一，生产函数指纹无跨 Feature 重复。
- 四包同时安装，对每包完成 upgrade、failed upgrade、rollback、restart、Worker crash、Connector reconnect；其余三包快照逐项不变。
- Runtime Store allowlist 与每个共享资源 owner 校验有正反测试；跨 Feature 伪造身份失败关闭。
- 私有迁移链、导航冲突和 Windows inventory 有构建期验证。
- 每个当前 digest 的签名文档、自动化结果、安装/回滚 receipt 和授权环境 canary 独立归档。

Remote Connector `0.3.36` release 文档/实现是 pending baseline，未纳入本次通过证据，也未由本次审计修改。
