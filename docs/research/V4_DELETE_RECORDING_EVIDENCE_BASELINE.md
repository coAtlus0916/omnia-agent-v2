# v4 删除与录制证据基线

状态：Evidence Inventory / v5 Re-certification Input  
日期：2026-07-30  
范围：只读分析，不授权 v5 开发、Omnia 访问或 mutation

## 1. 基线身份

本轮核对的 v4 工作树：

- 路径：`D:\Codex\Projects\工作\omnia-agent-v4`
- Git commit：`d44198a23e7a6b305e176313eca3394b18ced084`
- commit 日期：`2026-07-29`
- `package.json` 版本：`0.7.14`
- 核对时 tracked 工作树：clean

本轮只读复核还在该固定工作树上执行了当前自动化测试：

- 录制：`tests/omnia-recorder.test.js` + `tests/omnia-recording-server-contract.test.js`，`53/53` 通过；
- 删除相关：Connector concurrency/runtime、candidate、Gateway、Information deletion、Phase 1 contract 和 Agent deletion lifecycle 七个测试文件，`239/239` 通过。

测试没有连接 Omnia、没有启动录制、没有执行任何真实删除或其他 mutation。

Handoff 中的生产版本和历史录制记录是时间点证据，不等于当前生产状态。v5 只把它们作为可追溯输入，不沿用任何线上身份、命令 ID、Pack ID 或发布状态。

## 2. 删除元素可复用证据

### 2.1 产品与安全语义

v4 已反复验证并应保留的语义：

- 工作区锁和全局关系域锁；
- 服务端计划和一次性确认；
- mutation 前实时防漂移检查；
- 关系逐项解除、每次写后读回；
- blocker 归零后才删除；
- soft delete 后独立读取同一对象；
- mutation 响应不确定时禁止重放；
- 批次单项失败隔离；
- 终态后刷新真实目录；
- 右上角消息卡作为确认、进度和结果的单一交互 owner。

### 2.2 已有对象/关系证据

v4 Handoff、README、当前测试和实现已经包含以下候选语料：

| 类别 | v4 证据摘要 | v5 用途 |
|---|---|---|
| Information | Control、Application、Infrastructure、Tool 阻塞关系解除和写后复核 | 候选关系/删除合同与异常矩阵 |
| Workpaper | 精确 Work Item bulk delete 与写后删除标记 | 候选工作底稿删除合同 |
| GRA | delete validation、blocker 判定、soft delete 和精确回读 | 候选 GRA Operation |
| Application | 无关联直接删除、逐个解除 Infrastructure、滚动并发 token | 候选 APP Operation 与并发测试 |
| Database | 无关联直接删除、唯一 GRA 依赖链、写后 blocker 复核 | 候选 DB Operation 与依赖图 |
| Operating System | 显式 Omnia 类型、直接删除和唯一 GRA 分支 | 候选 OS Operation；禁止名称推断 |
| Tool | Tool→APP、Tool→Infrastructure、tab-803 bootstrap/versioned 两种状态 | 候选 Tool Operation；必须重点重新认证 |

这些证据不是“全部默认开放”的清单。正式 v5 capability matrix 由当前 v4 静态审计、证据等级和逐类最小 canary生成；没有 A/B 级证据的类型保持不可点击。

### 2.3 既有测试方式

不要求新建专用 Pack。沿用 v4 的方法：

1. synthetic fixture 和合同测试先覆盖零匹配、多匹配、未知类型、漂移、响应丢失、部分成功和写后失败；
2. 使用届时已有的非生产 Pack/Workspace 做权威轻抓取、重抓取和删除计划只读预检；
3. 按 capability 选择一个最小、唯一、可清理对象；不得复用旧对象 ID 或旧计划；
4. 执行前再次读取锁、身份、关系和并发状态；
5. mutation 只发送一次，随后独立读回；
6. 成功后刷新目录；未知时进入 `uncertain` 并只读对账。

TEST、TEST-Auto 或其他既有工作区只是可用环境。Section/Workspace 归属必须来自当前 Omnia 权威 identity，不能从名称推断。

## 3. 录制可复用证据

### 3.1 当前资产

v4 当前仓库包含：

- `connector/src/omnia-recorder.js`：真实 CDP 绑定、segment、Network/交互采集、正文队列、完整性、导出和恢复；
- `tests/omnia-recorder.test.js`：目标约束、popup/frame、敏感信息、关键正文、停止排空、完整/不完整和恢复测试；
- `tests/omnia-recording-server-contract.test.js`：Agent 录制工作流、状态、下载门禁和不完整恢复合同；
- `public/modules/omnia-recording-controller.js`：开始/暂停/停止/恢复的 UI 状态投影；
- Handoff 中多个完整与不完整真实录制及发布/回归记录。

### 3.2 代表性真实证据

Handoff 记录的代表性完整录制 `929bd0ca-0883-4d58-a3f1-d1d5fc4535b9`：

- `state=stopped`；
- `integrity.complete=true`；
- `1,833` events；
- `532` network requests；
- `0` dropped；
- 关键响应体 `4/4`、missing `0`；
- Risk、Control、Planned Response 和 Risk→Control 关系正文得到交叉核对。

Handoff 同时记录了真实不完整录制及缺失原因，证明 v4 已有“不能把部分捕获冒充完整”的门禁。普通 JSON body 未全部捕获时也会保留 omission 诊断，这一点应保留，不能把“详细录制”解释为无界抓取所有响应。

### 3.3 v5 复用方式

- 复用行为合同、状态机、完整性算法思路、测试语料和真实故障案例；
- 以 v4 已观察端点和字段生成 capture policy 候选；
- 重新落入 v5 独立 Recording Feature、签名 Operation、Artifact Store 和统一 Gate；
- 首轮离线测试不需要 Omnia 或专门 Pack；
- 首次现场验收使用届时已有的非生产 Pack 和典型页面流程；
- 现场只冻结当前再次观察到、通过源头净化和预算门禁的 allowlist。

## 4. 不能直接继承的内容

- v4 巨型 server/Gateway 分支；
- Online/Local 宿主差异业务逻辑；
- TEST、20000、IT Elements 等名称或历史排序；
- 历史 Pack、Workspace、对象、Room、Command 和 recording ID；
- 单次录制中恰好出现的数量与顺序；
- 不完整录制中缺失的请求/响应体；
- 曾被后续真实证据推翻的 Tool 并发和关系假设；
- 未经 v5 签名、sandbox、Gate、Artifact 和 Local/Remote 合同重新认证的源码。

## 5. 开发就绪结论

从业务合同材料看，删除元素和录制都不再依赖用户另行准备专用 Pack：

- 删除：v4 资料足以建立候选 capability matrix 和离线测试；实际开放前使用现有非生产环境逐类做最小 canary。
- 录制：v4 资料足以建立详细采集等价基线和大部分离线合同；实际开放前使用现有非生产页面做一次当前 allowlist/完整性/脱敏验收。

它们仍受 v5 的 D5 平台原型、Remote Bridge、sandbox、数据静态保护和官方签名包门禁约束。证据充分解决的是“从哪里开始”，不是提前宣告 Feature 已开发或已上线。
