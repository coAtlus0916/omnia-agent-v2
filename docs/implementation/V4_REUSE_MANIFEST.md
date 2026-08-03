# 前代实现复用与退役清单

目的：记录开发研究中参考的前代资产，以及它们如何转换为 v5 自有实现。运行、构建、测试和发布产物不依赖前代工作区。

| 前代来源 | v5 目标 | 处理 | 关键变化 |
|---|---|---|---|
| `public/modules/omnia-connection.js` | `src/shared/contracts.ts`、`src/main/services/shell-service.ts` | Refactor | 从 room HTTP API 改为 v5 typed IPC；连接状态落入 v5 Core |
| `web/app-shell/shell.tsx` | `src/renderer/index.tsx`、`styles.css` | Refactor | 删除 Agent/Room、附加 Feature 与重复工作台；保留紧凑三列与真实状态 |
| `src/db.js` 的 SQLite 模式 | `src/main/database.ts` | Refactor | 新建 v5 最小 schema/migration/CAS；不复制旧表、旧数据或设置 JSON |
| `src/omnia-workspace-safety.js` | `ShellService.saveSafety/assertWorkspaceTargetsAllowed` | Refactor | 移除 category/name 推断；锁只绑定 Pack、权威 Workspace ID 和 observation |
| `connector/src/omnia-origin-policy.js` | `src/connector/omnia-origin.ts` | Retain + namespace rewrite | 保留 HTTPS host allowlist；v5 使用独立合同和错误 |
| `connector/src/omnia-id.js` | `src/connector/omnia-origin.ts` | Retain + correction | 接受精确、非零的 .NET GUID；不强制 RFC version/variant |
| `connector/src/omnia-session-host.js` 的 Edge/CDP 经验 | `src/connector/local-connector.ts` | Narrow rewrite | 不带录制；动态空闲端口、profile/port identity、instance lock、多 Pack 失败关闭、退出不关闭 Edge |
| `connector/src/omnia-gateway.js` 的 pack hierarchy/Workspace facet 只读路由 | `LocalConnector.identify/workspaceLightRead` | Narrow rewrite | 只保留三个 allowlisted GET；增加权威 `parentSectionId` 必填与错误分类 |
| v4 keepalive timer | `ShellService.backgroundTick/runKeepalive` | Refactor | v5 Core 持久化调度事实；失败原因可观测；只调用只读 refresh |
| v4 Provider/Agent runtime | `ChatService` | Retire / minimal replacement | 不复制 Agent 路由或提示；只做持久消息与可选 HTTPS Provider，无假回复 |
| v4 Remote Connector 在线更新经验 | `src/remote-connector/*`、`scripts/package-remote-connector.mjs` | Independent rewrite | 新建 v5 产品身份、信任根、安装/数据根、发布清单与服务器路径；不复制或修改 v4 runtime/state/channel |

明确未复制：

- Phase 1/2、Controls、删除、录制、备份、EMS、Galaxy、工具包、Feature 数据；
- data、storage、`.env`、Secret、录制文件、日志、构建产物、依赖目录、Git 历史；
- Connector 更新私有发布信息、信任根或服务器配置；
- 旧 Room/Employee/Agent profile 和“+ Agent”信息架构。

## 独立性验证

`tests/independence.test.ts` 扫描 `src/`、`scripts/`、`tests/` 和存在时的 `dist/`：

- 禁止前代仓库名称；
- 解析相对 import/require，拒绝解析到本工作区之外；
- 构建和测试只使用当前 `package.json/package-lock.json`。

文档中的历史名称仅用于审计说明，不是运行依赖。
