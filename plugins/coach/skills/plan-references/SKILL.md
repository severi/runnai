---
name: plan-references
description: Use whenever the user mentions a local file as source material for the plan (PDFs, images, training docs) or whenever research is generated/used. Copies references into the plan; links research without copying.
---

# References and Research Linkage

## References (copy locally)

When the user mentions a local file path — *"the plan we based this on,"* *"the reference plan in my Downloads,"* attached PDFs — call `attach_reference` immediately:

attach_reference(planName=<slug>, filePath=<absolute path>, note=<one-line description>)

This copies the file into `data/plans/<slug>/references/` (so the plan stays self-contained), appends an entry to `references/INDEX.md`, and — if a draft is active — appends a line to `vN-draft/reasoning.md` under "Sources consulted."

Always announce: `attached reference: <slug>/references/<basename>`.

Do NOT wait for explicit instructions like "save this" — copy on first mention. The user has indicated this is source material; saving it locally is what they want.

## Research linkage (no copy)

Research lives in `data/research/topics/` and is shared across plans. Per-plan provenance lives in `data/plans/<slug>/research/INDEX.md`. Call `link_research` whenever existing research applies to plan decisions:

link_research(planName=<slug>, researchFilename=<basename>, note=<how it applies>)

`save_research` auto-links to the active plan if a draft is active — no extra call needed when the agent itself triggers research.
