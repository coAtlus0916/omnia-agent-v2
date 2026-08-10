# Shell 0.4.2 / Remote Connector 0.3.5 公司电脑 Pack canary

日期：2026-08-03
状态：**未通过/待 canary**
环境：需要用户授权的公司电脑、最终 Remote Connector `0.3.5 / sequence 8`、Bridge `0.4.1` 和非生产测试 Pack

## 通过门槛

只有以下步骤全部以最终正式包在公司电脑完成并保存脱敏 Evidence，状态才可改为“通过”：

1. Shell 首次点击 Connect，生成短期一次性链接码；在公司电脑 Remote Connector 输入该码并完成配对。
2. Shell、Bridge 与 Connector 报告相同 `pairId/generation/protocol` 和经脱敏的唯一 Connector identity。
3. 点击 Connect；Remote Connector 打开自己的受控 Edge profile。
4. 用户在该 Edge 登录 Omnia 并打开目标测试 Pack。
5. 不第二次点击 Connect，Shell 自动显示实时 hierarchy 返回的真实 Pack 名称。
6. 执行真实 `status`、`refresh`、`workspace_light_read`；确认 authority/Engagement/Pack identity 一致。
7. 重启 Shell，不输入链接码，自动恢复 binding 并重新验证 Session/Pack。
8. 重启 Remote Connector，不输入链接码，自动恢复 binding 并重新验证。
9. 断网后恢复，不输入链接码，transport 自动恢复；旧 Pack snapshot 不在重新验证前显示 connected。
10. 重启 Bridge，不输入链接码，双方 heartbeat/reconnect 后恢复。
11. 主动解除绑定，证明旧 credential/generation 无法认证；使用新链接码重新配对。
12. 检查 Shell Settings、顶栏、进程和 package，证明不存在 Local Connector、模式切换或 fallback。

## 证据要求

- 不记录链接码、token、Authorization、Cookie、DPAPI/safeStorage 密文、完整 Connector ID、客户正文或生产绝对路径。
- 记录每步时间、版本/release identity、非敏感协议/generation、真实状态转换、Pack 名称的合规脱敏引用和错误。
- 截图只能辅助；状态 envelope、Bridge heartbeat、Connector logs allowlist、Shell snapshot 和真实 operation response 是主要证据。
- canary 失败不能用 fixture 重跑替代；修复后必须用最终重打包版本重新执行受影响步骤。

## 当前结果

本工作区没有公司电脑 Omnia 登录、授权测试 Pack 和现场网络/Bridge 重启权限，因此上述步骤尚未执行。Remote 真实 Pack canary 未通过/待 canary；自动化或 Windows 本地便携冒烟不改变该结论。
