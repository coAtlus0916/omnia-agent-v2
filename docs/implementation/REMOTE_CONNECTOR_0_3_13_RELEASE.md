# Remote Connector 0.3.13 发布记录

日期：2026-08-04；sequence：16。

本版恢复 v4 已验证的稳定托管启动语义。旧便携包低于 managed `current` 时保留更高版本，不再以 downgrade 错误阻断启动；`start` 只委托 bootstrap Supervisor，不重新安装调用者所在的旧便携包。

升级后的 Worker 会修复版本无关的 `%LOCALAPPDATA%\OmniaAgentV5RemoteConnector\StartManagedRemoteConnector.cmd`，并建立当前用户登录自启动入口。正常升级由 Bridge 下发和 Supervisor 固定 stable 轮询完成，不要求用户下载、替换或运行安装包。Supervisor 独立轮询间隔由六小时收紧为五分钟；连接 Bridge 时仍立即触发一次检查。
