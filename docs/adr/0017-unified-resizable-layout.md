# ADR-0017：所有相邻功能区域使用统一可调整边界

状态：Accepted  
日期：2026-07-30  
决策者：用户

## Context

用户要求所有按功能分界的区域，其相邻边界均可拖动调整大小。v4 已为主 Shell 的少数列提供 pointer、键盘和双击复位，但范围固定，宽度直接保存到 localStorage，Feature 内部布局仍各自实现或完全不可调。

若每个 Feature 单独实现 splitter，会产生手势、最小尺寸、可访问性、持久化和升级语义不一致。

## Decision

- Shell 和所有 Feature 使用公共 `ResizableLayout` / `Splitter`。
- 每两个相邻、长期存在且承担不同功能的区域之间使用统一可拖动边界。
- 支持横向、纵向、嵌套、pointer、键盘和双击/Enter reset。
- panel/splitter 由稳定 layout manifest 声明。
- Core LayoutPreference service 是持久布局唯一 owner。
- 拖动中只做本地 preview，释放后提交最终值；失败回滚。
- 偏好按 profile/surface/layoutVersion 隔离，Feature 不能修改其他 surface。
- UI scale 与区域比例分开保存、组合计算。
- 普通卡片、列表行和临时弹窗不因本决定强行增加 splitter。

## Consequences

- 新 Feature 必须复用公共布局组件和合同；
- Feature Package 需要声明布局 manifest 与升级策略；
- 需要跨窗口、分辨率、系统缩放、应用缩放和嵌套 splitter 测试；
- v4 的局部 localStorage 宽度不能原样作为 v5 system of record；
- 统一组件故障影响面较大，因此必须有安全默认布局和分 surface reset。

## Verification

- ResizableLayout 合同测试和无障碍测试；
- pointer capture、取消、键盘、双击 reset 测试；
- Core CAS、多窗口同步和保存失败回滚测试；
- Feature 升级/layoutVersion 迁移测试；
- Windows 分辨率 × 系统缩放 × UI scale 布局矩阵；
- 删除/上传/确认等业务 action 不被拖动误触的 E2E。

