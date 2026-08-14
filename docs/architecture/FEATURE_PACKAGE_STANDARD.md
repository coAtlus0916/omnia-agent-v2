# Feature Package 标准

状态：实现约束与发布门禁（2026-08-14）
合同：`omnia.feature-manifest/v1`、`omnia.feature-runtime-contract/v1`、`omnia.operation-manifest/v1`

本标准定义“独立 Feature”的可验证含义。当前实现尚未通过全部门禁，缺口与证据集中在 [Feature 独立性审计](FEATURE_INDEPENDENCE.md)。候选包、自动化测试或旧版本验收都不等于当前版本已在真实 Omnia 环境通过。

## 1. 独立部署单元

一个 Feature 包必须同时拥有并签名以下内容：

- 稳定 `featureId`、SemVer `version`、单调发布 `sequence` 与成员 digest；同一 `featureId + version` 不得对应两个 digest。
- Worker 入口、Runtime Contract、输入/输出/事件/错误 Schema，以及最小 Store/Connector/AI 端口声明。
- Feature 私有迁移、声明式导航与 Surface、可选 Operation 包、随包文档和测试清单。
- Operation 的稳定 `packageId`、独立 sequence、精确 handler/policy digest、effect、route allowlist 与需要时的 resource-owner 交接声明。

Feature 包不得包含另一个 Feature 的源码、数据库路径、Feature ID 协调逻辑或运行时依赖。Feature 可以依赖公共合同版本和通用平台端口，不能依赖另一个 Feature 已安装、已运行或处于某个版本。

## 2. 强制边界

| 边界 | Feature 可以做 | Feature 不可以做 |
|---|---|---|
| Shell | 声明导航、Surface、action 与状态投影 | 要求 Shell 按 Feature ID 渲染业务 UI |
| Core | 通过签名且授权的通用端口创建 Run、Artifact、Command、Receipt | 绕过端口访问 Core DB，或读写另一 Feature 的记录 |
| 私有 Store | 只迁移和访问 `data/features/<featureId>/store.sqlite` | `ATTACH`、打开另一 Feature Store、共享业务表 |
| Connector | 调用自身签名 Operation 的声明式 route/effect | 要求 Connector/Bridge 识别 Feature ID 或承载业务算法 |
| 文档 | 文档与包同版本、同 digest、同激活头 | 用源码文档替代安装包中的签名文档 |

公共平台新增能力必须由版本化、通用、声明式合同表达。若只有一个 Feature 使用，也不能把该 Feature ID、能力 ID、业务 Schema 或精确业务版本写入 Core/Connector 分支。

## 3. 安装、激活与回滚

安装事务必须按以下语义完成：

1. 验签、重算成员 digest，检查 Shell/合同兼容范围、`featureId + version` 不可变性和 feature-scoped sequence high-water。
2. 将候选解包到不可变内容寻址目录；任何迁移和候选状态不得提前污染当前激活版本。
3. 校验导航全局无歧义、Runtime 端口授权、私有迁移链和 Operation 交接兼容性。
4. 启动候选 Worker 并完成健康检查；有远端 Operation 时，在切换激活头前完成可回滚的 prepare/commit。
5. 用单一 CAS 事务切换 Feature activation head、文档投影和 Worker 所有权；随后停止旧 Worker并完成远端 finalize。
6. 任一步骤失败都保持旧 head/Worker/Operation 可用，并留下可恢复的 durable journal。

回滚是一次明确、可审计的反向激活，不得被“sequence 必须增加”的升级规则永久禁止。若 Operation Connector 维护高水位，回滚必须使用单独的、带目标 digest 和激活 generation 的授权协议，而不是伪造更高版本。

对于任意目标 Feature `F`，安装、升级、回滚或 Worker 崩溃后都必须证明另外三个 Feature 的以下值未变化：activation head、package digest、Worker PID/健康、私有 Store digest、Run/Artifact/Receipt 集合、导航语义和 Operation 注册。

## 4. 运行与持久化

- 每次 Worker port call 都必须携带激活的 `featureId + featureVersion`，Core 在每个读写入口校验资源 owner；只校验 `runId` 或 `commandId` 不够。
- Runtime Contract 的 `storePorts` 是授权 allowlist，不是说明文字。Worker 调用未声明的方法必须失败关闭。
- Run 状态变化使用 revision/CAS；mutation 超时、断连或 Worker 退出后禁止自动重放，只能按 receipt/read-back 证据判为 completed、not-started 或 uncertain/reconcile。
- Artifact 路径、DB 行和 Receipt 同时绑定 Feature、版本、Run、Operation digest 与 authority。文件 digest 不匹配时不得投影为成功。
- 私有迁移必须是有序、幂等、可恢复的链，声明前向/回滚兼容范围；先改共享 live Store、后切换候选 head 的流程不合格。

## 5. 开发与测试工作流

当前构建入口：

```powershell
npm run build
npm run package:create-associate-feature
npm run package:delete-feature
npm run package:recording-feature
node scripts/package-workpaper-preparation-feature.mjs
```

`workpaper-preparation` 目前没有对应 npm script，这是发布流程缺口，不能据此宣称四包工作流一致。2026-08-14 的当前冻结身份为 `0.1.83 / sequence 84`；签名候选已通过定向测试并进入 company-loopback 构建清单，但新 digest 的真实 Pack live canary 仍 pending，不能仅凭文件存在描述为已公开发布或已验收。

每次 Feature 变更至少需要：

1. 包内合同、单元测试与确定性打包测试。
2. 安装器在隔离候选 runtime 中执行签名 self-test；随后完成单 Feature 安装/启动/Run/Artifact/Receipt/重启恢复测试。
3. 四 Feature 共存矩阵：对目标包执行安装、升级、失败升级、回滚、Worker crash 和 Connector reconnect，并对另三包做前后快照断言。
4. 恶意隔离测试：调用未声明 Store port、伪造另一 Feature 的 run/command、声明冲突导航、跨包 Operation digest。
5. 当前版本 Windows 便携包 smoke；Builtin catalog、复制清单和 release manifest 必须由同一生成源产生。
6. 授权公司电脑的真实 Pack canary。只读 probe、fixture、mock Connector、离线候选测试不能替代该步骤。

只有 1–5 通过才能称为可发布候选；需要真实 Omnia mutation/read-back 的能力还必须通过 6 才能称为 live accepted。

## 6. 发布记录

每个发布记录必须写明：Feature/Operation 版本与 sequence、包 digest、成员/文档 digest、兼容合同、安装与回滚证据、四包独立性快照、真实 canary 范围、未完成项。历史 hash 是不可变证据；新版不得覆盖、继承或重新解释旧版 hash。

Remote Connector `0.3.36` 发布记录仍是 pending baseline，不作为本标准或当前四 Feature live 验收的通过证据。
