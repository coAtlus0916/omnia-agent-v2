# Shell 0.4.12 发布记录

0.4.12 是最后一个按当前日常开发流程生成的 Electron 宿主。固定启动器先构建同级工作区，再设置工作区入口并启动 0.4.12 宿主；主进程、Renderer、Worker Host 与 builtin Feature 均从最新工作区加载，Windows 数据保护仍使用同一个发布宿主和产品数据根。

该宿主当前热更新内置 `omnia.recording@0.3.0`、`omnia.create-associate@0.2.6` 与 `omnia.delete-elements@0.1.5`。builtin bootstrap 从工作区候选包自动安装或升级，不要求重新生成 EXE，也不要求单独安装删除 Feature。

安全锁支持搜索、真实 Section 折叠、右侧已选列表和全局 Section 关联范围。Core 对相同 authority identity 共享进行中的读取，保存时重新读取实时 Workspace/Section，单事务 CAS 持久化，并冻结全局 Section 当时的精确 Workspace 成员；删除 Feature 只消费冻结后的允许范围。

热更新补充：同一 Feature 存在多个 docked/detached WebContents 时，任一动作完成或失败都会把 Core 最新 Surface 广播到所有匹配实例。文件选择前由 Main 再核对当前 workflow；后台已进入校验或回传时拒绝旧上传窗口的选择请求，并立即刷新为当前步骤，避免成功导入后被旧界面误导为再次上传失败。

按用户要求未运行单元测试。发布前只执行一次构建、用户启动器启动检查和已安装 Feature 版本检查；真实 Omnia Section membership、保存与 Remote 删除仍待公司电脑 canary。
