# Shell 0.4.8 发布说明

状态日期：2026-08-04
基线：Shell 0.4.7

## 修复

- Windows portable data 的 `safeStorage` 密钥不可读时不再静默退出。旧 `data/` 会完整移动到产品根 `recovery/unreadable-data-*`，创建新的可启动数据根，并向用户显示恢复位置；其他启动错误也通过原生错误框显式报告。
- 启动时的 Workspace 目录刷新失败只投影为真实安全锁不可用状态，不再关闭 Shell，也不把有效 Transport 伪装成断线；用户可在 Remote Connector 更新后从安全锁工作台重新刷新。
- 增加单实例锁；重复双击只聚焦已有主窗口。
- 安全锁恢复 v4 已验证的授权语义：当前 Pack + 精确 Workspace Facet ID。Section/parentSectionId 仅作可选展示分组，缺失或歧义时进入“当前 Pack Workspace”，不猜测关系。
- 通用 Feature Surface 支持显式 `clearFields`，解决 JSON 丢弃 `undefined` 后旧 Review/Progress 残留的问题。
- Feature 激活版本变化时，Core 会把持久 Surface 身份/action 清单切换到新包版本；旧版本 Run 和审计仍保留，但旧 Surface 不再冒充当前 activation head。
- 通用 Feature action 增加 `restart` presentation，可在左侧流程下方呈现真实后台动作，Shell 不按 Feature ID 硬编码业务。

## 内置组件

- `omnia.recording 0.3.0 / sequence 4`
- `omnia.create-associate 0.2.2 / sequence 4`
- Remote Connector 配套版本 `0.3.10 / sequence 13`

## 验证边界

本地发布要求一次 TypeScript 检查、一次构建、官方包生成/验签和真实 `releases/0.4.8/Omnia Agent v5.exe` 用户入口启动。公司电脑上的真实 Pack 安全锁、录制和 mutation 仍必须单独 canary，不能由本地启动替代。

本轮最终产物已经由上述真实 EXE 入口打开主窗口；Core 读回确认 `omnia.create-associate@0.2.2` activation 与持久 Surface 版本一致，Surface 声明含 `restart-run` 和 `back-to-upload`。当前公司端仍回报 0.3.9 的历史 parentSectionId 错误，因此只把 0.3.10 记为“已发布 stable”，不冒充公司端已激活或安全锁 canary 已通过。
