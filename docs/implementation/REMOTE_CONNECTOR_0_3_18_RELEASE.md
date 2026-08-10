# Remote Connector 0.3.18 发布记录

日期：2026-08-06

版本 / sequence：`0.3.18 / 21`
状态：本地签名自动升级候选；未部署线上，未操作当前运行中的 App，真实 Omnia Pack 仍待现场 canary

## 修复范围

0.3.18 修复全类型真实回传过程中 Remote Connector 丢失 Omnia API Authorization 的稳定性问题：

- Authorization 继续按同一 Playwright Page（同一 CDP target）保存；main-frame navigation 只重置页面级 GRA 观察，不再删除已经捕获的 Authorization。
- Session 使用 Authorization 前仍要求其 engagement identity 与当前 target URL 完全一致。跨 Pack 导航会因 identity mismatch 失败关闭；没有伪造、降级或跨 target 复用授权。
- 普通 `workspace_authority_read`、`recording_command` 和 `operation_invoke` 在缺少 Authorization 时只共享一次 1.5 秒有界等待，不再自动 reload 页面。等待后仍无真实请求头则返回 `CONNECTOR.AUTH_REQUIRED`。
- `status` 在目标 Pack 已打开但尚无真实 Authorization 时继续返回 `waiting_authorization`，不会把 Bridge/Connector 在线冒充为 Pack 已连接。
- `refresh` 保留为显式页面恢复动作；当 business command 正在运行或排队时，Remote Command Gate 立即以可重试 `CONNECTOR.BUSY` 跳过 refresh，使 maintenance refresh 不能插入 `operation_invoke` FIFO 中间。
- `operation_invoke`、录制命令、Workspace authority 读取等独占语义不变，mutation 仍严格单飞。

## 自动升级候选

- ZIP：`remote-connector/releases/0.3.18/Omnia-Agent-v5-Remote-Connector-v0.3.18-Portable.zip`
- public ZIP：`remote-connector/public/releases/0.3.18/Omnia-Agent-v5-Remote-Connector-v0.3.18-Portable.zip`
- SHA-256：`b3893c542ee85659007d01a29d1683f949200dad7e90cb50c0dd46fc3d042478`
- size：`37310003`
- stable manifest：`remote-connector/public/stable.json`
- manifest policy：`automatic_safe_window`
- signing key：`v5-remote-connector-release-2026-01` / Ed25519

## 本地验证

按本次变更约束只执行以下检查，没有运行单元测试：

| 检查 | 结果 | 边界 |
|---|---|---|
| `node --check scripts/package-remote-connector.mjs` | exit `0` | 打包脚本语法 |
| `npm run build` | exit `0` | TypeScript / esbuild 构建 |
| `npm run package:remote-connector` | exit `0` | 再次构建、portable health probe、隔离 install smoke、签名 manifest 与 ZIP 生成 |

这些结果证明本地构建、候选包身份和既有打包 smoke 通过，不替代真实公司电脑上的长时间全类型回传 canary。发布脚本仅更新仓库内候选 release 与 `public/stable.json`；本次未运行 `deploy:remote-connector`，因此线上 stable 和当前运行实例均未改变。
