# 底稿编制签名 Operation __FEATURE_VERSION__

Operation package 提供五个能力：

- `omnia.workpaper.directory.read.v1`：读取当前 authority 内的 Application GRA 与精确 APP/Workspace 身份。
- `omnia.workpaper.controls.read.v1`：读取选定 GRA 的 Control 目录和每个 Control 的精确详情。
- `omnia.workpaper.control.preflight.v1`：重新核验 GRA/APP/Workspace/Control/Work Item，并冻结 Tab 201 token；它只为单一隐藏 Tab mutation 签发 permit。
- `omnia.workpaper.control.open-hidden-tab.v1`：对同一 Control 提交一次 JSON Patch，将 `planningOperatingEffectivenessTesting` 设为 `true`，并带 Tab 201 并发 token。
- `omnia.workpaper.control.reconcile.v1`：只读同一个 Control；成功必须有布尔值、OE 实体和唯一 Tab 209 token。

Operation handler 不保存 Feature 计划，不实现业务界面，不修改 Connector。任何身份歧义、跨 Workspace、缺失 token 或只出现布尔值但没有 OE 实体的状态均失败关闭。

