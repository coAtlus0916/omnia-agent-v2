# 录制 Feature 实现映射

| 层 | 文件/合同 | 责任 |
|---|---|---|
| Frontend | `frontend/surface.json` | 在 v5 Feature Surface 中显示真实状态和五个动作 |
| Middle | `middle/worker.cjs` | 调用受控 recording command、持久化结果证据、按真实结果更新 Surface |
| Backend | `backend/migrations/001.json` | Feature 私有录制证据表 |
| Connector | `omnia.v5.recording-command/v1` | CDP 详细录制、只读目录重抓取、导出与完整性 |
| Runtime | `FeaturePackageManager` | 仅允许 `omnia.recording` worker 使用专用命令；其他 Feature 不能借用 |
| Built-in | Shell 启动/bootstrap | 安装随包官方候选，仍保留独立升级版本 |

`omnia.recording@0.1.1 / sequence 2` 在 Registry 中声明 `other / 其他 → 录制`。同组的后装 `omnia.delete-elements@0.1.2` 由 Package Manager 按稳定 group id 合并；Shell 不硬编码任一业务叶子。

详细录制实现位于 v5 自有 `src/connector/recording/recording-service.ts`，不引用任何 v4 运行时路径。
