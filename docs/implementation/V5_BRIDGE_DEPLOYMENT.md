# v5 Bridge 与 Remote Connector 部署合同

当前目标：Bridge `0.4.4`、Remote Connector `0.3.7 / sequence 10`、协议 `omnia.v5.remote-connector/v2`。v5 为 Remote-only；Shell 不打包或启动 Local Connector，也不允许 fallback。Bridge 0.4.4 沿用 capability health，并把配对码收紧为由密码学随机数产生的 4 位数字码，仅保存 hash，有效期 2 分钟且只能消费一次。`POST /v1/pair` 按来源 IP + Connector 身份和全局失败预算限速，达到阈值后统一返回 `429`。

## 强制部署顺序与依赖门禁

生产依赖必须严格按以下顺序推进，不能把 Shell 或 stable manifest 提前：

1. 部署 Bridge，并确认公开 `GET /v1/health` 返回 Bridge version、build identity、protocol、startedAt，以及 `omnia.v5.bridge-pairing-session/v1` 的 `pairingSessions.create=true` capability。
   部署脚本必须在容器启动前把持久化 volume 初始化为运行用户 `1000:1000`；仅有 health 绿色不能证明 pairing 状态可写。
2. 使用该公开 health 通过 `npm run verify:bridge-pairing-target`，再执行一次真实 pairing canary；canary 未通过时不得开放 Shell 配对入口。
   pairing canary 必须至少真实创建并取消一条 session，确认 `bindings.json` 可创建和持久化；不得只检查 capability 字段。
3. 将已签名 Remote Connector ZIP 发布到其不可变版本 URL；先用签名 stable 候选验证目标 ZIP 的真实 bytes、size 和 SHA-256。
4. 只有第 3 步通过后才原子切换 Remote Connector stable manifest。正式部署脚本必须先 `stage` ZIP，再运行目标 ZIP preflight，最后 `activate` stable；任何检查失败均保留旧 stable。
5. 最后交付/开放依赖该 pairing contract 的 Shell。Shell 在 Bridge capability 尚未部署、协议不匹配或 health 不可达时必须禁用“生成一次性链接码”，并在任何 durable reservation 和 pairing POST 前失败关闭。

这里的 health、ZIP 和 canary 都是目标环境事实，不能用本地产物存在或前端版本判断代替。网络失败不触发 Local fallback。上述步骤不授权自动部署；生产 Bridge、Connector、stable 与 Shell 切换仍需用户另行批准。

配对 session 的读取、显式提交与取消均绑定同一 poll proof：`GET /v1/pairing/sessions/:id`、`POST /v1/pairing/sessions/:id/commit`、`DELETE /v1/pairing/sessions/:id`。Connector WSS open 只形成 ready，不激活。取消 waiting/ready candidate 会使 code 不可重放并撤销 candidate；commit 已先赢则返回 matched，由 Shell 完成 staged binding promote 或执行可恢复 cleanup。网络失败、损坏密文或本地 code 到期都不能直接丢 pending proof/生命周期 gate。

生产部署沿用独立 v5 host/path/root，不复用或修改 v4 endpoint、Room/token/state、更新通道、服务或数据。历史 Bridge `0.4.0`、`0.4.1` 与 Remote Connector `0.3.4 / sequence 7`、`0.3.5 / sequence 8`、`0.3.6 / sequence 9` 产物和发布记录保持不可变。

## 正常首次路径

1. 用户在 Shell 顶部第一次点击 Connect。
2. Shell 先取得进程内 lifecycle mutex，并调用公开、只读的 Bridge capability health；该预检不创建或改变远端 pairing session，因此不写 reservation。只有 health 明确支持当前 pairing contract 后，Shell 才占 durable `creating` reservation；从此刻起，任何会创建或改变远端 pairing session 状态的请求都必须在该 reservation 之后。随后 Shell 向 Bridge 创建最长十分钟的 pairing session；Bridge 返回密码学安全、单次、session/product/protocol/角色绑定的链接码，以及只交给 Shell Main 的 polling proof。
3. Shell 在 Connect 引导中展示链接码；用户在公司电脑最终 Remote Connector 输入。正常产品路径不使用 Settings、waiting discovery、设备列表或唯一候选自动认领。
4. Remote Connector 提交自己的受保护 device identity、版本、平台和协议并消费链接码；Bridge 建立 candidate binding。
5. Connector WSS 鉴权成功只把 candidate 标为 ready。Shell 通过 pairing proof 读取 ready candidate，把 Shell token、pair/generation 和 Connector identity 用实例密钥持久 stage 为 `commit_required`，此时 previous 仍 active。
6. Shell 用同一 proof 调用 commit。Bridge 当下再次验证 candidate socket OPEN/fresh 以及 pair/generation/device/protocol/version；全部一致才 CAS 激活并撤销 previous，否则返回 `409` 且 old 保持 active。Bridge 向 Connector 发 `binding_committed` 后，Worker 才把 DPAPI candidate credential 提升为 active；Shell 再原子 promote staged credential 并清 pending。
7. 同一 Connect 流程发起浏览器连接并等待真实 Pack。后续普通启动、Shell/Connector/Bridge 重启和网络恢复不再要求链接码。

链接码、polling proof、token、DPAPI/safeStorage 密文不写日志、不进入 Renderer snapshot、Evidence 正文或诊断包。匿名调用者不能查询 waiting Connector、公司电脑名称或完整 Connector ID。

十分钟 code 窗口只限制消费；ready candidate 使用独立且不因重连延长的 recovery TTL。Shell/Bridge/Connector 重启、stage 后崩溃、commit 响应丢失以及 commit 后 promote 前崩溃，都先 poll 权威状态：candidate 才重试 commit，matched 直接 promote，expired 保持失败关闭并要求 reconcile。损坏的 revocation pending 优先从同 pair 当前 binding credential 恢复；两份均损坏则保留无限期 `manual_revoke_required` tombstone，不能删除 pending 来恢复 transport。

## 重新配对与解除绑定

- Connect 错误/详情提供诊断、重新配对和解除绑定；Settings 不含 Connector 子菜单。
- 重新配对需要用户确认，建立替换 candidate；失败保留旧 active，成功才用更高 generation 激活并撤销 previous。
- 解除绑定撤销 Bridge binding 和双端 credential，不删除聊天、Feature、Evidence、附件、文档或其他用户数据。
- revoked/credential 不可恢复进入 `repair_required`；不得无限重试或 fallback Local。

## WebSocket、heartbeat 与状态

- Shell/Connector WebSocket 均有 ping/pong heartbeat，超过 freshness deadline 的 stale socket 被关闭并从在线集合移除。
- `onlineConnectors` 只统计 active generation、新鲜且协议兼容的 Connector。
- Bridge 向 Shell 发送 `state` envelope；`connectorOnline=false` 立即投影离线。Shell WSS online 不等于 Connector online。
- 双端重连使用有界 exponential backoff + jitter。
- 网络恢复后旧 Pack identity 先失效，再读取 Remote Session/hierarchy；不能因 token 或旧 snapshot 显示 connected。
- Bridge health 只返回 `version/build identity/protocol/startedAt`、pairing capability 与在线计数等非敏感字段；旧 health shape 必须解释为 `REMOTE.BRIDGE_UPGRADE_REQUIRED`，不得试探不存在的 pairing POST 路由。

## 命令与更新可靠性

- request owner 绑定 `pairId + generation + requestId + deadline`；同 ID 在途不重复分发，断线按 effect/提交点返回失败或 uncertain。
- 仅健康/status 可有界并发；connect/refresh/workspace/recording/Operation 使用受控 lane。
- Remote Worker 的 `WorkstationOmniaSession` 持有受控 Edge/CDP/Authorization/Pack identity 与签名 OperationHost；Shell 不访问这些能力。
- Supervisor 只从 v5 stable 下载，验证 product/key/signature/hash/size/sequence/minimum Supervisor；active/uncertain operation 阻断激活，candidate/probation 失败恢复 previous。

## 生产状态与 canary

Bridge `0.4.4` 不可变候选已生成在 `bridge/releases/0.4.4/`；Bridge 0.4.3 及更早产物保持不可变。Remote Connector `0.3.7 / sequence 10` 已有官方 Ed25519 签名不可变候选，不得重打。本轮配对自动化已通过；便携升级、部署和真实配对 canary 待完成。

公司电脑真实 Pack canary：**未通过/待 canary**。在最终包上完成真实链接码、受控 Edge 登录、自动 Pack identity、`status/refresh/workspace_light_read`、四类重启/断网恢复和解除绑定/新 generation 前，不得声称 Remote 真实 Pack 已交付。
