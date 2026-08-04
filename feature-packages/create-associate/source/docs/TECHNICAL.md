# 技术实现

- Delivery：原生文件选择、问题修订、受权下载。
- Execution：独立 Worker 解析用户 `.xlsx`，从签名包内 V8 编译合同生成运行实例。
- Control/Data：Run/Artifact/Template/field provenance/issue/intent/command/evidence/revision 结构化持久化。
- Integration：Remote-only 签名 Operation，首次远程 action 才延迟注册。
# Technical design

## 0.2.0 durable workflow and provenance notes

- Surface workflow/progress/issues are Worker projections from durable Run/Event/Command/Evidence revision; Renderer does not time or poll progress.
- The source V3 template is a signed `source_template` managed asset. Main resolves only the installed immutable member and rechecks its digest before Save As.
- Picker and drop supply different trusted source refs but enter the same bounded bytes/name/extension/digest/Run/artifact transaction.

- APP `isRelevant=false` is not a Worker constant: it is `rule_default` from signed rule `v8.app-is-relevant-false.v1`, bound to V8 `字段母版` row 9 / `SRC.IT元素.011` and the exact managed V8 digest.
- Save/revalidate compiles a new TemplateInstance, then one Core transaction commits the user revision, every required signed derived revision, provenance, new instance junctions, issues, Run state and Event. Element-ID edits are rejected unless GRA name and APP description (when applicable) advance in that transaction. Old instance junctions keep old revisions.
- `isDataAvailable` is internal governance state, not a V3 user column. New APP rows receive the signed `rule_default=false` with provenance; an existing APP preserves its authoritative current boolean during preview and execution.

## 0.2.1 corrective Review

Local checks are recomputed from active rows while parser-origin structural/unmapped blockers are preserved. Generated issues use explicit producer/code provenance and Run-scoped deterministic IDs. DB/OS requires exactly one in-batch, same-Workspace APP edge. Off-batch APP remains blocking. APP/DB/OS/Tool absent identities enter object-type-aware create-only preflight; recycle-bin and ambiguous identities fail closed. Removing a row performs no Connector call and marks relationship validation pending until explicit revalidation.

Live Review and prepare-return call the signed APP resolver or the generic DB/OS/Tool resolver. The resolver grants no mutation permit. A separate object-type-aware create-only preflight repeats the bounded proof immediately before creation. DB/OS uses the recorded Infrastructure subtype (`Database` or `OperatingSystem`), writes and verifies InfrastructureApplication in both directions before GRA creation, then derives RAIT from an authoritative read of the unique APP GRA. Tool uses the recorded `ITTool` + `typeId=Tool` contract and has no fabricated relation. Uncertain reconciliation remains read-only and never replays a mutation.

## 0.2.3 navigation, reset, and authority correctness

Surface field removal uses the Shell 0.4.9 generic `clearFields` contract because JSON serialization cannot preserve `undefined`. `back-to-upload` keeps the current editable Run and clears stale Review/Progress fields. `restart-run` is declared with the generic `restart` presentation, transitions only `needs_input|ready_for_review` to `cancelled` through the Core store, records `run.restart_requested`, preserves all audit data, and projects a fresh upload state. Confirmation, returning, uncertain and terminal Runs reject restart. The authority Workspace query uses the v4-verified Facet Type `d0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0`.

The package contains a process-isolated CommonJS Worker, declarative Surface, private migration, managed V8-derived governance IR, signed runtime-template base XLSX, and a signed Operation package. Core passes base64 bytes (64 MiB maximum), never filesystem paths. Runtime output patches only declared OOXML worksheet/core parts and verifies every undeclared part digest.

The governance IR contains 187 fields, 68 relation rules, and 15 scoring items. TemplateVersion semantic identity is stable across Runs; instance semantic/patch/output/governance digests are per Run.
