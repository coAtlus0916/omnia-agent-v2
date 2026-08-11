# Shell 0.4.11 候选记录（未激活）

0.4.11 将 `omnia.delete-elements@0.1.5` 纳入与 recording、`create-associate@0.2.4` 相同的 builtin bootstrap。用户只启动同一个 Shell 包，Core 会按官方包版本自动安装或升级；不再要求下载或运行单独的删除 Feature 安装器。

删除能力仍保持独立 Worker、私有 Store、声明式 Surface 和签名 Connector Operation，Shell 不包含删除业务分支。该版本继承 0.4.10 的安全锁大弹窗、搜索、真实 Section 折叠、右侧已选、全局关联锁与 authority 读取 single-flight 修复。

Shell build 与 builtin package 生成已通过；按用户要求未运行单元测试。真实 Omnia Section membership 和 Remote 删除 canary 仍待公司电脑验证。

0.4.11 的初版启动器直接调用开发版 Electron，导致 Windows 数据保护上下文与便携实例不一致，无法解包既有实例密钥，因此不作为最终热更新宿主。不可变目录保留为候选证据，当前版本顺延到 0.4.12。
