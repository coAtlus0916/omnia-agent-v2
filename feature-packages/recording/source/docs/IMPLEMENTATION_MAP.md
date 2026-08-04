# 录制 Feature 实现映射

| 层 | 文件/合同 | 责任 |
|---|---|---|
| Frontend | `frontend/surface.json` + 通用 `recorder` Surface 合同 | 播放器式显示真实录制状态、计时、录制/暂停/停止/导出和自动采集计数 |
| Middle | `middle/worker.cjs` | 调用窄化 recording command、分块接收导出、提交真实 Artifact、按 Connector 状态更新 Surface |
| Backend | `FeatureRuntimeStore.commitStandaloneArtifact` + Feature 私有 evidence store | 为无上传源文件的 Connector 证据创建受管 Run/Artifact，并持久录制动作证据 |
| Connector | `omnia.v5.recording-command/v1` | CDP 录制/暂停/继续/停止、当前页 Risk/Control 自动采集、分块导出与完整性 |
| Runtime | `FeaturePackageManager` | 仅允许 `omnia.recording` worker 使用专用命令；其他 Feature 不能借用 |
| Built-in | Shell 启动/bootstrap | 安装随包官方候选，仍保留独立升级版本 |

`omnia.recording@0.3.0 / sequence 4` 源码候选保持独立 Feature；Shell Renderer 只识别通用 `recorder` 与 action `presentation`，不按 `featureId` 或 action id 硬编码录制业务。

详细录制实现位于 v5 自有 `src/connector/recording/recording-service.ts`，不引用任何 v4 运行时路径。Bridge 单消息上限 2 MiB，导出使用 512 KiB 二进制分块，并在 Core 的 64 MiB Artifact 上限前失败关闭；不会静默截断。
