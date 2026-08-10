# Remote Connector 0.3.19

发布日期：2026-08-06

产品：`omnia-agent-v5-remote-connector`
版本 / sequence：`0.3.19 / 22`

## 修复范围

- Omnia Authorization 以受控页面和 Engagement 为边界保留；同一页面导航不再立即丢弃已捕获授权。
- 普通业务 Operation 缺少授权时只等待同一个有界授权观察，不再自行 reload，避免连续刷新风暴。
- Connector maintenance refresh 在业务命令运行或排队时失败关闭，由后续保活周期重试，不插入回传队列。
- 显式 refresh 单飞；reload 后必须观察到刷新开始之后、同一 Engagement 的新 Authorization 才能恢复连接。
- Omnia API 返回 401/403 时撤销对应授权，禁止继续复用已被服务端拒绝的凭据。
- Shell 把 `waiting_authorization` 记录为保活失败，不再误记成 `keepalive-refresh success`。

## 发布结果

- Stable：`https://download.example.invalid/files/v5-remote-connector/stable.json`
- ZIP：`https://download.example.invalid/files/v5-remote-connector/releases/0.3.19/Omnia-Agent-v5-Remote-Connector-v0.3.19-Portable.zip`
- SHA-256：`414de8474a23e1035b4003a7a07ae56f64f154ce9cbf5306cb37086d1a3a043b`
- Size：`37310487`
- 发布脚本确认 v4 stable manifest 摘要未变化。

`0.3.18 / sequence 21` 只完成远端 archive stage，从未激活 stable。原因是其干净 URL 在文件 stage 前被 CDN 缓存为 404；发布门禁因此停止。没有覆盖不可变 archive，也没有清除 CDN 缓存；最终以新的不可变 `0.3.19 / sequence 22` 完成发布。

## 并发结论

当前 `operation_invoke` 在 Remote Connector Gate 内是 exclusive，mutation 实际单飞。把 Feature 并发从 4 提到 5 不会提高写入吞吐，只会扩大排队、permit 超时和授权故障扇出。本版不提升并发；后续提速必须先把 Gate 拆成 maintenance lane、有限并行 read-only lane 与有证据约束的 mutation lane。
