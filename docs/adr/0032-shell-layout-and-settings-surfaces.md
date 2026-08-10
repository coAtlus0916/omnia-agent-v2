# ADR-0032：精简 Shell Rail、全局会话栏与设置双列布局

状态：Accepted；Feature Surface placement 由 ADR-0034 更新  
日期：2026-08-02  
决策来源：用户 UI 产品决策  
Supersedes：ADR-0010 中第一/第二列职责描述；ADR-0017 中“主界面所有列边界均可调”的部分

后续说明：第二列不内联 Feature Workbench；Feature 默认进入第三列标签式隔离 Surface，需要时可弹出/最小化为独立窗口，详细合同见 [ADR-0034](0034-tabbed-feature-host-and-detachable-surfaces.md)。

## Context

Shell 0.4.0 把首页和 Feature 导航放在窄 Rail，把连接、Pack、保活和安全锁放在第二列卡片，把设置放在第三列顶部。这造成系统入口、会话状态和业务入口职责混杂，也挤占功能工作区。用户通过现有截图给出三个明确视觉锚点，并进一步要求第一列移除“首页”和“其他 / 删除元素”，固定为最小宽度。

设置页还需要把设置菜单与具体表单分开，并保证两个长区域独立滚动。

## Decision

1. 主界面仍为三列，第三列仍永久保留聊天与交付。
2. 第一列使用能容纳 OA 和底部设置的最小固定宽度；只保留这两个对象，不包含首页、业务导航、连接状态或安全锁。
3. 第一/第二列之间没有 Splitter；Rail 宽度不作为 `LayoutPreference` 保存。
4. 第二列只容纳真实 FeatureNavigation 纯菜单/树，不显示标题栏或选中 Feature 工作台；菜单最多三级，二级或三级可为叶子。点击可用叶子后默认在第三列新增/聚焦 docked Feature 标签。
5. 第三列保留不可关闭的 `Comments`、附件、真实进度、唯一确认卡、结果、Artifact 与聊天输入区，并可在同一记录区切换多个隔离 Feature 标签。
6. 连接、刷新、保活、当前 Pack 和安全锁形成跨第二/第三列的全局会话状态栏；缩放位于其右侧。
7. 第二/第三列以及聊天消息流/输入区保留公共 Splitter，调用真实 LayoutPreference。
8. 设置 Surface 采用可调的两列布局：左列真实设置菜单，右列具体设置；两列拥有独立 overflow/滚动容器。当前至少显示 AI 设置和连接器设置。
9. 设置两列使用 `settings.main` Splitter；这不改变主 Shell Rail 的固定宽度。
10. 删除元素的结构化选择与计划创建在第三列 docked Feature Surface 或其主动弹出的独立窗口，唯一确认/进度/结果卡在 `Comments`，终态后自动刷新同一 Surface 的真实目录。

完整尺寸、状态组合、坐标语义和验收规则由 [主界面 UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md)定义。

## Consequences

正面：

- 系统入口、会话上下文、Feature 工作和聊天交付各有唯一 owner；
- 第一列不再承担低密度业务导航，空间更紧凑；
- 全局连接与安全状态在切换 Feature、拖动分区和滚动聊天时始终可见；
- 设置菜单与长表单不再互相带动滚动；
- 删除确认只有一个交互位置。

成本：

- Shell 布局合同需要升级到 `shell.main.v3` 并丢弃旧 Rail Splitter 偏好；v3 新增第二列折叠状态与第三列标签 Host；
- FeatureNavigation 需要迁入第二列纯菜单；Feature Workbench 需要迁入第三列受控隔离 Surface，并支持主动弹出/最小化；
- 会话状态必须由后台提供一致快照，不能拼接不同版本的前端状态；
- 设置页需拆成两个独立滚动容器并新增布局持久化测试。

## Alternatives

### 保留第一列首页和业务导航

拒绝。与用户指定的精简 Rail 冲突，并继续混合系统入口与 Feature 入口。

### 保留第一/第二列 Splitter

拒绝。第一列内容固定且很少，调整宽度没有业务价值，会浪费空间并增加持久化状态。

### 把连接状态继续放在第二列卡片

拒绝。会话状态是跨 Feature 和聊天的全局上下文，不应随第二列内容滚动。

### 设置页使用单一滚动容器

拒绝。长表单会带走左侧导航，降低定位效率，也不符合用户明确要求。

## Verification

- 第一列截图与 DOM 中均无首页和 Feature 节点；只有 OA 与底部设置。
- 第一/第二列边界没有 `role=separator`、pointer handler 或 Rail 宽度偏好。
- 顶部会话栏的所有值来自同一后台版本化快照。
- 第二列/第三列和聊天输入区 Splitter 通过 pointer、键盘、重启恢复和保存失败测试。
- 设置左、右两列滚动位置可独立改变；`settings.main` Splitter 真实持久化。
- 删除元素只在第三列确认，完成后独立删除窗口读到新的目录 `stateVersion`。
- 未实现设置项和 Feature 不作为可点击入口出现。
