# ADR 0036: Create-and-associate four-stage Remote return

Status: Accepted and implemented as a sequence-1 candidate. Production capability remains disabled pending real scoped canary/readback evidence.

`omnia.create-associate` separates: (1) offline workbook intake and normalization, (2) read-only Remote preflight and immutable intent compilation, (3) explicit confirmation only in the Shell Comments message card, and (4) signed mutation Operations followed by authoritative readback. The Feature Surface may prepare data and display issues, but it cannot confirm a mutation.

The 0.1.0 candidate implements all four stages: offline intake/output, signed Remote authority and preflight, one actionable Comments confirmation, command execution, trusted Operation receipts, verified-current projection, and read-only reconcile. The confirm action is still gated by exact capability/canary evidence, so this ADR and automated harness must not be read as real Omnia delivery evidence.

The user workbook is the Run source. V8 is imported once as signed managed governance and is never a runtime input, output, or default workbook. A signed runtime-template base XLSX is a separate immutable asset; each Run produces a new TemplateInstance by patching only declared OOXML parts.

Every mutation permit binds Operation package digest, Connector binding/session generation, engagement, exact Workspace scope, target identity, plan digest, and the intended mutation Operation ID. POST and PATCH response loss after a commit step are `uncertain`; they are never replayed. Recovery uses a separately signed read-only reconcile Operation.

Production return requires persistent capability evidence for the exact authority instance, tenant/organization, Pack contract, engagement, Workspace, scenario, capability, Feature version, and Operation package digest. Automated fixtures do not satisfy that gate.
