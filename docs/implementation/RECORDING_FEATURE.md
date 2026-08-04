# 官方内置录制 Feature

`omnia.recording` 0.3.0 / sequence 4 已生成官方签名候选，并内置到本地 Shell 0.4.8 不可变包。0.2.0 与更早候选保持不可变，可作为历史 rollback 目标。本轮没有完成公司电脑真实 Omnia canary，因此不宣称现场录制已经通过。

0.3.0 保持同一 Feature ID 和 Remote-only recording command，新增播放器式 `recorder` 声明合同、真实 pause/resume/stop/export 状态、当前页 Risk/Control 自动采集和跨 Bridge 分块 Artifact 交付。旧 `stop_export` 与手工 catalog command 只为已安装旧包保留 Connector 兼容性；0.3.0 Surface 不再声明这些按钮。

## 四层实现

- Frontend：通用声明式 `recorder` Surface 渲染播放器、真实计时投影、事件/Risk/Control 计数和五个控制动作；Renderer 不含录制 Feature ID 分支。
- Middle：`feature-packages/recording/source/middle/worker.cjs` 调用 start/pause/resume/stop/export/export_chunk，写入 Feature evidence，并把真实文件提交到 Core Artifact Store。
- Core/Data：`FeatureRuntimeStore.commitStandaloneArtifact` 为没有用户上传源文件的 Connector evidence 创建独立 succeeded Run 和受管 Artifact；下载使用既有 `surface:save-feature-artifact`。
- Connector：`src/connector/recording/recording-service.ts` 与 `WorkstationOmniaSession` 负责 CDP、暂停恢复、graceful drain、当前页自动目录采集、持久 manifest 和 512 KiB 导出分块。
- Package：`scripts/package-recording-feature.mjs` 已生成并验签 0.3.0 / sequence 4 `.ofp`；Shell 0.4.8 release manifest 固定引用该候选。

## v4 复用与重构

v4 `omnia-recorder.js` 的同一 recordingId 多 segment、pause/continue、关键 response body 完整性和停止 drain 语义重构为 v5 Playwright CDP 会话。v4 `omnia-session-host.js` 的唯一 Pack/Engagement 绑定原则进入 Remote Connector 内部的 `WorkstationOmniaSession`。v4 UI 的播放/暂停/停止交互语义被保留，但界面通过 v5 通用声明式 Surface 重写。所有代码均在 v5 工作区，不存在 v4 运行时路径依赖。

## Phase1 Risk/Control 完整目录

Connector 监听当前页面实际出现的唯一 GRA 身份，并在开始、网络观察、暂停和停止时自动抓取；无身份、多身份、授权未就绪或读取缺失都进入录制 manifest 的真实 pending/incomplete 状态，不再要求用户点击单独按钮。抓取全程只使用固定 GET：

- GRA detail 与 IT Element detail；
- `plannedresponse/byRiskAssessmentId`；
- `controls/byRiskAssessmentId`；
- 每个 Risk 的 `GetPlanResponseDetailByRiskRiskScopeId`；
- 每个 Control detail。

输出包含稳定 engagement/pack/workspace/GRA/IT Element 身份、元素类型/子类型/GRA content、真实 Risk/Control、观察到的 scope/assertion/关系和逐 endpoint manifest。必需 read、response capture、Risk scope detail、Control detail、元素/GRA/RAIT 身份任一缺失即为 `incomplete`。

Higher/Lower 只按 `capturedRait` 记录和合并。观察到的关系单列保存，`linkRequired` 固定保持未知 `null`，不得由目录存在推断母版应关联。

## 导出边界

Bridge WebSocket `maxPayload` 为 2 MiB，不能一次回传完整录制。Connector 先冻结 `recording.json`，再通过 `export_chunk` 返回最多 512 KiB 的真实文件分块；Worker 核对序号和冻结长度后提交 `commitStandaloneArtifact`。超过 Core 64 MiB 单 Artifact 上限时明确失败并保留 Connector 原始录制，不截断、不显示成功下载。

## 验收边界

本轮按用户要求停止单元测试，只执行一次 typecheck/build。未使用用户 Omnia 登录，因此真实 Pack 的 endpoint 返回形态、暂停恢复、当前页自动 Risk/Control 和 Remote 跨 Bridge Artifact 导出仍需用户授权环境 canary；不得把源码检查描述为生产数据验收。

## Remote-only 平台边界（2026-08-03）

录制命令只能经 RemoteConnectorTransport → Bridge → 公司电脑 Remote Worker → `WorkstationOmniaSession` 执行；缺 binding、Connector offline、不兼容或真实 Pack 未就绪时失败关闭，不存在 Local fallback。公司电脑真实录制 canary 未通过/待 canary。
