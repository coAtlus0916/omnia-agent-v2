# Cross-generation partial Return recovery

Core supports one deliberately narrow recovery mode for a nonterminal Return left by an older Feature generation. The mode is `partial_close_no_reuse`: it can determine the outcome of a possibly submitted legacy command through signed read-only Operations and close the old Run, but it cannot replay a mutation, continue the old Run, or transfer ownership to a successor Run.

## Activation boundary

A package may activate over a nonterminal legacy Run only when its signed manifest declares `omnia.feature-recovery-compatibility/v1`, mode `partial_close_no_reuse`, and the exact source Feature version. Create & Associate 0.2.67 retains the 0.2.60 compatibility declaration for audit continuity, but its recovery action is hidden and disabled while product recovery is paused. Normal upload is available only after the old Run has already reached a conclusive closed state; the pause never bypasses Core's nonterminal Run gate.

## Authorization and evidence

Inspection requires one immutable approved confirmation, one current durable safety lock, the same connector, authority instance, tenant/org, Pack, Engagement, and an exact Workspace set shared by every legacy verified receipt and every legacy intent. The current Connector session generation must be new. Every already verified command must have exactly one authoritative receipt and exactly one matching object or relation projection. Any mismatch fails closed.

Authorization is append-only, revision-bound, and short-lived. Each possibly submitted failed command is copied into an immutable recovery target with its frozen reconcile specification. PackageManager accepts a recovery receipt context only for a signed read-only Operation whose target, Workspace, authority, and request exactly match that specification. Mutation Operations and ordinary worker actions remain unavailable.

Core, rather than the Feature, decides outcome semantics:

- `not_applied` requires the exact frozen GRA preflight response `{ found: false, item: null, evidence: { directoryMatches: 0 } }`.
- `applied` requires a unique exact preflight identity followed by the signed GRA read-back Operation, with the returned ID, entity, name, type, content, type ID, and Workspace matching the frozen specification.

An absent, ambiguous, structurally incomplete, or mismatched response cannot produce an outcome and therefore cannot close the Run.

## Close semantics

Closing requires one conclusive append-only outcome for every recovery target, an unchanged authorization and safety revision, no active mutation reservation, and a compare-and-swap from the exact legacy Run revision. Core changes only the old Run state to `failed` and cancels its still-frozen intents. It never edits the old confirmation, Feature version, verified receipts, or projections.

No recovery grant is created. A subsequent import creates an ordinary successor Run with no inherited ownership. Existing `proveOwnedCreatedObject` behavior remains strict to the current Feature and Connector generation.
