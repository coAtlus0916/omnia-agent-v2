# Connector capability

本 Feature 的 `operation.ofop` 是签名绑定占位包，用于满足统一 Feature 包完整性和 Connector 注册合同。实际录制使用窄化的 `omnia.v5.recording-command/v1` gate；该 gate 只接受固定 kind 和冻结的 Connector binding，不接受任意 URL、method、headers 或 body。

0.1.1 没有改变该 Connector 合同；导航补丁不要求升级 Connector Core，也不改变 Local/Remote 语义。
