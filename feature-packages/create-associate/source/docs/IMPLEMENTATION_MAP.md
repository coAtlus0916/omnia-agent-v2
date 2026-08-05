# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.18 keeps the four-plane boundary: Renderer displays the backend-driven Upload/Validate/Comments-review/Return status rail and grouped business progress; Worker derives workflow and compact confirmation summaries from the full durable plan and real Return progress, while Core retains immutable preflights, target keys, commands, evidence, Comments confirmation, and strict `resume|reuse` resolved-object binding. Connector hosts only the existing signed Operations. The declarative workflow contract has no host-tab navigation action, so Comments is not exposed as a fake clickable rail item. APP identity, APP create preflight, object read-back, and Application-settings reads share deletion's signed Work Item Facet Mapping authority instead of trusting IT Element search/detail `workspaceId`. Review hides the internal TemplateInstance artifact and Upload never exports a source Artifact. Business branching remains outside Connector Core.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
