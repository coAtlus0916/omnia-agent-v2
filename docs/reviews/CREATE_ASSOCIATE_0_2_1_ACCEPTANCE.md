# omnia.create-associate 0.2.1 验收记录

日期：2026-08-04
配套 Shell：0.4.6
状态：源码与只读审计已完成；候选包、便携用户测试和真实 Omnia canary 尚未完成。

## 本次修复范围

- V3 用户输入只包含官方 APP/DB/OS/Tool 字段；`isDataAvailable` 不再作为用户字段、必填项或可编辑项。
- Feature Surface 使用“步骤栏 + 当前操作”的两列布局，步骤固定为上传资料、校验、回传。
- 校验页恢复 v4 的 11 个稳定检查身份，并提供元素类别栏、当前元素选择、字段级问题、官方用户字段直接修订、派生 GRA/Description 只读展示、CAS 保存及全部重检。
- APP 的活动对象、GRA、回收站、Workspace、类型、绑定、名称和 RAIT 通过签名 Operation 得到 `create|resume|reuse|skip` 判定。普通身份解析不授予 mutation permit；只有 action-time 的 create-only 预检可以授予一次性对象创建许可。
- 回传继续遵守 Comments 明确确认、幂等命令、逐命令权威读回、响应丢失 `uncertain` 和只读 reconcile；reconcile 不重放 mutation。
- 功能栏扁平显示 Feature；设置包含独立、真实查询的交互日志菜单。

## 证据分层

| 层级 | 当前状态 | 证据 |
|---|---|---|
| v4 只读研究 | 已完成 | 11 项检查、Review 编辑器和 APP 身份/回收站判定已逐源码对照 |
| 源码定向测试 | 已通过 | `node --check`（Worker/Operation）、`npm run typecheck` 与 9 个定向测试文件共 50/50 通过；未包含候选包依赖测试 |
| Feature/Operation 候选包 | 未生成 | 源码冻结后只执行一次构建、签名与打包，不覆盖已发布版本 |
| Shell 0.4.6 便携包 | 未生成 | 只写入 `releases/`；不维护 `artifacts/` |
| 便携用户测试 | 未执行 | 必须从 `releases/Start Omnia Agent v5.cmd` 启动，使用真实 V3 副本检查界面和流程 |
| 真实 Omnia canary | 未执行 | 目标是使用 `source_files/Phase1-用户填写模板V3 - 副本.xlsx` 创建一个 SAP ECC IT Element 与 GRA；实际 mutation 前必须在 Comments 明确确认，完成后逐项读回 |

## 已知边界

- 0.2.1 的真实回传首切片仅开放单 APP 安全闭环；新 DB/OS、Tool、多 APP 继承、跨 Workspace 和批外 APP 目标继续失败关闭。
- Factors Considered AI review 当前显示 `warning/not_evaluable`，不会伪装为 passed，也不作为确定性阻断。只有发布类型化 Feature AI port 并取得真实 Provider 响应后才能标记为执行完成。
- 自动化、包完整性或便携启动成功均不等于真实 Pack canary。

## 发布流程

源码和文档冻结后执行一次相关源码测试、一次 Feature/Operation 打包、一次 Shell build/package；发布阶段只做候选身份、签名/安装、EXE 启动和必要的便携冒烟，不重复整套源码验收或人工逐文件 Hash。
