# Omnia Agent v5 Remote Connector 0.3.4 发布记录

发布日期：2026-08-03  
版本 / sequence：`0.3.4 / 7`

> 2026-08-03 历史说明：本页记录的 waiting discovery、设置页匹配和双模式路径已由 [Remote-only ADR](../adr/0035-remote-only-connector-and-link-code-pairing.md) 取代。0.3.4/sequence 7 产物保持不可变；新候选见 [0.3.5 发布记录](REMOTE_CONNECTOR_0_3_5_RELEASE.md)。以下内容只描述当时发布事实，不是当前产品操作说明。

## 产物与地址

- stable：`https://download.example.invalid/files/v5-remote-connector/stable.json`
- ZIP：`https://download.example.invalid/files/v5-remote-connector/releases/0.3.4/Omnia-Agent-v5-Remote-Connector-v0.3.4-Portable.zip`
- Bridge：`https://agent.example.invalid/v5-bridge/`

正常用户只需 Start → Agent 设置选择 Remote/匹配 → 首页 Connect。独立 Pair 脚本只用于诊断。

自动测试覆盖 Bridge discovery、多候选、取消/迟到隔离、Remote 统一 Operation gate、DPAPI 重启复用、
portable waiting smoke、签名/哈希/size/sequence 和 safe-window policy。真实旧 portable `0.3.3`
已从线上 stable 自动升级到最终 `0.3.4`，得到 `previous=0.3.3`、`highestSequence=7`、
`pending=null`、`activeOperations=0`、`uncertainOperations=0`。

公开 canary 不使用用户 Omnia 登录，不冒充真实 Pack 验证。公司电脑的 refresh/workspace、录制和
官方 mutation Operation 仍需用户授权环境最终 canary。
