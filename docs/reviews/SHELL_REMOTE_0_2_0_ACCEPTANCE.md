# Omnia Agent v5 Shell / Remote 0.2.0 主验收

日期：2026-07-31  
结论：Accepted with external Omnia/AI canary and organization signing gates  
业务 Feature：0；`feature_registry` 保持真实空状态

## 1. 本轮范围

本轮只扩展 Shell 基础设施，不开发录制、删除元素、删除聊天记录、新建与关联或其他业务
Feature：

- 第三列聊天发送文件/图片、附件暂存/移除/预览与持久化送达状态；
- 对话输入区 72–360 px 上下拖动并持久化；
- 可交互设置页；
- DeepSeek 与 OpenAI-compatible Custom Provider、模型、Base URL、API Key 和真实测试/发送；
- Local/Remote Transport 切换、上次成功模式恢复和禁止静默 fallback；
- 独立 v5 Bridge、角色绑定一次性配对、正式 Remote Connector 便携包和在线升级。

所有按钮均连接 Main/Core/数据库或外部真实状态。未配置 Provider 不生成 assistant 假回复；
未配对 Remote 不允许切换；不支持的附件先真实保存并关联消息，再标记
`model_delivery=blocked`。

## 2. 实现边界

| 能力 | Delivery | Main/Core | 外部边界 |
|---|---|---|---|
| 附件 | `AttachmentCard`、添加/移除/预览 | `AttachmentService`、`chat_attachments`、`data/artifacts` | Provider 能力决定是否实际送入 |
| AI | Settings、连通状态、消息状态 | `ChatService`、加密 `ai_provider_settings` | HTTPS `/models`、`/chat/completions` |
| 输入区/缩放/列宽 | 三类真实拖动/按钮 | SQLite preference/layout CAS | 不适用 |
| Local | 首页连接/刷新、设置模式 | `ConnectorTransportRouter` | 独立 v5 Connector 子进程与 Edge/CDP |
| Remote | 配对/模式切换 | 加密 Shell token、WSS Transport | Bridge → Remote Worker → 同一只读 Connector 合同 |
| 在线升级 | 无假入口 | 独立 Supervisor/managed state | Ed25519、sequence、SHA-256、probation/rollback |

Remote Gate 只接受：

`health | connect | status | refresh | workspace_light_read`

没有 mutation operation、任意 URL/method/body 通道或 Omnia Cookie 转发。

## 3. 数据与 Secret

- 聊天正文、敏感连接快照、附件存储路径、AI Key 和 Shell Bridge token 使用实例
  AES-256-GCM DEK 加密；DEK 由 Electron `safeStorage` 绑定 Windows 用户保护。
- Renderer 只接收 `hasApiKey` / `remotePaired`，不接收 Key/token。
- Remote Connector token 以 Windows DPAPI 密文保存在独立 v5 data root。
- 附件复制到 `data/artifacts/<uuid>/`，记录大小、SHA-256、本地状态和模型送达状态。
- 未知二进制可以保存，但 Main 按 ID 直接调用也不能绕过预览类型白名单。
- 正式 Provider 拒绝 HTTP、URL 凭据/查询/片段、本机、私网和链路本地地址，并在请求前
  再检查 DNS 结果。

## 4. 自动化与成品 UI

主 Agent 在子 Agent 冻结后独立复跑：

- `npm run check`：29/29；lint、typecheck、build、independence 全通过；
- `npm audit --omit=dev`：0 vulnerability；
- `npm audit`：0 vulnerability；
- `npm run package:windows`：Shell 便携目录重新生成；
- `node scripts/ui-acceptance.mjs`：直接启动打包后的 EXE，实际操作设置、Provider 表单、
  输入区拖动、缩放和两条列 Splitter，全部通过。

UI 验收首次发现 `Element.scrollTo()` 在该 Electron 运行时返回 `null`；原简写 effect
错误地把它当 cleanup，下一次快照广播会导致 React 调用 `null` 并清空界面。已改为显式
无返回值 effect，重新构建、打包和全量复验通过。截图：

- `docs/reviews/assets/shell-0.2.0-home.png`
- `docs/reviews/assets/shell-0.2.0-settings.png`

## 5. 生产 Bridge 与 Remote 发布

Bridge：

- 公网 `https://agent.labcaspian.com/v5-bridge/`；
- 容器 `omnia-agent-v5-bridge` 为 healthy；
- 主机只绑定 `127.0.0.1:18785`，Caddy 独立 `/v5-bridge/*` 路由；
- Caddy 补丁保留原 mode/owner，validate/reload 失败自动回滚。

Remote Connector：

- 版本 `0.2.0 / sequence 2`；
- stable：
  `https://download.labcaspian.com/files/v5-remote-connector/stable.json`；
- ZIP：
  `https://download.labcaspian.com/files/v5-remote-connector/releases/0.2.0/Omnia-Agent-v5-Remote-Connector-v0.2.0-Portable.zip`；
- `37,282,502` bytes；
- SHA-256：
  `0738bb27d8368e7267b9348bcb20b06a8d82184f571a453d76c50d0fc370b51f`；
- stable 为 `no-store`，版本包为 immutable，清单由独立 v5 Ed25519 key 签名。

生产 canary 使用正式便携包完成：

1. 管理端生成同 Pair 的 Shell/Connector 角色码；
2. Connector CLI 消费专用码并以 DPAPI 保存 token；
3. 无配对环境变量启动 Supervisor/Worker，经公网 WSS 上线；
4. Shell 消费 Shell 码，通过公网 Bridge 调用真实 Remote Connector `status`；
5. 返回 `remoteAvailable=true`、`connectorVersion=0.2.0`；
6. Connector 干净停止，Bridge 在线数恢复 0，临时目录清除。

canary 没有使用用户 Omnia 登录，因此 `connectedToOmnia=false/status=not_connected` 是真实
外部状态，不是链路失败。

## 6. v4 共存

- source/build independence 测试证明不读取、导入或启动 v4 工作区；
- v5 Bridge/Remote 使用独立产品名、端口、容器、目录、数据根、签名 key 和更新 URL；
- v4 Connector stable 清单部署前、Bridge 部署后、Remote 发布后和 canary 后的 SHA-256
  始终为
  `6e2130c27da3302877500539739ea8606ae514f999ec49da09826e516bfe9786`；
- 没有停止、升级或配对任何 v4 Connector。

## 7. 本地产物摘要

| 产物 | SHA-256 |
|---|---|
| Shell `release-manifest.json` | `e1d085ed7307b5da68c5d591e9265bc7812fa6355383d3be581c81240346fa03` |
| Shell `Omnia Agent v5.exe` | `8593db40c0c6e5e3c4b6b0a225b1dc9a549ecdf10f6cf2010cf5b6ce869ce07f` |
| Bridge `release-manifest.json` | `be7c199846f9f38482d78623e13235f1c365400fe1ebc27e17dc0a16346e9236` |
| Remote Connector ZIP | `0738bb27d8368e7267b9348bcb20b06a8d82184f571a453d76c50d0fc370b51f` |

Shell EXE 是 Electron 运行壳；实际 Renderer 修复摘要登记在 Shell release manifest 内。

## 8. 未关闭的外部门禁

1. 真实 Omnia Pack：需要用户在受控 Edge profile 登录后验证 Local 与 Remote 的
   `connect/refresh/workspace_light_read` 和真实 hierarchy 字段。
2. 真实 AI：需要用户提供自己的 DeepSeek/Custom Key，在其数据处理边界下执行
   `/models` 与一条真实聊天/附件 canary。
3. 组织签名：Remote 更新清单已有独立 Ed25519 签名；Shell/Bridge Windows 分发仍需组织
   代码签名。未签名状态在 release manifest 中明确记录，不冒充生产签名。

以上门禁不影响本轮本地逻辑、生产 WSS Transport 和签名更新闭环的验收，但在关闭前不能
声称已经连接某个真实 Omnia Pack 或验证了某个用户 AI 账户。
