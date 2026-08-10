# Bridge 0.4.4 发布记录

日期：2026-08-04
状态：源码与定向自动化已通过；不可变候选已生成在 `bridge/releases/0.4.4/`；2026-08-04 已原位部署到公开 v5 Bridge。部署保留 `.env`、binding 持久卷和 0.4.3 服务器恢复副本；公开 health 返回 `version=0.4.4`、正确 protocol/capability，原有 Connector 自动恢复为在线。尚未执行新链接码的真实重新配对，也不把 health/在线恢复记为真实 Pack canary。`release-manifest.json` 文件 SHA-256 为 `4fe910a0dd55b04d3858e313390bba852eca9e7f7267ca7db2d762d56e5143db`。

## 变更范围

- 链接码收紧为密码学随机的四位数字码，左侧补零。
- Bridge 仅持久化链接码 hash，不保存明文；有效期为两分钟，且成功配对后不可再次消费。
- `POST /v1/pair` 对失败尝试实施“来源 IP + Connector 身份”和全局双重预算；达到阈值后统一返回 `429`。
- Shell 和 Remote Connector 同时校验四位数字格式与两分钟服务端有效期，不接受旧合同静默 fallback。

## 证据与未验证边界

`tests/bridge-e2e.test.ts` 覆盖四位补零、批量唯一性、hash-only 存储、两分钟失效、一次消费、按 scope 与全局限速、成功 scope 恢复。部署后的公开 health 与原有 Connector 在线恢复均已验证；这仍不等于四位码真实重新配对或目标 Omnia Pack canary。
