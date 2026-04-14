---
name: zone-calibration
description: Detects and acts on training zone drift — when the athlete's actual capability has diverged from stored HR or pace zones, propose and persist updates with full audit trail
---

# Zone Calibration

Training plans go stale because pace zones reflect a snapshot in time (a lab test, a previous fitness state). After several weeks of training, the athlete's actual capability moves but the stored zones don't. This skill is the self-correcting loop: detect drift, surface it, propose an update, persist it with audit trail.

## When This Skill Applies

Load this skill when:
- The startup context reports `fitness drift detected (high confidence)` — you MUST address it
- The athlete pushes back on a prescribed pace ("that feels too slow", "feels easy at faster")
- The athlete asks "is my fitness improving?" or "are my zones still right?"
- A new lactate test is shared (use test-report-analysis skill primarily, then this for the persistence step)
- You catch yourself flagging an "easy run too fast" that had stable Z2 HR — the zones are likely stale

## The Source of Truth

`data/athlete/training-zones.json` is the ONE place that holds current HR and pace zones. Read it via `get_training_zones`. Every other reference (CONTEXT.md, plan files, recent-summary.md) is either derived from it or historical context.

The plan file's workout cells DO NOT contain specific pace strings — they say "Easy 9km", "Tempo 30min", "MP 12km @ M pace". You resolve the pace at session time from `get_training_zones`. This is by design: a zone update is one file change, not 30 plan rewrites.

## The Drift Signal

The system computes drift automatically at every session start using `computeFitnessDrift`. You see the result in the startup context and can re-fetch it with `get_fitness_drift` on demand.

Signal shape:
```
{
  observed_easy_pace_sec: 305,        // current median Z2 work-phase pace
  sample_count: 22,
  date_range: { start: "2026-03-15", end: "2026-04-06" },
  stored_easy_pace: { min_sec: 350, max_sec: 380 },
  delta_sec_per_km: -45,              // negative = faster now
  direction: "improving",
  confidence: "high",
  should_prompt: true,
  summary: "Easy pace at Z2 HR has shifted ~45s/km faster..."
}
```

### Confidence rules

- **High + improving**: ≥10 valid samples over ≥14 days → propose update immediately
- **High + declining**: ≥20 valid samples over ≥21 days → ask before proposing a downgrade (could be fatigue, illness, life stress)
- **Medium / low**: report on request, don't proactively surface
- **Stable**: zones are good, do nothing

The asymmetry is intentional: faster confirms quickly, slower needs more evidence. This protects against downgrading a healthy athlete from a single bad week.

## What To Do When Drift Is High Confidence

### For improvements (most common case)

1. **Surface immediately, before any other coaching content.** Open the response with the drift fact:

   > "Quick observation before we dig in: your easy pace at Z2 HR has shifted ~45 sec/km faster over the last 22 runs (Mar 15 – Apr 6). Stored: 5:50–6:20/km. Observed: 5:00–5:20/km. That's a real aerobic gain — your zones are overdue for an update."

2. **Propose specific new ranges.** Don't ask "what should they be?" — compute them and show the math:
   - `easy.min_sec` = observed median - 10 (faster end)
   - `easy.max_sec` = observed median + 15 (slower end)
   - For other zones (recovery, marathon, tempo, threshold): scale relative to easy using the same ratio shift, OR use HR + lab anchors. If the athlete has no recent test, the safest move is to scale: if easy moved 30s/km faster, marathon also moved roughly 30s/km, threshold moved roughly 25s/km (less leverage at higher intensities).

3. **Ask for confirmation.** "Want me to update your zones to these values?" — wait for explicit yes.

4. **Persist with `update_pace_zones`.** Always include:
   - All five ranges (recovery, easy, marathon, tempo, threshold)
   - `source: "derived_from_training"`
   - `derivation_notes`: explain what data drove the update (sample count, date range, what the prior zones were, what changed)
   - `sample_count`, `date_range_start`, `date_range_end`: from the drift signal
   The audit entry to `zones-history.jsonl` is automatic.

5. **Update CONTEXT.md** if the "Training paces" line in the Current Training Plan section references specific values — replace it with the new ones (or just remove the specific paces and leave a pointer to `training-zones.json`).

### For declines (handle carefully)

1. Surface the observation, but framed as a question, not a proposal:
   > "Your easy pace at Z2 HR has slowed ~20 sec/km over the last 25 runs. Could be fatigue, illness, life stress, or detraining. How are you feeling? Anything been off?"

2. **Do NOT propose a zone downgrade until you understand the cause.** A real fitness regression requires both the data (≥20 samples / 21 days) AND athlete acknowledgment.

3. If the cause is a known temporary issue (sick, travel, work crunch) — log it in observations.md and keep zones unchanged. Re-evaluate after recovery.

4. If the regression is real and persistent — update zones with `source: "manual"` and a clear note about the cause.

## What `update_pace_zones` Does

- Writes the new pace block to `data/athlete/training-zones.json` (preserving the HR sub-object)
- Appends a JSONL entry to `data/athlete/zones-history.jsonl` with the prior values, new values, source, basis (sample count, date range), and your `derivation_notes`
- Returns a confirmation including the new ranges

The history file is append-only and is the canonical record of every zone change. You can read it via `get_zone_history` to answer "when did my fitness improve?" type questions.

## Anti-Patterns To Avoid

- ❌ Writing a memory note about "zones are outdated" instead of updating them. The athlete has been pushing back on this for weeks. Memory notes are not the fix.
- ❌ Quoting plan file pace strings as if they were authoritative. They are not — they are stale by design. `get_training_zones` is the truth.
- ❌ Flagging an easy run as "too fast" without first checking whether the stored zones are out of date. If HR was Z2 and drift was low, the run was not too fast.
- ❌ Proposing a zone downgrade after one bad week. Declines require ≥20 samples / 21 days AND athlete confirmation of cause.
- ❌ Calling `update_pace_zones` without explicit athlete confirmation. The athlete owns their plan.
- ❌ Rewriting the plan file when zones change. The plan file no longer hardcodes paces. One zone update propagates everywhere via the resolver.
