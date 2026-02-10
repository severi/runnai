---
name: research
description: Look up running science topics
user-invocable: true
---

# Running Science Research

The user wants to research a running science topic.

1. Ask what topic they're interested in (if not already specified)

2. Delegate to researcher subagent:
   - Check local cache first (data/research/topics/)
   - If stale or missing, search the web
   - Save findings to the knowledge base

3. Present the findings:
   - Summary of the topic
   - How it applies to THEIR training specifically
   - Key sources and evidence quality
   - Practical recommendations

4. If the research is relevant to their current plan or training:
   - Note how it connects to their situation
   - Suggest any plan adjustments if warranted
   - Save relevant observations to memory
