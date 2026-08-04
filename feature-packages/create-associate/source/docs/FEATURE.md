# omnia.create-associate

Version 0.2.2, sequence 4. The Feature exposes exactly three user steps: 上传资料、校验、回传. The signed package carries the exact `Phase1-用户填写模板V3.xlsx`; Main verifies its member digest before Save As. Picker and drag/drop use one managed-artifact import chain. APP/DB/OS/Tool sections are independently optional; every non-empty row still receives its own required/enum/duplicate/relation validation. 返回上传 explicitly removes the persisted Review layer while retaining the current Run; 重新开始 cancels the editable Run through Core and starts the next upload from a clean Surface without deleting audit history.

The V3 user APP schema contains only 系统ID, APP类型, System Risk Classification, Factors Considered, and Omnia工作区. `isDataAvailable` is not user input: new Applications use the signed false default, while existing Applications preserve the authoritative live value. Review shows exactly 11 canonical checks; AI and live checks are never reported passed unless actually executed. Revisions are CAS-bound and trigger a full revalidation. Removing a row persists an exclusion only, never calls a mutation Operation, and never deletes an Omnia object.

The durable Return control loop uses exact APP and generic DB/OS/Tool identity resolvers. Diagnostic reads grant no mutation permit; the second create-only preflight repeats the authoritative query for the exact object type and grants a one-time permit only for an unambiguous absent identity. Off-batch APP, multiple APP and cross-Workspace inheritance remain blocked. No target Omnia/Pack run has been performed.

见 PRODUCT/TECHNICAL/CONTRACT/TESTING/OPERATIONS/VERSION 文档。本版本不声称真实 Omnia canary 已通过。
