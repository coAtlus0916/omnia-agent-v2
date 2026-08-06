# Remote Connector 0.3.20

版本 / sequence：`0.3.20 / 23`

## 修复范围

- 仅修改受控 Omnia Session 的空闲 `refresh()` 授权恢复路径；不改 Feature、Core、安全锁、Operation、业务队列或正常回传路径。
- 刷新后仍优先接受同一 Page、同一 Engagement 的新 Authorization capture。
- 页面未自然发出新 API 请求时，不再直接删除刷新前的授权。Connector 仅使用该授权调用固定只读 hierarchy 端点，并精确核验当前 Page Engagement、hierarchy Pack ID 与 API authority origin；全部一致才恢复连接。
- 401/403 继续撤销授权；Pack、target 或 authority 漂移继续失败关闭；网络与 5xx 不得投影为已连接。
- 保留 0.3.19 的业务命令运行/排队时跳过保活刷新，避免维护操作插入回传队列。

## V4 行为依据与 V5 收紧

V4 SessionHost 按 CDP target 保存 API authorization，页面导航本身不删除，target 销毁或身份变化才失效；后台刷新失败时对已核验绑定采取延迟处理。V5 不直接复用 V4 运行时代码，只保留这一状态语义，并新增 hierarchy 的 Pack/authority 精确只读核验后才允许继续使用刷新前授权。

## 验收门槛

- 升级后即时连接同一真实 Pack。
- 空闲跨过至少两个保活周期，连接、安全锁与 Pack 身份不漂移。
- 回传期间保活刷新跳过，不插入 Operation 队列。
- 回传结束后刷新仍保持同一 Pack；401/403、target/Pack/authority 变化继续失败关闭。

源代码 build 或 portable smoke 不能替代以上真实 Omnia canary。
