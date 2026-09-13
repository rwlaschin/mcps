# Verified orchestration

For every implementation delegated to an agent:

1. Copy the user's approved design into a literal numbered `APPROVED REQUIREMENTS` checklist.
2. Treat that checklist as immutable scope. The implementer may touch only checklist items. If anything is ambiguous, stop before editing and ask the user.
3. Reject unapproved abstractions, safety machinery, allocations, locks, waits, fallbacks, and architecture changes. Passing tests never excuse a design violation.
4. Require the implementer to return the diff and runnable receipts, but never accept its self-report as proof.
5. The orchestrator must compare the actual diff against every checklist item and rerun the receipts, or dispatch a separate verifier that independently inspects the diff and reruns them.
