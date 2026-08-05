# 0.2.16 / sequence 18

Corrective release applying the authoritative Work Item Facet Mapping to APP identity resolution and its action-time create preflight. An active Application is compatible only when its detail supplies one non-zero Work Item GUID whose unique mapping equals the frozen Workspace; the resolved object identity now carries that exact Work Item ID.

# 0.2.15 / sequence 17 history

Corrective release replacing the invalid IT Element detail `workspaceId` read-back with the authoritative Work Item Facet Mapping used by deletion. Object and Application-settings reads require one non-zero Work Item GUID and exactly one mapping to the frozen Workspace; detail identity, type, subtype, external identity, and Application description remain strict.

# 0.2.14 / sequence 16 history

Corrective release aligning Return preparation with the shared Connector binding protocol: `tenantOrOrgId` remains an exact frozen string and participates in scope equality/digests, but may be empty. Non-empty authority instance, Pack, and Engagement identities remain mandatory.

# 0.2.13 / sequence 15 history

Corrective release aligning Review live validation with the signed non-APP object preflight exact schema. DB, OS, and Tool queries now carry the same governed `subtypeId` already used by Return preparation.

# 0.2.12 / sequence 14 history

Immutable successor to 0.2.11 after package-manager startup rejected a literal `+` in the signed route template. The Standardized Accounts List and null release-date query values are now declared string parameters; the Operation handler supplies the frozen values and Operation Host performs the required percent encoding.

# 0.2.11 / sequence 13 history

Corrective release replacing the non-authoritative created-GRA `commonAccounts` lookup in `authority.resolve` with the live `Standardized Accounts List` reference-list publication. Each request and resolved identity carries `elementKind` and object subtype; APP/DB/OS/TOOL select their own exact live category child, so DB and OS cannot cross-resolve through the shared Infrastructure protocol type. Content IDs and IT Element type IDs come only from the live directory; GRA protocol type IDs are Application 3, Infrastructure 4, and ITTool 5. Governance aliases cover Generic, SAP ECC, SQL, UNIX, WIN, Ticketing Tool, and Identity & Access Management Tool values.

# 0.2.10 / sequence 12 history

Source release correcting Omnia/Core GUID validation in the Worker and signed Operation handler. Canonical non-zero 8-4-4-4-12 hexadecimal identities are accepted regardless of RFC UUID version or variant bits; input trimming and lowercase normalization remain in force. This source version has not been packaged, installed, or canary-tested.

# 0.2.9 / sequence 11 history

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
