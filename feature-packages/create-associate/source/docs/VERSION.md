# 0.2.2 / sequence 4

Shell 0.4.8 compatibility release. `返回上传` now explicitly clears Review/Progress state across the Worker → Core JSON boundary. `重新开始` is a real local-state action below the workflow rail: it cancels only an editable Run through Core CAS, preserves its artifacts/revisions/events for audit, and returns to a fresh upload state. No Omnia mutation is issued by either navigation action. Minimum Shell is 0.4.8. No real Omnia canary has been performed.

# 0.2.1 history / sequence 3

Corrective source update with minimum Shell 0.4.6. It preserves the 11-check Review and atomic CAS flow, restores APP/DB/OS/Tool object and GRA Return, uses an object-type-aware create-only permit preflight, enforces relation-before-GRA for DB/OS, reads inherited RAIT from the live APP GRA, and keeps Tool relationship absent because the template has no Tool relation field. External APP, multi-APP and cross-Workspace paths remain fail closed. No real Omnia canary has been performed.

兼容性可见升级：三步工作流、签名 V3 用户模板、真实校验/回传进度、首次真实回传 bootstrap evidence、扁平导航与原位数据升级。状态仍为待首次实机验证。
# 0.2.0 history

Sequence 2 candidate. Automated evidence is distinct from the first live Return and from a subsequently verified scope. A live passed claim exists only after the restricted Core port records a complete receipt-backed Return for the exact scope.
