# Omnia Agent v5 Shell 0.1.0 主验收报告

版本：`0.1.0`  
验收日期：`2026-07-30`  
实施：Sol High 子 Agent  
验收：主 Agent  
结论：`Accepted as unsigned local Shell baseline`

## 1. 验收结论

本次交付可以作为 v5 自有、可运行的本地 Shell Baseline。首页只显示并实现：

1. Local Connector 连接；
2. 连接、Pack 和权威 Workspace 轻抓取刷新；
3. 后台持久化保活；
4. 基于权威 Section/Workspace identity 的安全锁；
5. 本地持久化对话；配置真实 HTTPS Provider 后调用真实接口。

首页没有录制、删除元素、删除聊天记录、新建与关联、Phase 1/2、Controls、备份或附加 Feature 入口。内部 Feature Registry 为空，只为后续官方签名包保留基础表。

本结论不等于允许对外生产分发：当前发布物尚未使用组织证书签名，也没有在受控非生产 Pack 上完成真实 Omnia canary。

## 2. v5 独立性

- 源码、脚本、测试、构建产物和 Windows 发布物均位于 `omnia-agent-v5`。
- 运行、构建、测试和发布不读取、导入或启动前代工作区。
- 对前代实现的复用仅为研究后在 v5 中重写、收窄或纠正；映射记录在 `docs/implementation/V4_REUSE_MANIFEST.md`。
- `tests/independence.test.ts` 扫描源码、脚本、测试、`dist` 和 `releases`，拒绝前代仓库名与跨工作区相对引用。
- 发布目录不包含运行时 `data`；可变数据写入 v5 产品根 `data/`。

## 3. 真实链路复核

| 能力 | 验收结果 |
|---|---|
| 连接 | Renderer typed IPC → Main/Core → 独立 Connector 子进程 → 专用 Edge profile/CDP；未做假连接 |
| 刷新 | 调用 Connector 的真实刷新，连接成功后执行权威轻抓取；旧 observation 不冒充本次成功 |
| 保活 | SQLite 保存启停、下次执行、最近成功和错误；到期调用真实只读 refresh |
| 安全锁 | 只接受当前 Pack 权威 observation 中的 Workspace ID；缺少明确父 Section 时失败关闭 |
| 对话 | 消息写入 SQLite；Provider 未配置时标记 `provider_unavailable`，不创建假 assistant 消息 |
| 缩放 | 右上角 `− / 百分比 / +` 连接 Core 偏好状态，使用 `stateVersion` 冲突保护 |
| 分区 | 两条边界支持 pointer 与键盘调整，布局写入 Core 并在重启后恢复 |

Connector 当前只暴露 `health/connect/status/refresh/workspace_light_read`，没有 Omnia mutation Operation。

## 4. 安全与数据保护

- Electron Renderer：`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、`webSecurity=true`。
- CSP 默认拒绝所有外部资源；Renderer 不直接联网。
- 新窗口和非本地文档导航被拒绝。
- Connector 仅允许受信 Deloitte Omnia HTTPS host，并只执行固定 GET 路由。
- CDP 使用动态回环端口，同时校验精确 Edge profile 与端口；多个 Pack 页面时失败关闭。
- Connector 退出不关闭或终止用户的受控 Edge。
- 连接快照、Workspace observation 和聊天正文使用随机 DEK 的 AES-256-GCM；DEK 由 Windows `safeStorage` 包装。Windows 保护不可用时应用停止启动。
- QA 直接读取 SQLite，聊天正文前缀为 `enc:v1:`，未出现验收消息明文。
- API Key 只从 Main 启动环境读取，不进入数据库、Renderer、Connector 或日志。

## 5. 自动化与成品验收证据

独立执行：

```text
npm run check
16 tests / 16 passed
npm audit --omit=dev
0 vulnerabilities
npm audit
0 vulnerabilities
npm run package:windows
passed
```

发布清单列出的七个关键文件均重新计算 SHA-256 并与 manifest 一致。

Windows 成品界面验收：

- 标题为 `Omnia Agent v5`；
- 默认三列布局；
- 默认 UI 字体 `13px`；
- 首页存在两条 separator；
- 右上角存在 `− / 100% / +`；
- 首页没有任何业务 Feature 文案；
- 单次缩放和键盘分区操作各只增加一个 `stateVersion`；
- pointer 拖动分区后 `middleBasisPoints` 从 `2850` 变为 `3245`，重启仍恢复为 `3245`；
- 对话消息跨重启恢复，Provider 未配置时 assistant 数量为零。

真实 Omnia 未在本次验收中访问。

## 6. 发布物

本地 Windows 发布目录：

```text
releases/0.1.0/
```

入口：

```text
releases/0.1.0/Omnia Agent v5.exe
```

随包提供：

- `release-manifest.json`：版本、平台、签名状态和关键文件 SHA-256；
- `sbom.json`：CycloneDX 组件清单。

## 7. 尚未关闭的正式发布门禁

1. 使用组织代码签名证书签署发布物；
2. 在受控非生产 Pack 完成只读 canary，确认 hierarchy、授权捕获和权威 `parentSectionId`；
3. 在代表性 Windows 10/11 ThinkPad 上完成 Edge、杀软、系统缩放与资源测试；
4. 使用真实 Provider 做超时、错误分类和数据边界测试；
5. v5 Remote Connector 独立便携包和签名自动更新通道已发布；Remote Bridge 配对与命令传输仍未部署，当前在首页真实显示为不可用。发布证据见 `docs/implementation/REMOTE_CONNECTOR_0_1_0_RELEASE.md`。

以上门禁不影响本地 Shell 代码基线验收，但未关闭前不得把当前 unsigned 包描述为已批准的生产分发版。
