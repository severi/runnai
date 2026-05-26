---
name: plan-revision
description: Govern major plan revisions — when to enter revision mode, how to capture reasoning, when to finalize. Use whenever a discussion shifts from tactical to structural.
---

# Plan Revision

A *minor edit* changes a few sessions. A *major revision* restructures phases, weeks, or the overall approach.

## When to enter revision mode

Enter via `manage_plan(action: "revise")` when any of these are true:

- User says "overhaul," "rethink," "first principles," "redo the back half," etc.
- The proposed change spans 3+ weeks or alters phase structure.
- The user is doing fresh research that will inform multiple changes.
- A minor edit conversation drifts into something structural — at the point you notice, ask: *"This is starting to look like a revision. Want me to enter revision mode? I'll snapshot to vN-draft and we can iterate there."*

Always announce the transition: `entered revision mode → versions/vN-draft created`.

## Capture reasoning in real time

`vN-draft/reasoning.md` has six sections. Append to them as decisions emerge — not at the end.

| Section | Append when… |
|---|---|
| **Trigger** | First decision-relevant turn — what set this revision off |
| **Sources consulted** | A reference is attached or research is linked |
| **Constraints** | User mentions a real-world thing that shapes plan: schedule, injury, preference |
| **Decisions and rationale** | Any time you (or user) commit to a design choice — narrative paragraph or bullet |
| **Key changes from previous version** | At a high level, what's different; can be appended cumulatively |
| **Open items at finalize** | Things deferred or unresolved |

Aim for the notebook to be mostly complete by the time the user is ready to finalize.

## Finalize

`manage_plan(action: "finalize")` checks Trigger / Decisions / Key changes are non-empty. If empty, finalize fails — this is the soft enforcement. Either:
- Backfill the sections (preferred).
- Call again with `allowEmpty: true` after explicit user approval.

After finalize, announce: `finalized vN → live plan now reflects vN. CHANGELOG +1.`

## Check the seams before finalizing

Revisions restructure weeks one at a time, so plans break at the *boundaries between separately-edited weeks* — the classic failure is a hard session early in one week landing right after the previous week's long run or B2B weekend. Before finalize, walk every modified week boundary: re-read each revised week's first 2 days against the previous week's last 2 days, and its last day against the next week's opener. The hard/easy and fatigue-carryover rules apply across these seams — see the `weekly-planning` skill, "Plan Across Week Boundaries, Not In Isolation."

## Discard

When a revision is going nowhere or the user changes their mind, `manage_plan(action: "discard")` removes the draft. Confirm before calling: *"Discard the current draft? This deletes vN-draft permanently."*
