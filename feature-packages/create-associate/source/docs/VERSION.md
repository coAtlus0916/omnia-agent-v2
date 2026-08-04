# 0.2.8 / sequence 10

Authority resolution now uses the same verified `POST /engagements/v1/facets/byEngagementIds` directory as the safety lock and delete flow. The signed handler accepts only live `CustomWorkspaceGroup` (`5420131f-8ea2-4c3f-938f-a25745240cd0`) and `CustomWorkspace` (`d0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0`) Facets for the exact binding Engagement, requires every Workspace `parentId` to reference a live group, and resolves each requested Workspace name uniquely from that real Workspace set inside the frozen safety scope. Hierarchy and GRA directory reads remain mandatory; names never infer Section membership.

# 0.2.7 / sequence 9 history

Shell 0.4.12 hot-update builtin release. File selection/drag now stages a real source Artifact and recoverable `acquiring` Run without navigating or parsing. Explicit 确认上传 advances to `processing` and immediately renders a 0/11 running Validate projection; a generic declared background action starts the existing validation only after render and can never be an Omnia mutation. Upload shows only 下载模板 and 确认上传, source/Internal TemplateInstance downloads remain hidden, and step 1 detail is “上传系统信息”. Minimum Shell remains 0.4.9. Real Omnia mutation/readback canary is pending.

# 0.2.6 / sequence 8 history

# 0.2.1 history / sequence 3

Corrective source update with minimum Shell 0.4.6. It preserves the 11-check Review and atomic CAS flow, restores APP/DB/OS/Tool object and GRA Return, uses an object-type-aware create-only permit preflight, enforces relation-before-GRA for DB/OS, reads inherited RAIT from the live APP GRA, and keeps Tool relationship absent because the template has no Tool relation field. External APP, multi-APP and cross-Workspace paths remain fail closed. No real Omnia canary has been performed.

兼容性可见升级：三步工作流、签名 V3 用户模板、真实校验/回传进度、首次真实回传 bootstrap evidence、扁平导航与原位数据升级。状态仍为待首次实机验证。
# 0.2.0 history

Sequence 2 candidate. Automated evidence is distinct from the first live Return and from a subsequently verified scope. A live passed claim exists only after the restricted Core port records a complete receipt-backed Return for the exact scope.
