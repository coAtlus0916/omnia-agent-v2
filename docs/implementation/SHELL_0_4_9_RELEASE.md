# Shell 0.4.9 发布记录

日期：2026-08-04

0.4.9 修复安全锁“未返回可核验的 Workspace Facet ID”的真实根因。旧实现请求了错误的 Workspace Facet Type，并让 Connector 进行业务目录归一化；本版改为 Connector 固定读取、原始响应回传，Core 解析并核验 Connector session、authority、tenant/org、Pack、engagement 与精确 Workspace Facet ID。

启用安全锁时 Core 会重新读取权威目录；安全锁已启用时，每次 Feature action 前再次实时读取。任一身份漂移、空目录、冲突 ID 或读取失败均失败关闭。数据库 migration 20 清除旧版缺少完整身份字段的安全锁授权，用户必须在当前 Pack 重新选择并启用。

内置 Feature 为 `omnia.recording@0.3.0` 与 `omnia.create-associate@0.2.3`。源码构建与发布打包不等于真实公司 Pack canary；现场结果必须由目标环境验证。
