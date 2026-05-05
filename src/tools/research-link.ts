import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { sanitizeFilename, toolResult, toolError } from "../utils/format.js";
import { withDiffNote } from "../utils/data-git.js";
import { linkResearch } from "../utils/plan-research-link.js";
import { isDraftActive, nextDraftVersion, getDraftReasoningFile } from "../utils/plan-paths.js";
import { appendToSection } from "../utils/plan-reasoning.js";

export const linkResearchTool = tool(
  "link_research",
  "Link a shared research file (in data/research/topics/) to a specific plan. Pointer only — does not copy the file. Use whenever research informs plan decisions.",
  {
    planName: z.string().describe("Slug of the target plan."),
    researchFilename: z.string().describe("Filename of a research note in data/research/topics/."),
    note: z.string().describe("How this research applies to the plan."),
  },
  async ({ planName, researchFilename, note }) => {
    try {
      const slug = sanitizeFilename(planName);
      await linkResearch(slug, researchFilename, note);

      let extra = "";
      if (await isDraftActive(slug)) {
        const version = await nextDraftVersion(slug);
        await appendToSection(
          getDraftReasoningFile(slug, version),
          "Sources consulted",
          `- research/${researchFilename} — ${note}`,
        );
        extra = " (also linked in v" + version + "-draft reasoning.md)";
      }

      return toolResult(await withDiffNote(`linked research: ${researchFilename}${extra}`));
    } catch (e) {
      return toolError(e);
    }
  },
);
