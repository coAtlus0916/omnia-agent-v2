# 录制 Feature __FEATURE_VERSION__

`omnia.recording` 是 Omnia Agent v5 随产品发布的官方内置 Feature。它仍使用独立签名包、独立 worker 和独立版本，但首次启动时由 Shell 从随包候选自动安装，不要求用户运行 Feature 安装器。

本补丁的 Registry 导航是 `其他 → 录制`。从 0.1.0 升级保留同一 `featureId`、Surface、Worker Store、Run 和 Connector 合同；仅修正错误的 `Feature → 录制` 分组，不覆盖旧候选。

## 真实闭环

- “开始详细录制”由 Connector 在当前唯一绑定的 Pack 页面建立 CDP 会话，记录页面导航、用户交互、网络请求/响应和允许的 JSON 请求/响应体；凭据和请求/响应 headers 不落盘。
- “停止并导出”先等待关键请求、响应体读取和网络静默，再输出 `recording.json`；任何关键 body 缺失、事件丢弃或 drain 超时都使完整性为 incomplete。
- “取消录制”停止 Connector 录制会话，不生成导出文件，并保留真实 cancelled 状态。
- “抓取当前 GRA Risk/Control 完整目录”只允许 GET。Connector 必须先从当前页面实际观察到唯一 `riskAssessmentId`；没有、多个或 Pack/会话发生变化时明确阻塞。

## 完整目录

目录读取使用 v4 已验证的 Omnia 合同：GRA detail、IT Element detail、`plannedresponse/byRiskAssessmentId`、`controls/byRiskAssessmentId`、每个 Control detail，以及每个 Risk 的 `GetPlanResponseDetailByRiskRiskScopeId`。输出 `risk-control-catalog.json` 与 `manifest.json`，包括稳定身份、真实 Risk/Control、观察到的 scope/关系和 endpoint 完整性。

Higher/Lower 仅记录为 `capturedRait`。目录出现不等于母版需要关联；输出明确保留 `linkRequired: null`，合并逻辑也不会推断未录制的另一 RAIT。

## 安全边界

该 Feature 不创建、修改、删除或关联任何 Omnia 对象。目录命令合同没有 method、URL、headers 或 body 输入；这些均由 v5 Connector 的固定只读实现控制。本地和远程 Connector 使用相同 `omnia.v5.recording-command/v1` 合同。

## 尚需真实验收

自动化覆盖代码、协议、字段归一化、完整性与 local/remote 转发。真实 Omnia Pack 的首次 live canary 必须由用户在受控 Edge 登录后完成；未执行 live canary 时不得把 fixture 结果描述为生产验证。
