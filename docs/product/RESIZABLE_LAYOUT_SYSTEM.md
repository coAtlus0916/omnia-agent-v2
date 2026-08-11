# 统一可调整分区系统

状态：Shell 0.4.2 继承 0.4.1 的 `settings.main`；Connector 子菜单删除后稳定外框/splitter 语义不变
日期：2026-08-03

## 1. 用户目标

凡是一个界面中两个相邻区域承担不同、长期存在的功能，默认提供可拖动边界，用户可以调整各区域宽度或高度。主界面第一列是已确认的例外：它只容纳 OA 与底部设置，使用最小固定宽度，不允许左右拖动。

典型示例：

- 主界面第二列纯功能菜单 / 第三列 Tabbed Content Host；
- 第三列活动标签内容 / 始终保留的聊天输入区；
- 各 docked/detached Feature Surface 内部的长期功能区；
- 新建与关联的输入表 / 校验详情 / 计划与 Evidence；
- 删除元素的目录树 / 元素列表；
- 设置导航 / 设置内容；
- 录制状态 / 录制详情或 Artifact 区；
- 未来 Feature 中并列或上下分区的输入、预览、证据和结果区域。

普通列表行、卡片、表单字段、右上角消息卡和临时确认弹窗不属于“长期功能分区”，不为每个相邻元素增加拖动条。

## 2. 统一组件

所有 Shell 和 Feature 使用公共 `ResizableLayout` / `Splitter` 组件，不各自实现 pointer 计算、localStorage 或不同键盘规则。

```text
┌────────┬─────────────────────┬──────────────────────────┐
│ 固定   │ 第二列纯功能菜单      │ 第三列 Comments/Feature 标签│
│ Rail   │ 仅功能树             │                          │
└────────┴─────────────────────┴──────────────────────────┘
         普通边界              ↕ 可拖动分隔条
```

组件支持：

- 垂直 splitter：调整左右区域宽度；
- 水平 splitter：调整上下区域高度；
- 嵌套 splitter：Feature 内部可继续分区；
- pointer capture，拖出边界后仍能安全结束；
- 键盘调整；
- 双击恢复该 splitter 默认值；
- 后台持久化和多窗口同步；
- UI scale、窗口大小和最小尺寸变化时重新约束。

## 3. 交互规则

### 3.1 鼠标/触控板

- hover/focus 时明确显示可拖动状态；
- 只响应主按钮拖动；
- 拖动期间使用本地临时 preview，保证连续视觉反馈；
- pointerup/cancel 后向 Core 提交最终值；
- 保存成功后采用后台返回值；
- 保存失败时恢复上次已确认值并显示真实错误；
- 拖动不能触发相邻按钮、文本选择或危险业务 action。

### 3.2 键盘

Splitter 使用 `role="separator"`、正确 `aria-orientation`、`aria-valuemin/max/now` 和可读 label。

| 按键 | 行为 |
|---|---|
| 方向键 | 按小步长移动 |
| Shift + 方向键 | 按大步长移动 |
| Home | 移到允许的最小位置 |
| End | 移到允许的最大位置 |
| Enter 或双击 | 恢复默认值 |

具体步长按逻辑像素或比例策略统一定义，不能由 Feature 私自改变为不一致行为。

## 4. 最小/最大尺寸

每个 panel 在布局 manifest 中声明：

- 稳定 `panelId`；
- 最小 inline/block size；
- 建议默认比例；
- 是否允许显式折叠；
- 必须始终可见的关键内容；
- 小窗口下的 fallback layout。

约束：

- 拖动不能把区域缩到隐藏危险确认、错误原因或当前状态；
- “调整大小”和“折叠区域”是两个动作；没有折叠能力时不能拖到 0；
- 当窗口不足以满足所有最小值时，按已评审的响应式规则重排、覆盖或滚动，而不是任意挤压；
- UI scale 改变后重新计算最小值，但尽量保留用户比例；
- 窗口临时变小只产生运行时 clamp，不应静默覆盖用户在正常窗口下保存的偏好。

## 5. 持久化模型

布局偏好按 `profileId + surfaceId + layoutVersion` 保存：

| 字段 | 说明 |
|---|---|
| `profileId` | 当前本地用户/profile |
| `surfaceId` | 如 `shell.main`、`feature.delete-elements` |
| `layoutVersion` | 布局 schema 版本 |
| `stateVersion` | CAS/跨窗口同步 |
| `splitters` | 稳定 splitter ID 到比例的映射 |
| `updatedAt` | Core 写入时间 |

推荐存储相对比例（basis points）而不是设备物理像素；运行时再结合当前窗口、UI scale 和 panel min/max 计算实际尺寸。第一列系统 Rail 使用能够容纳 OA 与底部设置的最小固定逻辑宽度，不进入 `splitters`，也不保存 Rail 宽度偏好；实际显示宽度只随 UI scale/DPI 计算。

流程：

```text
拖动中
  → Renderer 仅做临时 preview，不写后台
释放
  → 提交 surfaceId/layoutVersion/splitterId/value/expectedStateVersion
  → Core 校验 manifest 与范围
  → Core 事务保存 LayoutPreference
  → 发布 layout_preference.updated
  → 同一 surface 的窗口采用已确认值
```

## 6. 布局 manifest

Shell 和每个 Feature 都使用同一结构声明布局：

| 字段 | 说明 |
|---|---|
| `surfaceId` | 稳定界面 ID |
| `layoutVersion` | 破坏性布局变化时提升 |
| `panels[]` | panel ID、方向最小值、默认行为 |
| `splitters[]` | splitter ID、相邻 panel、方向、默认比例 |
| `responsivePolicies[]` | 小窗口/高缩放时的受控重排 |

Feature 只能声明自己的内部 panel 和 splitter，不能修改 Shell 三列或其他 Feature 的布局偏好。

Feature 升级改变 panel/splitter 时：

- 保留仍存在且语义相同的稳定 ID；
- 新 splitter 使用新默认值；
- 已删除 splitter 的偏好不再应用；
- 破坏性结构变化提升 `layoutVersion` 并提供偏好迁移或局部重置；
- 不能因为一项未知偏好使整个 Feature 无法打开。

## 7. 与全局缩放的组合

[全局界面缩放](GLOBAL_UI_SCALE.md)和布局调整是两个独立设置：

- UI scale 决定字体、行高、图标和控件整体比例；
- LayoutPreference 决定功能区域之间的空间比例；
- 先取得 UI scale 和窗口可用空间，再将保存比例约束到当前 min/max；
- 调整 UI scale 不应删除用户布局偏好；
- reset scale 不等于 reset layout；
- 每个 scale 档位都必须测试 splitter、弹层、拖拽和滚动。

## 8. 视觉设计

- 可见分隔线保持克制，默认约 1px；
- 实际 pointer hit target 应更宽，建议 6–10px；
- hover、focus 和拖动时增强颜色或指示条；
- 分隔条不能覆盖正文或形成看似可点击但无响应的区域；
- 嵌套 splitter 通过方向和 hover 状态区分，不堆叠多重粗边框；
- 紧凑界面中仍保留足够键盘焦点可见性。

数值为设计建议，需结合目标 Windows 设备和缩放矩阵冻结。

## 9. 失败与恢复

- LayoutPreference DB 读取失败：使用发布 manifest 默认值并明确记录/提示设置未恢复；
- 保存冲突：重读新 `stateVersion`，不以旧值覆盖另一个窗口；
- Feature manifest 不兼容：只重置受影响 surface，不清空其他布局；
- 非法/越界值：Core 拒绝或按已发布 policy clamp，并返回实际值；
- 应用崩溃发生在拖动中：未提交 preview 丢弃，重启恢复上次确认值；
- 显示器/分辨率改变：重新 clamp，不写回破坏原始偏好；
- 双击 reset 也必须持久化，不能只改当前窗口。

## 10. 首批 Surface

| Surface | 初始 splitter |
|---|---|
| `shell.main.v3` | 第二列纯功能菜单/第三列 Tabbed Host 边界、活动标签内容/聊天输入区边界、功能栏折叠状态；不含 Rail 边界，也不含菜单/工作台边界 |
| `feature.delete-elements.surface` | docked/detached 共用的工作区/类型树与元素列表边界 |
| `feature.delete-chat-history` | 影响摘要与保留/删除详情之间存在并列区域时使用 |
| `feature.recording` | 状态/控制与 Artifact/完整性详情存在并列区域时使用 |
| `settings.main` | 设置导航与设置内容边界 |

Feature 详细设计若最终采用单一区域，不为了“必须有 splitter”而制造无意义分区；一旦存在两个不同功能区域，边界必须使用统一 Splitter。

Shell 0.4.1 的 `settings.main` 使用 Core SQLite 中的版本化 `SettingsLayoutPreference`，默认导航宽度 2200 basis points，合法范围 1600–3600。pointer release、方向键和 reset 都提交同一真实保存 action；高缩放或小 viewport 只做运行时 clamp，不覆盖已保存比例。设置外框使用稳定的 viewport clamp 宽高，左右列分别拥有 `overflow-y:auto`，内容多少只改变内部滚动，不改变外框。自动化已验证键盘调整到 2300、重启恢复、真实 AI 页面在 130%/小窗口下仅右区滚动且左区位置不变。

Shell 0.4.2 删除整个 Connector 设置子菜单，但不得据此缩小 Settings 外框、删除 splitter 或合并滚动容器。AI、安全锁等剩余真实页面继续共享同一 `settings.main` preference。首次配对/诊断/重新配对/解除绑定属于顶部 Connect overlay，不新建第二份 Settings splitter，也不创建假的 Connector 占位页。

主 Shell 第二列不存在 Feature Workbench，因此禁止增加“功能树/工作台”Splitter。Feature 内部布局偏好只属于自己的隔离 Surface，并在 docked/detached placement 间共用。折叠第二列时其主 Splitter 一并归零并禁用；展开后恢复后台最后确认宽度。

## 11. 验收标准

- [ ] 第一列保持最小固定宽度，第一/第二列之间没有 Splitter 或拖动命中区。
- [ ] 第二列只含功能树，不存在菜单/内嵌工作台 Splitter。
- [ ] 除固定 Rail 外，所有允许调整的相邻长期功能区域之间都有统一 Splitter。
- [ ] Shell 与 Feature 不存在私有、行为不同的拖动实现。
- [ ] 垂直、水平和嵌套布局都支持 pointer 与键盘。
- [ ] 最小/最大值阻止关键状态和危险按钮被裁切。
- [ ] 拖动期间不持续写数据库，释放后只提交最终值。
- [ ] 保存失败恢复旧值并显示错误。
- [ ] 双击/Enter 恢复默认且真实持久化。
- [ ] 同一 surface 的多个窗口通过 stateVersion 同步。
- [ ] 重启恢复最后一次成功保存的布局。
- [ ] Feature 升级只迁移/重置自己的布局，不影响其他 Feature。
- [ ] UI scale、窗口缩放和显示器变化不会损坏保存偏好。
- [ ] 非 100% UI scale 下 splitter 仍可见、可拖、可聚焦。
- [ ] 拖动不会触发上传、删除、确认或其他业务 action。
