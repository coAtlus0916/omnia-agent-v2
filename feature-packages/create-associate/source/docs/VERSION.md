# 0.2.9 / sequence 11

Immutable successor to the already activated 0.2.8 digest. Unrelated Facets in the Engagement directory are now ignored after object-shape and Engagement validation; strict GUID, uniqueness, name, safety-scope and live-parent checks apply only to the recorded CustomWorkspaceGroup and CustomWorkspace Facet types.

# 0.2.8 / sequence 10 history

Authority resolution moved to the verified `POST /engagements/v1/facets/byEngagementIds` directory used by the safety lock and delete flow. Its activated digest is immutable and is superseded by 0.2.9 because it could reject unrelated Facets before filtering to the two Workspace Facet types.

# 0.2.7 / sequence 9 history

Shell 0.4.12 hot-update builtin release. File selection/drag now stages a real source Artifact and recoverable `acquiring` Run without navigating or parsing. Explicit 确认上传 advances to `processing` and immediately renders a 0/11 running Validate projection; a generic declared background action starts the existing validation only after render and can never be an Omnia mutation. Upload shows only 下载模板 and 确认上传, source/Internal TemplateInstance downloads remain hidden, and step 1 detail is “上传系统信息”. Minimum Shell remains 0.4.9. Real Omnia mutation/readback canary is pending.

# 0.2.6 / sequence 8 history

# 0.2.1 history / sequence 3

Corrective source update with minimum Shell 0.4.6. It preserves the 11-check Review and atomic CAS flow, restores APP/DB/OS/Tool object and GRA Return, uses an object-type-aware create-only permit preflight, enforces relation-before-GRA for DB/OS, reads inherited RAIT from the live APP GRA, and keeps Tool relationship absent because the template has no Tool relation field. External APP, multi-APP and cross-Workspace paths remain fail closed. No real Omnia canary has been performed.

兼容性可见升级：三步工作流、签名 V3 用户模板、真实校验/回传进度、首次真实回传 bootstrap evidence、扁平导航与原位数据升级。状态仍为待首次实机验证。
# 0.2.0 history

Sequence 2 candidate. Automated evidence is distinct from the first live Return and from a subsequently verified scope. A live passed claim exists only after the restricted Core port records a complete receipt-backed Return for the exact scope.
