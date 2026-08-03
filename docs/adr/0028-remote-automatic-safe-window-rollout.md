# ADR-0028：Remote Connector 默认自动安全窗口更新

状态：Accepted  
日期：2026-07-30  
决策者：用户  
Supersedes：ADR-0019 Decision 12 的未决触发策略

## Context

ADR-0019 已经确定 Remote Connector 必须支持分层在线升级、官方签名、candidate/active/previous、活动 mutation/`uncertain` 阻断、probation 和回滚，但把自动安装、通知安装或人工维护窗口留作后续产品决定。

用户现已确认：Remote Connector 的更新体验与 v4 保持一致，由服务器自动下发；客户端不需要等待用户点击“安装”，但仍不得绕过真实安全窗口。

## Decision

1. 默认 rollout policy 固定为 `automatic_safe_window`。
2. 官方发布服务向精确 Remote Connector identity 下发签名 update offer；Supervisor 自动取得、验证、暂存和健康检查 candidate。
3. 只有活动 mutation、未解决 `uncertain`、Artifact 上传、状态未知和不兼容 Run pinning 等 blocker 全部清空后，candidate 才自动激活。
4. UI 只展示真实下载、验证、阻断、激活、probation 和回滚状态；普通更新不要求用户点击才能继续，也不提供绕过安全窗口的“立即强装”。
5. update offer 必须声明 `securitySeverity`、`newRunStopAt`、`maxDrainUntil` 和 `offerExpiresAt`：
   - 普通更新可以等待自然安全窗口；
   - 高危/严重更新到达 `newRunStopAt` 后停止接收会延长暴露面的新高风险 Run；
   - 到达 `maxDrainUntil` 仍有已提交 mutation 时不得强杀或重放，只允许完成既有 effect、兼容只读 reconcile 或进入明确人工处置；
   - 撤销/信任根失陷继续使用 ADR-0019 的更严格失败关闭规则。
6. 更新失败恢复 previous，保持用户选择的 Remote Transport，不自动切 Local，不降低 publisher sequence。
7. Operation Module 优先 side-by-side 更新；只有 Transport、Session、Gate、安全边界、受控 SDK 或基础 Omnia 兼容变化时才更新 Connector Core。

## Consequences

- Remote Connector 可以像 v4 一样由服务器统一维护，不需要逐台人工确认普通更新。
- 自动激活不会牺牲在途 mutation 的确定性，但必须维护可观测 blocker、截止时间和高危更新降险策略。
- 长录制或长期任务不能无限阻止严重安全修复；超过截止时间后停止新的高风险准入，但不强杀已提交 effect。

## Verification

- 服务器下发后无需用户点击即可完成下载、验证、暂存和安全窗口激活；
- 活动 mutation、`uncertain`、Artifact 上传和状态未知分别阻断激活；
- `newRunStopAt` 后新的高风险 Run 被真实 admission rule 拒绝；
- `maxDrainUntil` 后不会强杀、重放 mutation 或静默切 Local；
- candidate/probation 失败恢复 previous，已发生 Omnia effect 不回滚；
- 篡改、未知发布者、sequence 回退、过期 offer 和撤销状态全部失败关闭。
