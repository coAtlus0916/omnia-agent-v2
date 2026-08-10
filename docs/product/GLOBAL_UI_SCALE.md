# 全局界面缩放控制

状态：Shell 0.4.2 继承 0.4.1 实现；Remote-only Connect/repair surface 纳入同一 zoom，真实公司电脑 Omnia canary 待执行
日期：2026-08-03

## 1. 用户目标

所有 Omnia Agent v5 主界面和独立工具窗口的右上角提供统一缩放控制：

```text
[ − ] [ 100% ] [ + ]
```

用户可随时缩小或放大界面，以适应不同显示器、Windows 缩放、视力和信息密度偏好。这里调整的是 Agent UI 的字体、行高、图标、间距和控件视觉比例，不改变 Windows 窗口的最小化、最大化或物理尺寸。

## 2. 适用范围

必须出现缩放控制的一级界面：

- 三列主界面；
- 设置；
- 新建与关联；
- 删除元素；
- 删除聊天记录；
- 录制；
- 安全锁、诊断和未来 Feature 的独立工作台；
- 由主应用打开的独立工具窗口。

弹窗、确认卡、右上角 Agent 消息卡和内嵌子面板继承当前全局缩放值，不各自再放一套 `−/+`，避免控件泛滥。

Artifact 正文、生成的 PDF/Word/Excel 和 Omnia 页面本身不因 Agent UI 缩放而改变。文档预览如需放大，应使用独立的内容缩放合同，不能修改交付文件。

## 3. 统一交互

| 控件 | 行为 |
|---|---|
| `−` | 降低一个缩放档位；到最小值时禁用 |
| 百分比 | 显示后台已确认的当前值；点击恢复 100% |
| `+` | 提高一个缩放档位；到最大值时禁用 |
| `Ctrl+-` | 与 `−` 使用同一 action |
| `Ctrl++` | 与 `+` 使用同一 action |
| `Ctrl+0` | 与点击百分比使用同一 reset action |

按钮必须有明确 `aria-label`、键盘焦点、禁用状态和 tooltip。百分比不能只用图标或颜色表达。

## 4. 缩放范围

建议原型范围：

- 默认：100%；
- 最小：80%；
- 最大：130%；
- 步长：5%。

这些数值为 `Proposed`，需在目标 Windows 设备、100%/125%/150%/200% 系统缩放和常见分辨率上验证后冻结。100% 对应 v5 的紧凑基线，而不是沿用 v4 偏大的字号。

系统必须保证：

- 缩小后正文仍可读，危险操作按钮仍可辨认；
- 放大后导航、表格、确认内容允许滚动，不裁掉关键按钮；
- 点击目标不因视觉缩放降到不可访问尺寸；
- 布局在临界宽度时重排或滚动，不使用遮挡和溢出隐藏关键数据；
- Windows 系统缩放与应用缩放组合后仍可用。

## 5. 唯一事实与持久化

缩放不是每个 React 页面自己的 local state。`UserPreferenceService` 是唯一 owner，在 Core DB 中保存：

| 字段 | 说明 |
|---|---|
| `profileId` | 当前本地用户/profile |
| `uiScalePercent` | 已确认缩放值 |
| `stateVersion` | 防并发覆盖 |
| `updatedAt` | Core 写入时间 |
| `source` | `user|reset|migration|default` |

流程：

```text
用户点击 − / + / 100%
  → Shell 提交带 expectedStateVersion 的设置 action
  → Core 校验范围并事务保存
  → Core 返回新的 UserViewPreference
  → 所有已打开窗口收到 preference.updated
  → 各窗口应用同一个已确认值
```

保存失败时保持原缩放值并显示真实错误，不得仅修改当前 DOM 后假装已经保存。下次启动必须使用上次成功持久化的值；首次启动使用 100%。

## 6. 多窗口一致性

- 每个窗口启动时先读取同一 UserViewPreference，再完成正式界面绘制；
- 一个窗口修改后，主窗口、Feature 工作台和其他独立窗口立即同步；
- 事件丢失或窗口休眠后，在重新可见时比较 `stateVersion` 并重读；
- 不能让主窗口为 90%、删除窗口为 110% 而没有明确的“按窗口缩放”产品能力；
- Remote Connector 不保存或同步 UI 缩放，Bridge 也不参与。

## 7. 技术边界

Shell 0.4.1 采用 Main 统一调用 Electron `webContents.setZoomFactor`。Core 的 `uiScalePercent` 仍是唯一事实；Main 把已确认值应用到 Shell、Settings overlay、当前和新建的 docked `WebContentsView`、detached `BrowserWindow`，并在 `loadFile` 后再次应用，以覆盖 Chromium partition 可能恢复的旧 origin zoom。Renderer 根级 `--ui-scale` 固定为 `1`，不再叠加 CSS 倍率，避免双重缩放。

docked host 的 Renderer 测量值是 CSS pixel，`contentView` bounds 是宿主 DIP；Main 只做一次 `CSS px × zoomFactor` 转换，并在缩放、菜单折叠和 splitter 变化后重新调和活动视图 bounds。隐藏视图也保留相同 zoom preference；重新附着或新建时继承当前值。

无论技术实现如何：

- Renderer 不直接写数据库；
- Feature 包不能覆盖全局缩放值；
- 不逐页硬编码不同字号倍率；
- fixed/portal/overlay/独立窗口必须使用同一缩放语义；
- 屏幕坐标、拖拽、弹层定位和截图测试必须在非 100% 下验证；
- 缩放不能改变业务数据、模板渲染尺寸或 Connector 命令。

功能区域比例由独立的 [统一可调整分区系统](RESIZABLE_LAYOUT_SYSTEM.md)管理。改变 UI scale 时重新计算 panel 最小值和实际尺寸，但不删除或覆盖用户保存的 LayoutPreference。

## 8. 与紧凑设计的关系

全局缩放不能代替合理的默认设计。v5 在 100% 下仍应采用：

- 正文 12–13px；
- 次要文字 10–11px；
- 树行 24–28px；
- 紧凑表格、较小圆角和克制的卡片；
- 清晰但不夸张的层级。

`−` 是用户偏好，不是修复默认字体过大的唯一手段。

## 9. 验收标准

- [ ] 每个一级界面右上角都有同一个 `− 百分比 +` 组件。
- [ ] 弹窗和消息卡继承缩放，不重复放置控制。
- [ ] 所有控制调用真实 UserPreference action，不直接写 localStorage 冒充后台设置。
- [ ] 修改后所有已打开窗口同步到同一 `stateVersion`。
- [ ] 重启后恢复最后一次成功保存的值。
- [ ] 保存失败时回到真实旧值并显示错误。
- [ ] 最小/最大值正确禁用，百分比可重置 100%。
- [ ] `Ctrl+-/Ctrl++/Ctrl+0` 与按钮走同一 action。
- [ ] Windows 常用系统缩放与应用各档位组合通过布局、键盘和可访问性测试。
- [ ] 删除元素的选择、右上角确认卡和自动刷新在每个档位下正常。
- [ ] 新建与关联的输入表、验证、计划、确认和 partial/uncertain 结果在每个档位下正常。
- [ ] 录制悬浮控制、设置、长错误信息和 `uncertain` 警告不会被裁切。
- [ ] Artifact/模板/导出文件的内容尺寸不受 UI 缩放影响。

## 10. Shell 0.4.1 自动化证据

`scripts/ui-regression-acceptance-v5.mjs` 已验证 100%、105%、115% 的真实 `devicePixelRatio`、Shell viewport、Settings 实际几何、manager zoomFactor 和 docked host bounds，而不是只读取百分比文字。键盘 `Ctrl+- / Ctrl++ / Ctrl+0` 分别验证 110%/115%/100% 的 DPR 与 manager 值，并由按钮恢复 115%。detached Feature、新建 docked Feature 和重启恢复均继承 115%，CSS token 保持 `1`，证明没有重复倍率。Windows 系统缩放组合与真实 Omnia 操作仍待 canary。

## 11. Shell 0.4.2 Remote-only 回归

0.4.2 不改变 `UserViewPreference` owner 或 Electron zoom 技术。删除 Connector Settings 后，顶部 Connect 的首次链接码引导、诊断、重新配对确认和解除绑定确认属于 Shell overlay，必须继承当前 zoom；打开这些 overlay 时仍由 `SurfaceWindowManager` detach 全部 docked native view。Remote Connector/Bridge 自身不保存 Shell UI scale。

0.4.2 最终验收必须重新测量 100%、105%、115% 下 Shell/Comments/Settings/Connect overlay/docked/detached 的真实几何和 DPR，并验证重启持久化与无 CSS 双倍率。公司电脑真实 Pack canary 与 UI zoom 自动化是两类证据，均不能互相替代。
