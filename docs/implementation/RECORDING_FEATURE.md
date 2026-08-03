# 官方内置录制 Feature

`omnia.recording` 0.1.1 / sequence 2 是独立签名、独立 worker、可独立升级的 v5 Feature。候选包随 Shell 放入 `resources/app/builtins/recording-0.1.1.ofp`，首次启动由 Core 自动安装，因此用户无需运行 Feature 安装器；入口显示在 `其他 > 录制`，内容使用 Tabbed Feature Surface。

0.1.1 是 0.1.0 的兼容导航补丁：保持同一 Feature ID、Surface、Worker Store、Run 和 Connector command，只把错误的 `Feature > 录制` 改为稳定 group id `other`/标签“其他”。0.1.0 包保持不可变并作为 previous；Package Manager 会把后装 `omnia.delete-elements@0.1.2` 合并到同一“其他”分组。

## 四层实现

- Frontend：声明式 Surface 展示 Connector 的连接、录制、目录与导出结果；动作可用性由真实状态更新。
- Middle：`feature-packages/recording/source/middle/worker.cjs` 调用窄化 recording command，写入 Feature evidence store。
- Connector：`src/connector/recording/recording-service.ts` 由 Remote Worker 的 `WorkstationOmniaSession` 宿主，负责 CDP 交互/页面/网络证据、脱敏响应体、关键 endpoint 完整性和 graceful stop；使用同一 `omnia.v5.recording-command/v1` payload。
- Package：`scripts/package-recording-feature.mjs` 生成官方不可变 0.1.1 `.ofp`；`scripts/package-windows.mjs` 把它装入 Shell 0.4.1 便携包。

## v4 复用与重构

v4 `omnia-recorder.js` 的事件类型、凭据排除、关键 response body 完整性和停止 drain 语义重构为 v5 Playwright CDP 会话。v4 `omnia-session-host.js` 的唯一 Pack/Engagement 绑定原则进入 Remote Connector 内部的 `WorkstationOmniaSession`。v4 浮动 recording controller 不复用；v5 使用隔离 Feature Surface。所有代码和产物均在 v5 工作区，不存在 v4 运行时路径依赖。

## Phase1 Risk/Control 完整目录

只有当前页面实际请求过唯一 GRA 的已验证目录 endpoint，Connector 才接受抓取；无身份或多身份时返回真实 blocker。抓取全程只使用固定 GET：

- GRA detail 与 IT Element detail；
- `plannedresponse/byRiskAssessmentId`；
- `controls/byRiskAssessmentId`；
- 每个 Risk 的 `GetPlanResponseDetailByRiskRiskScopeId`；
- 每个 Control detail。

输出包含稳定 engagement/pack/workspace/GRA/IT Element 身份、元素类型/子类型/GRA content、真实 Risk/Control、观察到的 scope/assertion/关系和逐 endpoint manifest。必需 read、response capture、Risk scope detail、Control detail、元素/GRA/RAIT 身份任一缺失即为 `incomplete`。

Higher/Lower 只按 `capturedRait` 记录和合并。观察到的关系单列保存，`linkRequired` 固定保持未知 `null`，不得由目录存在推断母版应关联。

## 验收边界

自动化使用受控 CDP/HTTP fixture 验证代码与合同。未使用用户 Omnia 登录，因此真实 Pack 的 endpoint 返回形态、Edge 交互覆盖和 Remote 跨 Bridge 现场录制仍需用户授权环境 canary；不得把 fixture 通过描述为生产数据验收。

## Remote-only 平台边界（2026-08-03）

本轮不改写 `omnia.recording@0.1.1` 包、sequence、Worker、Operation 或随包文档。Shell 0.4.2 删除 Local 产品链后，录制 Connector command 只能经 RemoteConnectorTransport → Bridge → 公司电脑 Remote Worker → `WorkstationOmniaSession` 的同一签名 recording contract 执行；缺 binding、Connector offline、不兼容或真实 Pack 未就绪时失败关闭，不存在 Local fallback。公司电脑真实录制 canary 未通过/待 canary。
