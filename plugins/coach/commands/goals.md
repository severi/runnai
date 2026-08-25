---
name: goals
description: Talk through what the athlete is aiming at and why — north star, horizon goals, next events
user-invocable: true
---

# Goals

A conversation, not a form. The aim is the picture a lifetime coach carries in their head: why this person runs, what they are building toward over years, and what the next event is for. Goals guide coaching; they never restrict the athlete.

Start with `manage_goals(action: 'list', includeHistory: true)`.

## If there is no north star yet

Have the "why" conversation. One question at a time, in your own words, following what they say:
- What got you running, and what keeps you at it?
- If you imagine yourself at 70, what do you want to still be able to do?
- What would you regret not having tried?
- What would make you stop?

Listen for the thing under the answers. Then propose a one-line statement and a short `why` in the athlete's own phrases, read both back, and ask if that is right. Record it with `manage_goals(action: 'add', tier: 'northstar', confirmedByAthlete: true, ...)` only on an explicit yes.

Then a lighter pass over the horizon: "Beyond the next race — what is on the list?" Each thing they name goes in as a horizon goal, `aspiration` unless they say they are committed, with a rough window and metric if they have one, and `athleteNotes` capturing how they talk about it. Link it to the north star with `parentId` when the connection is obvious; leave it unlinked when it isn't.

Finish with the next event(s) if any are not recorded yet, and link each to whatever it serves.

## If a north star exists

Review mode. Walk the tree, briefly:
- Read the north star back. Still true? If the wording has drifted, propose a restatement and record it with `confirmedByAthlete: true` on their yes — the old wording stays in history.
- Horizon goals: anything to promote (aspiration → committed), park, or revive? Any new aim to add?
- Tensions the tool lists: raise them as a question ("if both, which leads next season?"), not as a problem to solve now.
- Events: is the next race linked to what it serves? Is the plan linked (`planSlug`)?

## Afterwards

- Where you have a view on a horizon goal's feasibility, write it with `manage_goals(action: 'assess')` — dated, with the file holding the full workup in `detailRef`.
- Update CONTEXT.md only if the training phase or the next race changed; goals themselves live in goals.json.
- Close with a two- or three-line summary of the picture as it now stands.
