# Remote Connector 0.3.15 发布记录

日期：2026-08-05；sequence：18。

本版修复跨 JavaScript Realm 的 Operation 异常序列化：Remote Command Gate 不再仅依赖 `instanceof Error`，而是读取受限的字符串 `message` 字段，并继续保留既有错误码与 retryable 标记。这样签名 Operation 在远端失败时会把具体的合同或 Omnia 步骤错误返回给 Shell，避免所有失败都退化为“Remote Connector 操作失败”。

发布仍使用既有 stable 自动升级通道。现场确认 Connector 从 0.3.14 自动升级到 0.3.15，无需用户下载或替换便携包；v4 manifest 未变化。

- stable：`https://download.example.invalid/files/v5-remote-connector/stable.json`
- ZIP：`https://download.example.invalid/files/v5-remote-connector/releases/0.3.15/Omnia-Agent-v5-Remote-Connector-v0.3.15-Portable.zip`
- SHA-256：`a536cea5e3dff5a2218dfef707d9354afd51ba73edd547a586cb234108df4550`
- size：`37307674`
