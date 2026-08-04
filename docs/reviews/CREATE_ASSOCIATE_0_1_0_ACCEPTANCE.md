# Create and Associate 0.1.0 acceptance record

Status on 2026-08-03: sequence-1 implementation candidate accepted by the automated evidence listed below. The end-to-end Return control loop is implemented but production mutation remains disabled because no target Omnia/Pack canary or capability evidence has been published. Automated harness evidence is not a canary.

Automated evidence covers the audited V8 digest and 9-sheet/187-field/68-relation/180-trace/21-evidence contract; SAP Higher 18, Lower 17, SAP.03 Higher-only; scoring 15 items, 14 Higher writes, one explicit N/A; real four-section XLSX parsing; stable physical-row keys; persistent issues and CAS revisions; distinct governance/base/instance digests; two different Runs sharing one immutable TemplateVersion; formula, validation, protection, and undeclared OOXML part preservation; lazy Remote Operation registration; action-level gates; signed IT Element, GRA, relationship, RAIT/status, dynamic Risk Factor, documentation, Risk-Control, and Evaluation submit/readback contracts; POST/PATCH uncertainty and read-only reconcile semantics.

Implemented automation covers immutable intent/confirmation/commands, one Comments confirmation, authority/workspace binding, durable create reservations, signed preflight/mutation/readback receipts, verified-current object/relation projection, deterministic failure cards, uncertain read-only reconcile, offline crash recovery, high-version Surface restoration, formal APP-description derivation, and signed install/upgrade/rollback/docs projection. The package carries machine-readable contracts, implementation mapping, declared test vectors, and an executable package-local self-test; the acceptance result remains external to the package.

## Final candidate and independent acceptance

- Feature: `omnia.create-associate@0.1.0`, sequence 1. Candidate file SHA-256: `af6a49b2f4e154051b2c0db3b7b049a9e416cbb8af4382396c41450202ee2029`; signed payload digest: `sha256:d95732bf5392652bd4a6cc1ca4499ca635578744754e4b1e21eeb1133855c215`.
- Operation: `omnia.create-associate.operation@0.1.0`, sequence 1. Candidate file SHA-256: `8b038875631882d91f381aa97a4fc641f5843bbce6f670330d448ae0e0c71128`; signed payload digest: `sha256:821440c80bc2c7f113f392f0d29b3eab0b306fc2cab6c64e37b27a0b7bbce933`.
- The nested Operation member is byte-identical to the standalone `.ofop`; official Ed25519 verification passed for both products. Two clean builds from the same source produced the same complete OFP and OFOP file hashes.
- `npx tsx --test tests/create-associate-feature.test.ts`: 11 passed, 0 failed.
- `npm run check`: lint, typecheck, 121 tests (120 passed, 0 failed, 1 existing environment-dependent skip), Shell build, and v4 runtime-independence gate all passed.
- Isolated portable-root smoke: CLI install and list succeeded, documentation was projected to the version/digest-specific registry path, and the installed package-local self-test passed. The automated lifecycle test also performed signed install, upgrade, private-state/docs preservation, and rollback. Shell 0.4.3 后续把该 OFP 作为内置包完成了真实 Windows 便携干净启动与 Surface 选择，详见 [0.4.3 便携验收](SHELL_0_4_3_CREATE_ASSOCIATE_PORTABLE_ACCEPTANCE.md)。
- Workbook smoke: the final signed Worker generated a new Run-specific XLSX from a real XLSX input. LibreOffice 26.2.5.2 opened it without repair and exported five A4 landscape pages: processing result, execution plan, two readable source-trace pages retaining all 12 fields, and issue/support matrix. No text overlap or embedded formula error was observed; formula, validation, protection, explicit row-height, and pagination OOXML gates passed.

## Evidence classes

- Automated: passed as listed above, including response-loss `applied` and `not_applied` reconcile branches with no mutation replay.
- Portable/package smoke: passed for isolated-root install/list/self-test、文档投影、LibreOffice workbook rendering，以及 Shell 0.4.3 最终 ZIP 的干净 data root/UI Surface 冒烟。
- Real Omnia canary: not run. No production Pack/Workspace mutation was authorized or attempted.

Not claimed: production mutation readiness, target Pack canary, Nova protocol compatibility, or live validation of any Omnia-specific response variant outside the recorded/signed contracts. Those remain release blockers. Tool relation creation remains blocked-not-implemented by the support matrix.
