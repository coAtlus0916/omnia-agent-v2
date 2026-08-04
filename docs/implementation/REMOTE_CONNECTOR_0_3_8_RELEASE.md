# Omnia Agent v5 Remote Connector 0.3.8 发布记录

日期：2026-08-04
版本 / sequence：`0.3.8 / 11`
配套 Bridge：`0.4.4`
状态：官方签名包已发布到 v5 stable 在线更新通道；公司电脑上的 0.3.7 是否已在安全窗口自动激活 0.3.8，仍需从 Shell/Connector 现场状态读回确认。

## 变更范围

- Connector 首次/修复配对输入严格采用四位数字链接码，与 Bridge 0.4.4 的两分钟、一次消费合同一致。
- 版本与在线更新序号从 `0.3.7 / 10` 推进到 `0.3.8 / 11`；已有 DPAPI credential、binding、managed `current/previous` 与数据目录保持不变。
- Workstation Session 对外健康身份同步为 0.3.8。不存在 Local fallback，也不触碰 v4 Connector、v4 stable 清单或 v4 数据。

## 发布产物

- ZIP：`remote-connector/releases/0.3.8/Omnia-Agent-v5-Remote-Connector-v0.3.8-Portable.zip`
- size：`37302279`
- SHA-256：`20ee74a5a8ffbda8828bb85466654fb570a3f557fe1ea5b1fe803e65ca3d9e30`
- stable：`https://download.labcaspian.com/files/v5-remote-connector/stable.json`
- sequence：`11`

发布脚本已验证公开 ZIP 的目标字节、size/digest、stable 原子切换和 v4 stable 摘要未变化。该发布门禁不等于公司电脑已完成自动激活，也不等于真实 Omnia Pack canary。

## 验证

- `npx tsx --test tests/remote-only-transport.test.ts tests/workstation-omnia-session.test.ts`：19/19 通过。
- 与 Shell/Feature/AI/日志合并后的 59 个定向测试通过，`npm run typecheck` 与唯一一次最终 `npm run build` 通过。
- Bridge 0.4.4 公开 health 正常，原有 0.3.7 Connector 在 Bridge 部署后自动恢复在线。
