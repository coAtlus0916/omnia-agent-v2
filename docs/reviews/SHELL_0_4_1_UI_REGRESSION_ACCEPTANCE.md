# Shell 0.4.1 UI 回归验收

状态日期：2026-08-03  
范围：Shell `0.4.1`、`omnia.recording@0.1.1 / sequence 2`、后装 `omnia.delete-elements@0.1.2`  
结论：代码与自动化回归已通过；Windows 便携产物和升级保持见下方证据；真实 Omnia 未实机验证/待 canary。

## 1. 六项回归与修复映射

| 回归 | 根因 | 0.4.1 修复 |
|---|---|---|
| Comments composer 被遮挡 | composer 一直存在，但 docked `WebContentsView` 是 shell DOM 之上的原生 child view；React 切换 Comments 未通知 Main | Renderer 声明 active/overlay，Main 唯一调和 attachment；Comments 时附着集合为 0，真实 textarea/附件/发送链路保持一套 |
| 收起菜单后只露出部分输入框/Feature bounds 漂移 | 原生 view 保留旧 bounds，CSS 无法裁切或覆盖它 | 折叠/展开立即重测活动 host，Main 只更新当前 attached view；Comments 全程无 native attachment |
| Settings 被 Feature 覆盖 | 打开 overlay 只改变 React state，原生 view 仍附着 | 打开 Settings 前同步声明 overlay，Main detach 全部 docked view；关闭后恢复正确活动标签并重算 bounds |
| 多 Feature/多标签潜在叠层 | placement 与 visible/attached 混在一起，没有“最多一个 attached”合同 | placement、Run/Worker、当前 visibility 分离；任意时刻最多一个 attached docked view，崩溃/关闭清理幂等，隐藏不终止 Run |
| 全局缩放只改变标签 | Core preference 真实存在，但大量固定 px 和 Feature 独立 WebContents 未消费 CSS token | Main 对 Shell、当前/新建 docked、detached 统一 `setZoomFactor`，load 后复写；CSS token 中和为 1；bounds 只转换一次，重启恢复 |
| Feature 导航/设置/发布回归 | recording 包硬编码 `Feature → 录制`；delete 只缺安装；Settings 外框受内容影响且 splitter 未落 Core；继续使用 0.4.0 会覆盖版本语义 | 新签名 recording 0.1.1 改为 `other/其他 → 录制`，与独立 delete 0.1.2 合并；稳定 Settings frame、独立滚动和 `settings.main` 持久化 splitter；发布新 Shell 0.4.1 |

## 2. 四 Plane 边界

- Renderer/Surface：仅处理标签、Comments 输入/附件/发送、Settings 表单、布局测量和 visibility intent；不拥有 native child view，不硬编码 Feature 业务。
- Feature Worker：录制和删除各自包内编排真实状态/action；隐藏/关闭 UI 不等于停止 Run。
- Core：SQLite 保存 zoom、Shell/Settings layout、Feature Registry/activation head、chat 和 Feature Store；package manager 合并相同 group id 并保持显式 rollback。
- Connector：仅负责 Transport、Session、Gate 和签名 Operation host；本次未把录制/删除流程塞入 Connector Core，未执行真实 Omnia mutation canary。

## 3. 自动化测试证据

核心 UI 命令：

```text
npm run build
npm run acceptance:ui-regression
```

结果：通过。`acceptance/shell-0.4.1-ui-regression/automation-report.json` 证明：

- Comments/Settings 时 attached docked count 为 0；Feature 活动时上限为 1；菜单折叠后 host bounds 变化并对齐。
- real chat message 已写入 Core；textarea、附件、发送入口几何都在 content host 内。
- Settings 三条入口路径及所有真实子页外框误差不超过 1px；130%/小 viewport 下右区真实滚动、左区不动；splitter 2300 bp 重启恢复。
- 100/105/115% 的 real DPR/viewport/Settings physical geometry 变化；快捷键 110→115→100 同时改变 Core、DPR 和 manager factor；按钮恢复 115%。
- detached 删除元素窗口完成真实 surface bootstrap，继承 115%，关闭后 detached state 与 sender authorization 均清除；重启后新建 recording docked view 继承 115%。

其余最终命令与结果：

```text
npm run package:recording-feature
npm run package:delete-feature
npm run package:windows
npm run acceptance:upgrade-0.4.1
npm run acceptance:portable-0.4.1
npm run check
git diff --check
```

最终结果：`npm run check` 通过，Node test 共 66 项（65 passed、1 个既有 Windows wrapper rejection case skipped、0 failed），independence 另 1/1 passed；lint 覆盖 48 个 source files，typecheck/build 均通过。两个 Feature package 命令完成 digest、官方签名 envelope 与测试验签。`git diff --check` exit 0；但本仓库没有任何 Git commit，全部文件显示 untracked，因此该结果只能说明 Git 未发现可比较 diff 中的空白错误，不能证明相对历史基线。

## 4. 包、版本和不可变性

- 新包：`feature-packages/recording/candidates/recording-0.1.1.ofp`；manifest version 0.1.1、sequence 2、导航 `other/其他 → 录制`。
- recording 0.1.1 文件 SHA-256：`2c269adba581b9664fcc21002e06d19e528672bb6fec3f5c6992113774adf91e`；delete-elements 0.1.2 不可变文件 SHA-256：`4848cc51eddf0ddf4d45bbcaa95aa1376492ba270e65da1f260046d0b1496a0a`。
- 保留不变：recording 0.1.0、delete-elements 0.1.2、Shell 0.4.0 目录/产物。0.1.1 首次升级后，用户显式 rollback 到 0.1.0，后续 builtin bootstrap 检测为 `preserved-rollback`，不强制重激活。
- Shell 新版本：0.4.1。发布 data root 与 release/update 目录隔离；delete 0.1.2 不被塞入干净 Shell builtin。

## 5. Windows 便携与升级证据

- UI Electron acceptance：`acceptance/shell-0.4.1-ui-regression/`，含 automation report 和 100/105/115%、Comments 展开/折叠、唯一“其他”分组、Settings 全部真实子页、独立滚动、docked/detached Feature 截图。`feature-docked-115-percent.png` 不是 Playwright renderer 截图：它在 manager 已证明活动 docked view 附着后，由 Electron Main 用 Shell `BrowserWindow.getMediaSourceId()` 精确匹配 `desktopCapturer` window source，捕获 Windows 实际合成窗口，因此包含原生 `WebContentsView`；脚本同时断言 source id/title、PNG 文件头、尺寸和非空字节数，未使用 mock、拼图或后处理。
- 0.4.0→0.4.1 保持：`acceptance/shell-0.4.1-upgrade/upgrade-preservation-report.json`。验证 recording 0.1.0 升级到 0.1.1、delete 0.1.2 保持、删除 runtime 仍为真实连接阻断状态、installed package/activation store/user data tree digest 未被 release 替换。
- 干净便携：`acceptance/shell-0.4.1-portable/portable-smoke-report.json`。验证打包 exe 0.4.1 在独立 clean data root 启动、只自动装 recording 0.1.1、不伪造 delete 入口、data 位于 release 外。
- 发布候选：`releases/0.4.1/` 与 `artifacts/omnia-agent-v5-portable-0.4.1.zip`，zip SHA-256 `2d8a3f9e03ebccf1a3e77ab027dc781006e9b839061e1f63ce5fde2f1901c0b7`。release manifest 对 app/builtin inventory 逐项记录 SHA-256；Windows 组织代码签名仍标记 `organization_code_signing_required_before_distribution`，不能把本地 candidate 冒充组织签名正式分发。

## 6. 证据分级与剩余风险

1. 自动化：Node/TypeScript 合同、Feature 安装升级回滚、Electron native attachment、实际 zoom geometry、多标签和 Settings layout。
2. Windows 便携冒烟：实际打包 exe、干净外置 data、0.4.0→0.4.1 保持与截图；不等于连接真实 Pack。
3. 真实 Omnia canary：**未实机验证/待 canary**。Nova 专有协议、目标公司 Pack 权限/层级、真实录制及删除 mutation、目标设备系统 DPI/杀软组合仍不得标记通过。

剩余风险主要是授权环境差异、真实 Pack hierarchy/endpoint、Remote Bridge/Connector 现场能力及多显示器 Windows DPI 切换；当前失败路径保持明确阻断，不使用 mock/sample/hardcoded 结果。
