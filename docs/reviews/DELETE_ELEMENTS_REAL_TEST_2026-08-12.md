# Delete Elements real TEST-workspace run — 2026-08-12

## Scope and boundary

- Pack / engagement: `bf2ff2d6-a758-4de4-d3a0-08dec1d74b3b`
- Workspace: `70628353-3b7c-f111-b337-0017fa079a58` (`TEST`)
- Shell: `0.4.15`
- Delete Feature used for the final OS/APP closure: `omnia.delete-elements@0.3.29`
- Transport: Connector Next v3, exact instance `omnia.connector-next.instance.df23fcf7-0dd3-4c86-b190-595c4344aa9f`
- Architecture boundary: deletion planning, dependency rules, mutations, reconciliation, and projections remain in the signed Delete Feature and generic Core store. Connector Next remains a generic Pack session / signed Operation transport. This test introduced no Delete/Feature business rule into Connector code.

## Real deletion results

| Type under test | Exact target | Required side effects | Timings observed | Result |
| --- | --- | --- | --- | --- |
| GRA | `d5802994-3a46-4bfa-9ec5-13f739d2e0d2` (`GRA-TEST-S4-HANA-080700`) | Receipt-backed cascade: 6 Risk, 32 Control, 24 Risk-Control | catalog 19.586s; mutation 11.503s; first confirm path 32.309s; projection recovery 21.187s; final closure 28.764s | Completed; target and complete frozen cascade read back absent |
| APP | `f65959fd-de06-4bd3-81de-08def42c852d` (`TEST-SAP-HANA-2`) | none | preparation 8.396s; successful confirm 55.777s | Completed, 1/1 |
| DCNO | `a4e11154-dc9c-4e05-d466-08dee7f97aea` (`TEST-DCNO-2`) | none | catalog 21.911s; preparation 8.352s; confirm 27.561s; total about 57.8s | Completed, 1/1 |
| TOOL | `3d32aa21-0290-439d-15b6-08def30470d5` (`R3-TOOL-TICKETING-0805`) | one dependent GRA was deleted first | first catalog 17.043s; first preparation 12.012s; first execution 35.293s; retry catalog 18.611s; retry preparation 4.572s; retry confirm 31.010s | Completed after safe pre-effect retry |
| DB | `b089678f-4eb7-4388-f09e-08def32618e5` (`V60C-DB-ORA-8060312`) | paired APP `e71cbe6c-9baf-42aa-5d38-08def3260e3d`, one GRA, one InfrastructureApplication relation group | DB-only preparation safely rejected after 95.909s; paired refresh 25.129s; paired preparation 29.969s; confirm 56.491s | Completed, 4/4 |
| OS | `2c93223f-265f-4190-180b-08def7b7ecbb` (`CA0811R8-AD-H`) | paired APP `9779597f-e7b5-4964-b101-08def7b7e7cc`, two GRAs, one InfrastructureApplication relation group | initial dependency-removal attempts are retained above; final 0.3.29 plan preparation 76.933s; final confirm-to-verified-completion 36.454s; independent post-run catalog refresh 18.184s | Completed: OS and paired APP both `readback_verified`; final and independent authoritative catalogs contain 234 items and prove both exact identities absent |
| Information | no candidate exists in the authoritative TEST catalog | none | n/a | Not testable: catalog count was zero |

## Defects found during the real run

1. Core rejected Delete GRA return intents with a Create-only disposition rule. The Feature-specific rule was removed from the generic return-intent path.
2. GRA cascade parsing expected fields not present in the signed Delete cascade contract. Core now uses the actual four-field Risk-Control identity: Risk, Control, RiskRiskScope, and RiskScope.
3. Final read-only catalog closure was incorrectly classified as an Omnia mutation. `finishReturn` is now a local durable state write after all receipt/projection checks.
4. Object mutation preflight lost frozen `objectId`, `workItemId`, and `objectType`. The Delete Feature now carries these exact fields in its operation target.
5. Deleting a planned GRA legitimately changed the dependent TOOL timestamp, but the next object step treated it as external drift. Dependency-planned objects now accept timestamp movement only after all frozen prerequisites pass and the new preflight proves zero blockers/relations.
6. Selecting only one endpoint of an InfrastructureApplication pair produced `DELETE.PREPARATION_GRAPH_INCOMPLETE`; no mutation occurred. Selecting both exact endpoints generated the correct unlink/GRA/object graph.
7. A read-only reconcile action continued into pending mutation steps. Core correctly blocked those writes. Delete 0.3.29 now stops at `resume_required` after uncertainty closure and exposes a separate mutation-authorized `resume-delete-plan` action; read-only reconcile can no longer execute pending mutations.
8. Legacy Create Risk-Control projections reused a relation key across different GRA/Risk/Control instances. The managed relation head and its current immutable revision could therefore disagree. Core recovery now realigns a collided legacy head to its own current revision and uses a distinct canonical tombstone for the exact signed deletion identity; new projection attempts with the same key but different endpoints fail closed.
9. After the second Core restart, Connector Next remained online but the remote Pack session moved to `waiting_login`. This was a separate session-recovery stability issue and is not counted as a speed improvement. After Pack reconnection, the final 0.3.29 run completed normally.

## Speed assessment

- Normal-path catalog refresh is consistently about 17–25 seconds and is currently the largest fixed front-end cost.
- Plan preparation for simple standalone objects is about 4–8 seconds; paired infrastructure plans are about 30–33 seconds.
- Confirm-to-authoritative-completion ranged from 27.6 seconds (DCNO) to 56.5 seconds (DB pair). This is real normal-path latency and is separate from recovery time after defects.
- Failures, reconnects, projection repairs, and user-confirmed retries are stability/recovery costs and must not be claimed as throughput improvements.
- The highest-value speed work is to reduce repeated authoritative catalog reads, parallelize independent read-only preflights within a frozen plan, and avoid serial polling between already terminal command receipts. These changes belong in Feature/Core orchestration, not Connector business logic.

## Current release decision

The Delete Feature now has real completed evidence for every supported target type present in TEST: GRA, APP, DB, OS, DCNO, and TOOL. The final OS/paired-APP run `610a1759-6de0-42d0-a8e8-5526cd75cea1` completed 2/2 with exact read-back and independent catalog absence. Information remains untested because the authoritative TEST catalog contains zero Information candidates; this is unavailable test data, not a failed deletion path.

## Additional ten-per-type destructive batch

- Feature: `omnia.delete-elements@0.3.30`, signed package digest `sha256:d7e013b53081a33f9bfdfb58ba6233f3c5c5e5e725f9bf7e771cd2d74cd60d2a`.
- Initial authoritative counts for this batch were GRA 115, APP 56, DB 20, OS 22, DCNO 6, and TOOL 15.
- Final independent authoritative recapture at `2026-08-12T08:05:16.776Z` contained GRA 54, APP 35, DB 10, OS 12, TOOL 5, and no DCNO. The exact TEST workspace and Connector Next binding remained unchanged.
- Direct object deletion coverage reached: GRA at least 10, APP 21, DB 10, OS 10, TOOL 10, and DCNO 6. DCNO was exhausted 6/6; the requested 10 cannot be represented because only six authoritative DCNO samples existed at batch start. No missing samples were fabricated.
- The first ten-GRA Run was `fc664a91-2187-460e-bb4e-d585615da468`. The 19-target APP/dependency Run `6c243e09-307e-4ec7-bfa1-45ea6118fc31` completed 37/45 graph steps, including all 10 APP and 4 TOOL targets. The 46-target closure Run `b510ebb8-3fd2-47f6-bc22-f16fb1b470d6` completed 71/115 graph steps, including 2 DB, 3 OS, 2 DCNO, 6 TOOL, and 11 required APP endpoints.
- All remaining DB, OS, and DCNO samples were executed as independent fresh-authority Runs. Every one ended `succeeded`; no uncertain command remained. Standalone end-to-end Run durations ranged from 31.689s to 68.361s, with most between 39.8s and 47.0s.

### Additional defects and observations

1. The signed Delete Operation handler treated the .NET empty GUID (`00000000-0000-0000-0000-000000000000`) as a real Application Workspace. Version 0.3.30 now resolves that value through exact partner detail plus facet mapping. The regression is covered by `operation-readback.test.cjs`; Connector Next still contains no Delete business rule.
2. Legacy Create Risk-Control projection payloads can omit `plannedRiskFactorCategory`. Core now recovers only when the exact durable command spec binds the same GRA, risk scope, risk, control, and relation endpoints. Wrong-GRA evidence remains fail-closed.
3. Large graph batches expose a real scheduling defect: deleting one GRA can intentionally change shared Risk/Control state, while later GRA steps compare against the batch-start snapshot and report `DELETE.PREFLIGHT_DRIFT`. Affected dependent objects are safely skipped before mutation. Fresh independent plans succeed. The production fix should make the scheduler account for verified earlier in-plan effects, rather than weakening drift checks.
4. Directory refresh averaged roughly 13-16s in this run. A simple independent object Run typically took about 40-47s end to end. The largest speed opportunity remains concurrent read-only preflight/readback for independent graph nodes and eliminating the duplicate full serial confirmation preflight. Mutation ordering and exact readback must remain dependency-aware.
5. No Feature implementation was added to Connector Next. Catalog parsing, graph compilation, mutation choice, drift handling, and projection remain in the signed Delete Feature and generic Core storage/receipt boundaries.
