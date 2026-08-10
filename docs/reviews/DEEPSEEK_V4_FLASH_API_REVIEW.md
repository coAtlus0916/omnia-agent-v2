# DeepSeek V4 Flash 官方 API 差异评审

状态：设计结论已形成 / 生产代码待单独实施  
评审日期：2026-08-02  
范围：Omnia Agent v5 当前 DeepSeek 设置、模型发现、聊天调用与附件投递

## 1. 结论

Omnia Agent v5 的 OpenAI-compatible Chat Completions 主路径可以继续使用，不需要切换 SDK 或改成 Anthropic/Responses API。现有实现不是完全兼容正式版，至少需要一次独立的 AI Adapter 升级后才能把默认模型正式切换为 `deepseek-v4-flash`。

必须修改：

1. DeepSeek 新 profile、首次安装默认值和设置页默认模型由 `deepseek-chat` 改为 `deepseek-v4-flash`；旧模型名已在 2026-07-24 到达官方停用日期，不能继续作为默认值。
2. DeepSeek 模型选择必须来自真实 `GET /models`；若 `deepseek-v4-flash` 不在返回列表中，测试结果必须为失败或不可用，不能像当前实现一样显示“连接成功”后仍允许使用不存在的模型。
3. 请求必须显式声明思考模式，不能依赖供应商默认值。正式版默认开启思考且默认 effort 为 `high`，这会改变现有聊天的响应时间、输出 token 和超时行为。
4. 响应必须检查 `finish_reason`、`usage` 和最终 `content`。`finish_reason=length` 不能按完整成功保存；usage 可用时应真实记录，未知时不能填零。
5. DeepSeek V4 Flash 只开放经过官方证明的文字输入。图片可以继续作为本地聊天附件保存，但不得标记为已送入 DeepSeek。通过 UTF-8、大小和类型验证的文字文件可以转换为文字片段送入模型；现有 `text_only` 一刀切阻断所有附件的语义需要拆分。

建议修改：

- 普通第三列聊天默认使用 `thinking.disabled`，优先获得 Flash 的低延迟；需要复杂推理的 Feature 再通过能力请求显式开启，并选择 `low|high|max`。这是 v5 的产品建议，不冒充 DeepSeek 官方默认值。
- 新 DeepSeek profile 的规范 Base URL 使用 `https://provider.example.invalid`。现有 `https://provider.example.invalid/v1/` 可作为兼容输入继续接受，因为 DeepSeek 官方集成示例仍使用 `/v1/chat/completions`；不需要破坏用户已保存且验证成功的 profile。
- 当前 90 秒总超时只适合显式关闭思考的短对话。若启用思考或长输出，应采用可取消的流式响应、真实进度和独立 deadline，不应简单把全局超时无限调大。

## 2. 官方合同基线

本评审只使用 DeepSeek 官方资料：

- [Models & Pricing](https://provider-docs.example.invalid/quick_start/pricing/)：正式模型 ID、1M context、最大输出、Thinking、JSON Output、Tool Calls 和 Responses API 能力。
- [Lists Models](https://provider-docs.example.invalid/api/list-models/)：`GET /models` 返回 `deepseek-v4-flash` 与 `deepseek-v4-pro`。
- [Chat Completions API](https://provider-docs.example.invalid/api/create-chat-completion/)：`POST /chat/completions`、`thinking`、`reasoning_effort`、`response_format`、stream 与 response 字段。
- [Thinking Mode](https://provider-docs.example.invalid/guides/thinking_mode/)：默认启用、effort 映射、`reasoning_content` 和工具调用历史回传规则。
- [官方 WorkBuddy/CodeBuddy 接入示例](https://provider-docs.example.invalid/quick_start/agent_integrations/workbuddy/)：`/v1/chat/completions` 兼容 URL、Bearer 认证、模型 ID 和 `supportsImages=false`。

截至评审日的稳定事实：

| 项目 | 官方合同 |
|---|---|
| Model ID | `deepseek-v4-flash` |
| OpenAI Base URL | `https://provider.example.invalid`；官方集成示例也展示 `/v1/chat/completions` |
| 模型发现 | `GET /models` |
| 对话 | `POST /chat/completions` |
| 认证 | `Authorization: Bearer <API Key>` |
| 思考默认 | enabled / high |
| V4 Flash 原生 effort | `low|high|max`；v5 UI 不应提交 `xhigh` |
| 标准响应 | `choices[0].message.content`；思考另有 `reasoning_content` |
| 原生图像输入 | 未在本模型官方能力表中开放；按 text-only 失败关闭 |
| JSON | `response_format={"type":"json_object"}`，同时必须在提示中明确要求 JSON |
| Tool Calls | 支持；思考模式工具回合必须保留并回传 `reasoning_content` |

## 3. 与当前 v5 实现的逐项对照

| 当前实现 | 评审 | 处理 |
|---|---|---|
| 默认模型 `deepseek-chat` | 已过官方停用日期 | 必改为 `deepseek-v4-flash`，并做仅默认值迁移 |
| 默认 Base URL `https://provider.example.invalid/v1/` | 官方主文档采用根 URL，但 `/v1` 仍见于官方集成示例 | 新值使用根 URL；已保存 `/v1/` 不强制重写 |
| `GET /models` 真实发现 | 合同仍正确 | 保留；增加模型必须存在的失败关闭 |
| 模型未列出仍记 `success` | 会把不可用模型冒充成可用 | 必改为 failed/invalid |
| `POST /chat/completions` + Bearer + JSON | 合同正确 | 保留 |
| 请求未发送 `thinking` | 供应商正式版默认将开启思考 | 必须显式发送 enabled/disabled |
| 请求未发送 `max_tokens` | 小对话可运行，但缺少成本/长度边界 | 由 profile/Feature capability 给出受限值 |
| 只读取最终 `content` | 无工具调用的普通聊天可用 | 增加 finish reason、usage；思考内容不进入普通日志 |
| 历史只保存 assistant `content` | 无工具调用时符合官方多轮规则 | 未来接 Tool Calls 前必须升级历史合同 |
| DeepSeek 强制 `text_only` | 对图片失败关闭正确，但也阻断可转文字的安全文本文件 | 拆为原生模态与本地文本提取两种能力 |
| 90 秒非流式调用 | 关闭思考的短聊天可接受；思考/长输出风险高 | 按模式拆 deadline，后续增加 streaming/cancel |
| 未记录 provider usage | 与现有 AI 架构目标不一致 | 保存官方返回的 prompt/completion/cache/reasoning 可用字段 |

## 4. 推荐的设置合同

设置页仍然只保存配置，不让 Renderer 直接访问 DeepSeek：

```text
provider: deepseek
baseUrl: https://provider.example.invalid
model: deepseek-v4-flash
thinkingMode: disabled | enabled
reasoningEffort: low | high | max
maxOutputTokens: bounded integer
attachmentPolicy:
  nativeImages: false
  validatedTextExtraction: true
```

交互建议：

- Provider 选择 DeepSeek 时，模型列表来自最新成功的 `/models` 结果；初始候选可以显示官方推荐值，但必须标记“待测试”，不能在测试前显示为可用。
- “普通聊天”预设：`thinking=disabled`。
- “复杂任务”预设：`thinking=enabled, reasoning_effort=high`；`max` 只由明确选择或 Feature capability 使用。
- 设置页说明开启思考会增加等待时间和 token 消耗。
- 图片旁明确显示“已保存到本地，未发送给 DeepSeek”；验证通过的文字文件显示“已转换为文字输入”。
- API Key 仍只进入主进程并受保护保存，不回显。

## 5. 请求与响应最小合同

普通聊天建议请求：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [],
  "thinking": { "type": "disabled" },
  "max_tokens": 8192,
  "stream": false
}
```

`8192` 是 v5 的初始产品预算建议，不是 DeepSeek 上限；上线前需以真实对话长度和成本测试冻结。

复杂任务建议请求：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high",
  "max_tokens": 16384,
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

响应处理至少验证：

1. HTTP 成功且正文符合 JSON/SSE 合同；
2. `choices[0]` 存在；
3. `message.content` 为非空最终回答；
4. `finish_reason` 不是 `length`、内容过滤或未知失败状态；
5. usage 存在时按供应商字段归一化；
6. 超时、断流或解析失败时保留真实失败，不生成模拟回答；
7. Tool Calls 尚未接入前，不把模型 tool request 当作普通文本成功。

## 6. 数据与迁移

- 数据库 schema 不必因模型 ID 变化而重建。
- 只更新“默认且用户未修改”的 `deepseek-chat` 配置；用户显式保存的 Custom profile 不自动改写。
- 已到停用日期的 DeepSeek 旧模型在设置页显示“已停用，需要重新测试”，不能静默路由。
- 新设置字段若尚未迁移，调用应失败关闭或采用版本化默认；不得由 Renderer 临时补参数制造表面成功。
- 任何升级都要保留原 API Key ciphertext，不要求用户重复输入，除非真实测试返回认证失败。

## 7. 实施验收

- [ ] 新安装和新 DeepSeek profile 默认 `deepseek-v4-flash`。
- [ ] 设置保存后执行真实 `/models`，模型缺失时不能进入 ready。
- [ ] 普通聊天请求显式发送 `thinking.disabled`，不会依赖供应商默认。
- [ ] 思考模式只提交官方支持的 `low|high|max`。
- [ ] `finish_reason=length`、空 content、HTTP/JSON/SSE 错误均不记成功。
- [ ] usage 可用时真实保存，不可用时为 unknown。
- [ ] 图片只本地保存并准确标记未送模；安全文本文件可转为文字发送。
- [ ] 未启用 Tool Calls 时模型返回 tool call 不会被误判为普通回答。
- [ ] 未来启用 Tool Calls 前，历史合同能完整回传相关 `reasoning_content`。
- [ ] 旧 profile 迁移不覆盖用户自定义 Base URL、模型或 Key。

## 8. 本轮边界

本轮只完成官方合同核对和设计文档，不修改 `src/`、数据库迁移、默认配置或便携包。生产变更应作为独立实施任务，完成 adapter 测试和至少一次真实 DeepSeek API canary 后再发布。
