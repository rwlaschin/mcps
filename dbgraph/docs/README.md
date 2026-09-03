<!--
Template for a new project's docs/README.md. Copy this in verbatim when
bootstrapping docs/ for the first time, then adjust naming conventions to
the project's own style if it already has one.
-->

# docs/ — rules

All design documents, plans, tasks, and mockups for this project live under `docs/`. This file is the rulebook for how that folder is organized — read it before adding or restructuring anything here.

## Format

Every document is Markdown with YAML frontmatter, using GitHub-Flavored Markdown extensions (tables, task lists, footnotes) — whichever Markdown flavor the project's tooling renders is the one to use; prefer the more feature-rich option over plain CommonMark.

Every document's frontmatter includes:
- `modified: <ISO date>` — updated every time the document's content changes. This is the sole mechanism for judging currency and staleness — there is no separate status field. A document whose `modified` date predates a change to something it depends on is a candidate for a review pass, not automatically wrong.
- `dependencies: [...]` — other design docs this one depends on or assumes. Also used to detect knock-on staleness (see above).

Plan documents additionally include:
- `supersedes: <plan-name | null>` — if this plan replaces an earlier one, name it here.

## Folder layout

```
docs/
  README.md                 — this file
  design/
    <subsystem>.md           — one authoritative design doc per subsystem/domain
  plans/
    <feature-name>/
      plan.md                 — detailed feature plan
      tasks.md                — itemized, persona-ordered task list
  mockups/
    <element-name>.md          — one mockup per individual UI/UX element
```

No master index of design docs is maintained — an index is another artifact that goes stale and needs upkeep. Discoverability comes from consistent naming and the folder structure itself (`docs/design/<subsystem>.md`), not a hand-maintained table of contents.

## One design doc per subsystem — no overlapping ownership

Each subsystem/domain has exactly one authoritative design doc. If a new plan touches an existing subsystem, it updates that subsystem's existing design doc rather than creating a second doc that also claims to describe it. Two design docs describing the same thing is always a bug to fix, not a tolerable overlap.

## Design documents

**A design doc describes the CURRENT, as-built state of a subsystem — nothing else.** Every claim in it must be verifiable by reading the actual running code today. It is never a place to describe a feature that's planned, in progress, or aspirational — that content belongs in a plan document (see below), not here. If you find yourself writing what a component *will* do, *should* do, or *is being redesigned to* do, stop — that sentence belongs in `docs/plans/<feature>/plan.md`, not in the design doc. A design doc is a snapshot of reality, not a spec for the future; when the future arrives (the plan is built), the design doc is updated to describe THAT new reality — but never before it exists.

Formatted like a skill file: a short header stating what this subsystem is, who needs to read it, and when to consult it — then the body. Reference other design docs this one depends on (via `dependencies` in frontmatter, and inline links where relevant in the body).

Required sections, in order. If a section doesn't apply, say so explicitly (e.g. "No UI/UX required") rather than omitting it — an omitted section is indistinguishable from an oversight, an explicit "not applicable" is not.

1. **Sensitive Areas** — anything here that's easy to break, security/data-sensitive, or has bitten the project before.
2. **Design Constraints** — hard limits this subsystem must respect (performance, compatibility, external contracts).
3. **Feature Overview** — what this is and why it exists. This carries the "why" — the rationale that would otherwise only live in a (deleted) plan document.
4. **Architecture** — how it's structured, the major components and how they relate.
5. **Functions** — the key functions/entry points, what they do.
6. **Models** — data shapes, schemas, types.
7. **Use Cases** — standard software-engineering use case format, not a bullet list of bugs/behaviors/notes, and not a single flattened Actor/Precondition/Action/Expectation paragraph either — a real use case has a numbered Basic Course of Events, not one collapsed "Action" step. A "Use Cases" section that's actually a bug report or a loose list of observed behaviors is invalid, not merely thin — it fails validation the same as a missing section. Each use case names:
   - **Goal** — what the actor is trying to accomplish, in one sentence.
   - **Stakeholders** — who cares about the outcome, even if not directly using it.
   - **Actors** — who/what directly performs the actions (a user role, another system, a scheduled job).
   - **Preconditions** — what must be true before this use case can start.
   - **Postconditions** — what's true after it completes successfully.
   - **Basic Course of Events (BCE)** — the numbered main success path, step by step.
   - **Alternate Flows** — variations on the main path that still succeed (a different valid route to the same postcondition).
   - **Exceptions** — what happens when something goes wrong (precondition violated, a step fails), and how the system responds.

   Also carries "why," from the outside in — Feature Overview explains why the subsystem exists, Use Cases explain why someone would invoke it. Existing-behavior notes, known bugs, or desired-behavior lists belong in the plan that's driving the change (or in code comments/issue tracking), not smuggled into a design doc's Use Cases section under that heading.
8. **Tests** — what's tested and where the tests live.
9. **UI/UX** — describes the interaction, defers to `docs/mockups/` for the actual visual spec. Never embed a mockup directly here — reference it.
10. **Dependencies** — other subsystems/design docs this one relies on.
11. **Diagrams** — architecture/flow diagrams as needed.
12. **References** — external docs, RFCs, prior art.

## Plan documents

**A plan document describes the concrete, checkable delta from the current state to a target state — never vague aspiration, and never a restatement of what already exists.** It is the ONLY place in `docs/` where not-yet-built work is described. Anything currently true belongs in the design doc, not repeated here; anything not yet decided doesn't belong in a plan either — a plan specifies what WILL be built, based on decisions already made, not a menu of options still being weighed.

**A plan contains zero discussion.** No investigative narrative, no "here's why this happens," no walkthrough of how a bug was traced, no prose explaining the reasoning behind a decision. If a sentence's job is to help a human understand or be convinced of something rather than tell an implementer exactly what to change, it does not belong in the plan — it belongs in the PR description, a conversation, or (if it documents real system behavior worth keeping) the design doc itself, once built. A plan reads like a checklist an implementer executes, not an essay a reviewer follows. This can't be caught by a mechanical grep the way a missing section can — it takes judgment to tell "actionable instruction" from "discussion dressed as instruction," so whoever authors or reviews a plan (human or LLM) checks for this explicitly before sign-off, the same way they'd check for a missing section.

Written **with the human** — this is the one deliberate human-in-the-loop step in the whole pipeline (see the `plan-changes` skill). A plan document opens with exactly two required sections, in this order, before anything else:

- **`## Problem`** — one to three sentences, factual, stating what's broken or missing. Not narrative: "the login endpoint returns 500 on an expired session token" is a Problem statement; "we investigated and found that the login endpoint..." is discussion and belongs nowhere in this document. If you can't state the problem in three sentences without explaining your reasoning, you're writing discussion, not a problem statement — cut it down.
- **`## Solution`** — one to three sentences, factual, stating the fix/approach at a glance, before `## Scope` spells out the file-by-file detail. Same rule: state the approach, don't justify it.

Then the rest of the plan:

- Fully specifies the instructions needed to write or update one or more design documents.
- States which sections/parts can be built in parallel and which are dependent on each other.
- States what success looks like — a concrete, checkable definition of done.
- Names `supersedes` if it replaces an earlier plan.
- **If the plan introduces new user-facing behavior** (not a pure internal refactor/bug-fix with no change in what a user can do), includes a `## Use Cases` section using the exact same 8-part shape as Design documents item 7 above (Goal/Stakeholders/Actors/.../Exceptions) — don't redefine that shape here, it's specified once, above. This is structured and checkable, not narrative, so it does not violate the zero-discussion rule above. A plan that only fixes existing behavior back to its already-documented spec doesn't need this — `Success Criteria` alone is enough when there's no new use case to walk through.
  - **A plan's Use Cases must go further than a design doc's would.** A design doc documents already-built, already-simple behavior — its BCE can stay at the level of what a user does. A plan is driving work that doesn't exist yet, so its BCE needs implementation-level specificity a design doc wouldn't: the actual function/file/query-key/error-code each step touches, not just the user-visible action. If a plan's Use Case reads exactly like a design doc's would once the feature ships, it's under-specified — it hasn't told the implementer anything the design doc won't already say for free.
- **Every plan includes a `## Testing Requirements` section.** Not the tests themselves — this states what kinds of tests the work needs (unit/API/E2E, which existing test file(s)/convention to extend or match) and what each covers, so a reviewer can judge test coverage adequacy before a single test is written. "Tests will be added" is not a Testing Requirements section any more than "it works" is a Success Criterion — name the specific scenarios each test type must cover, tying back to `## Use Cases`' Exceptions/Alternate Flows where applicable. A plan is reviewed for testing adequacy by a test-engineer (see the `plan-changes` skill) before human sign-off, the same way `verify-plan` reviews it for general soundness — a plan whose testing requirements are vague or absent fails that review the same as a missing section.

**Once the human signs off on a plan, the plan is frozen.** Nothing about it changes during execution. If reality diverges from the plan mid-build — a design gap is discovered, an approach turns out to be wrong — that is a **stop-and-replan event**: return to `plan-changes` and get a new or amended plan approved, rather than quietly patching the plan document or the implementation to paper over the gap. This is what prevents silent scope drift.

After the human approves a plan, everything downstream — task execution, verification, and folding the result back into the design docs — is automated. No additional human sign-off gate is expected by default.

## Task documents

An itemized list of everything required to meet the plan's stated success criteria, ordered by dependency, with the persona needed for each task noted (e.g. TDD → UI/UX designer → Architect → Technical Writer → Full-stack → Test Engineer → Full-stack → Test Engineer → Complete). This is what a fresh, automated session works through once the plan is approved.

## Mockups

**Mockups are real, renderable HTML** (`docs/mockups/<element>.html`), not markdown descriptions. A markdown paragraph describing a UI element has to be interpreted before it can be checked against reality; an HTML mockup can be opened in a browser, screenshotted, and diffed against the actual built component directly — which is the entire point of `verify-ui`'s spec-conformance check.

- **One document per individual UI/UX element** — not one per page or per feature.
- **Frontmatter** lives in a leading HTML comment, same fields as every other doc type: `<!--\n---\nmodified: <date>\ndependencies: [...]\n---\n-->`.
- **States** are separate `<section data-state="...">` blocks within the same file (`default`, `hover`, `disabled`, `loading`, etc.) rather than separate files per state — keeps an element's states co-located and diffable together.
- **Shared elements are real Web Components, not copy-paste or a bespoke reference syntax.** A shared piece (a navbar, a base button) is defined once as a custom element in `docs/mockups/_shared/<name>.js` using the browser's native `customElements` API, and any mockup that needs it loads it with a plain `<script src="_shared/<name>.js">` and uses it as a tag (e.g. `<mockup-navbar active="dashboard">`). This works in any browser with zero build step — verified working (a shared navbar rendered correctly with different active state on two separate mockup pages, no markup duplicated).
- Use the project's actual CSS classes/tokens in the mockup where possible, so it renders looking like the real thing rather than an abstract wireframe.
- Never inline a mockup inside a design doc's UI/UX section — always a separate file, referenced.

## Lifecycle

- **Plans are deleted when the feature is complete** — after `docs-integrate` folds the plan's decisions and rationale into the relevant design doc(s)' Feature Overview/Use Cases/Architecture sections, delete `plan.md` and `tasks.md`. Git history is the audit trail if anyone needs to see the original plan later; nothing about docs/ needs to preserve it going forward.
- **Design docs persist** and are updated in place as the system evolves. They are never deleted for a feature that still exists; if a whole subsystem is removed from the product, its design doc is deleted in the same change that removes the code.

## Anti-gap clause

A document section is only ever in one of two valid end states: **real content**, or an **explicit not-applicable statement** (e.g. "No UI/UX required."). A placeholder — "TODO," "TBD," "gap flagged, not authored," "[gap]," or anything else marking a section as intentionally incomplete — is neither, and is never an acceptable final state for a document in `docs/`. If something is missing but describes behavior that already exists in the codebase, resolve it by reading the actual implementation and writing it down — that's transcription, not authorship, and there's no excuse to leave a placeholder instead. If it's genuinely undecided and can't be resolved right now, that fact belongs in a report or conversation with whoever's reviewing the work — never written into the document itself. This is enforced mechanically (see below), not left to discipline alone.

## No process commentary — applies to every doc type

A design doc, plan, or task list records current facts and instructions — never the audit trail of how the doc or the code got there. "Reverted 2026-07-06 — not authorized," "written by an agent dispatch and then reverted at the user's instruction," "re-mark `[ ]` until authorized" — none of this belongs in any `docs/` file, no matter how true it was at the moment it was written. A future reader (human or agent) treats doc content as current ground truth; a stale note about what was once unauthorized, left in place after the work was later authorized, has already caused a real incident — an agent read the stale note and tried to revert already-authorized, working code. That history belongs in a git commit message or a conversation, never in the document itself. This is enforced mechanically (see below) the same way the anti-gap clause is — a doc doesn't get to keep a process note around "just in case," any more than it gets to keep a TODO around.

## Mechanical validation

`docs-integrate` runs a structural check (see its `scripts/validate.js`) against every document: correct frontmatter fields, all required sections present and gap-marker-free and process-commentary-free (or explicitly marked not applicable), and no broken `dependencies`/`supersedes` references. Treat a failure from that check as a real defect in the docs, not a formality to silence.
