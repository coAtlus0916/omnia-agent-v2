# Remote Connector 0.3.11 发布记录

状态：`0.3.11 / sequence 14` 唯一候选已发布到 v5 stable；公司电脑当前实际运行版本仍以在线握手回传为准

## 范围

`0.3.11 / sequence 14` 修复旧便携目录的 `CheckForUpdates.cmd` 在真实在线检查前重新安装自身、从而对较新的托管 `current` 误报 downgrade 的问题。已有托管安装时，命令现在只调用稳定 bootstrap Supervisor；首次尚未安装时才执行安装。

本版同时接收 Bridge `update_check` 控制信号。信号不携带 URL、版本、脚本、命令或执行参数，只在 `%APPDATA%\OmniaAgentV5RemoteConnector\update.request` 写入一次本机更新请求。Supervisor 继续独占以下责任：固定 stable 源、正式包验证、单调 sequence、candidate/active/previous、安全窗口、probation 和回滚。

## 架构边界

- Frontend/Middle/Core：无业务或 UI 变更，不新增看起来可用的按钮。
- Bridge：只发固定 schema 的检查信号，不下载、不安装、不选择版本。
- Connector Worker：只唤醒真实 Supervisor，不执行任意远程命令。
- Supervisor：继续以真实 managed state 和 worker status 决定下载、暂存与激活。
- v4：安装根、数据根、进程和更新通道不读取、不修改。

## 当前存量端

`0.3.10` 及更早 Worker 不认识 `update_check`，必须先通过既有 Supervisor 自动轮询或本机 bootstrap 的 `--once` 完成一次升级。旧 Worker 会忽略未知控制信号，不会因此清空 binding 或退回 Local。升级到 `0.3.11` 后，Bridge 连接建立时及其后固定周期均可远程唤醒检查。

## 验收状态

- 用户明确要求本轮停止单元测试；未运行单元测试。
- `npm run build` 已完成，Shell/Bridge/Connector TypeScript 均成功构建。
- 唯一候选：`Omnia-Agent-v5-Remote-Connector-v0.3.11-Portable.zip`，大小 `37306985` bytes，SHA-256 `3af0660dcf2d74ab7d2485921f34c276aa7296d50a68ec2c72c7d335fd4a4585`。
- stable 已发布：`https://download.labcaspian.com/files/v5-remote-connector/stable.json`，归档已发布到 `releases/0.3.11/`；发布脚本确认 v4 manifest 未变化。
- 生产 Bridge 已在线且有一个 Connector 会话；这只能证明远程控制面已接通，不能冒充该存量端已经从旧 Worker 切换到 `0.3.11`。旧 Worker 的第一次迁移仍由既有 Supervisor 轮询或一次本机 `--once` 完成。
