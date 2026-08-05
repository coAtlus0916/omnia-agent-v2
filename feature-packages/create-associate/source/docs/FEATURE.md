# omnia.create-associate

Version 0.2.39, sequence 41. User-workbook OOXML parsing accepts unprefixed or namespace-prefixed SpreadsheetML emitted by artifact-tool. Empty or unreadable workbooks fail at the WORKBOOK/PARSER boundary before field-revision persistence. Formula and ZIP safety contracts remain unchanged.

The V3 user APP schema contains only 系统ID, APP类型, System Risk Classification, Factors Considered, and Omnia工作区. `isDataAvailable` is not user input: new Applications use the signed false default, while existing Applications preserve the authoritative live value. Review shows exactly 11 canonical checks; AI and live checks are never reported passed unless actually executed. Missing Connector binding or an empty Workspace safety scope makes all three live checks failed with the exact missing prerequisite. Once both are available, revalidate/apply continue through the existing signed Connector Operations for APP identity/recycle, non-APP active identity, relationship and Workspace evidence. Revisions are CAS-bound and trigger a full revalidation. Removing a row persists an exclusion only, never calls a mutation Operation, and never deletes an Omnia object.

The durable Return control loop uses exact APP and generic DB/OS/Tool identity resolvers. Diagnostic reads grant no mutation permit; the second create-only preflight repeats the authoritative query for the exact object type and grants a one-time permit only for an unambiguous absent identity. Off-batch APP, multiple APP and cross-Workspace inheritance remain blocked. No target Omnia/Pack run has been performed.

见 PRODUCT/TECHNICAL/CONTRACT/TESTING/OPERATIONS/VERSION 文档。本版本不声称真实 Omnia canary 已通过。
