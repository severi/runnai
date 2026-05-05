---
name: plan
description: Create or update a training plan. Supports minor edits and major revisions.
user-invocable: true
---

# Training Plan Creation/Update

Each plan is a directory under `data/plans/<slug>/` containing `plan.md` (live), `CHANGELOG.md`, `references/`, `research/`, and `versions/`.

## Step 0: Read Profile

Before anything else, read `data/athlete/CONTEXT.md` for the athlete's full profile. Use this throughout. Do NOT ask about info already in the profile.

## Detect mode

Check whether the active plan has `.draft-active`. If yes, a revision is in progress — surface this immediately:

> _⏳ Revision in progress on plan `<slug>`. The current draft is at `versions/vN-draft/plan.md`. Continue editing the draft, or `/plan finalize` to lock it in, or `/plan discard` to throw it out._

## If No Plan Exists

Run the fitness-assessor subagent to assess current fitness, then delegate to the plan-creator subagent. New plan creation goes through `manage_plan(action: "create")` which scaffolds the directory automatically (plan.md with frontmatter, versions/v1/, references/, research/, CHANGELOG.md).

## If Plan Exists

Decide flow shape based on the user's intent.

### Minor edit (default)

Use `manage_plan(action: "update")`. This auto-targets the live `plan.md` and appends a one-liner to `CHANGELOG.md`. Use for tactical changes like:
- Move Tuesday's run to Wednesday
- Update Saturday's actuals
- Drop strength to 1x this week

### Major revision (`/plan revise` or natural language)

If the user says "let's overhaul," "rethink the back half," "redo the plan from first principles," or similar — enter revision mode:

1. Call `manage_plan(action: "revise")`. Coach announces: *"entered revision mode → versions/vN-draft created."*
2. Edit the **draft**: any `manage_plan(action: "update")` calls now auto-target `vN-draft/plan.md`.
3. As decisions are made during the conversation, append to `vN-draft/reasoning.md` via the Sources/Constraints/Decisions/etc sections — see plan-revision skill.
4. To compare, call `manage_plan(action: "diff")` — writes to `vN-draft/diff.md`.
5. To approve: `manage_plan(action: "finalize")`. This snapshots the draft as `versions/vN/`, swaps `plan.md`, removes the marker. Soft-checks that Trigger / Decisions and rationale / Key changes are filled — passes `allowEmpty: true` only if the user explicitly approves.
6. To throw out: `manage_plan(action: "discard")`.

### References

Whenever the user mentions a local file (PDF, image) as source material — "the threshold plan in Downloads," attached PDFs — call `attach_reference` immediately. See plan-references skill.

### Research

Whenever research informs the plan, call `link_research`. `save_research` auto-links during drafts.
