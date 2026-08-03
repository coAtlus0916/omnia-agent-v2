# Omnia Agent v5 内置录制 Feature

源码位于 `source/`，不可变签名候选位于 `candidates/`。候选由 `npm run package:recording-feature` 生成，并由 v5 Shell 首次启动自动安装；无需用户操作安装器。

当前正式补丁为 `omnia.recording@0.1.1 / sequence 2`，导航为 `其他 → 录制`。`0.1.0` 保留为不可变历史候选；0.1.1 只修正导航元数据与随包文档，不改变 recording command、Worker 数据或 Run 兼容性。
