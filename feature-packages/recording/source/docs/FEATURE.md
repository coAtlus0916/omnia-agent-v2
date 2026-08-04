# 录制 Feature __FEATURE_VERSION__

`omnia.recording` 是 Omnia Agent v5 随产品发布的官方内置 Feature。它仍使用独立签名包、独立 worker 和独立版本，但首次启动时由 Shell 从随包候选自动安装，不要求用户运行 Feature 安装器。

本版本保留同一 `featureId`、Surface、Worker Store 和 Remote-only Connector 合同，把录制交互改为播放器式真实状态机。

## 真实闭环

- “录制/继续”由 Connector 在当前唯一绑定的 Pack 页面建立或恢复同一 `recordingId` 的 CDP 会话，记录页面导航、用户交互、网络请求/响应和允许的 JSON 请求/响应体；凭据和请求/响应 headers 不落盘。
- “暂停”先排空关键请求和 response body，再断开本段 CDP 采集；继续时仍使用同一 `recordingId`、Pack 与 Session generation。
- “停止”只结束录制并冻结完整性，不暗中执行导出。
- “导出录制记录”在 Connector 生成真实 `recording.json`，再按 Bridge 2 MiB 消息边界分块回传，由 Feature Worker 合并并提交到 Core Artifact Store；界面的下载入口指向受管 Artifact，不是 Connector 本机路径。
- 当前页出现唯一 `riskAssessmentId` 时自动执行只读 GRA/Risk/Control 目录采集；开始、网络观察、暂停和停止都会尝试补齐。没有、多个或 Pack/会话发生变化时保留真实 incomplete 原因，不显示单独的假采集按钮。

## 完整目录

自动目录读取使用 v4 已验证的 Omnia 合同：GRA detail、IT Element detail、`plannedresponse/byRiskAssessmentId`、`controls/byRiskAssessmentId`、每个 Control detail，以及每个 Risk 的 `GetPlanResponseDetailByRiskRiskScopeId`。目录被写入同一录制目录并随 `recording.json` 导出，包括稳定身份、真实 Risk/Control、观察到的 scope/关系和 endpoint 完整性。

Higher/Lower 仅记录为 `capturedRait`。目录出现不等于母版需要关联；输出明确保留 `linkRequired: null`，合并逻辑也不会推断未录制的另一 RAIT。

## 安全边界

该 Feature 不创建、修改、删除或关联任何 Omnia 对象。自动目录采集没有可由前端传入的 method、URL、headers 或 body；这些均由 v5 Connector 的固定只读实现控制。录制只允许 Remote Connector，不存在 Local fallback。

## 尚需真实验收

本轮按用户要求停止单元测试，只执行源码 typecheck/build。真实 Omnia Pack 的 start → 自动 Risk/Control → pause → resume → stop → Artifact export live canary 仍必须由用户在受控 Edge 登录后完成；未执行 live canary 时不得描述为生产验证。
