import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { sanitizeFilename, toolResult, toolError } from "../utils/format.js";
import { withDiffNote } from "../utils/data-git.js";
import { attachReference } from "../utils/plan-references.js";
import { isDraftActive, nextDraftVersion, getDraftReasoningFile } from "../utils/plan-paths.js";
import { appendToSection } from "../utils/plan-reasoning.js";

export const attachReferenceTool = tool(
  "attach_reference",
  "Copy a local file (PDF, image, doc) into the plan's references/ directory and index it. Use whenever the user mentions a reference document or attaches one in chat.",
  {
    planName: z.string().describe("Slug of the target plan."),
    filePath: z.string().describe("Absolute path to the source file."),
    note: z.string().describe("One-line description of what this reference is and how it relates to the plan."),
  },
  async ({ planName, filePath, note }) => {
    try {
      const slug = sanitizeFilename(planName);
      const { destPath, basename } = await attachReference(slug, filePath, note);

      let extra = "";
      if (await isDraftActive(slug)) {
        const version = await nextDraftVersion(slug);
        await appendToSection(
          getDraftReasoningFile(slug, version),
          "Sources consulted",
          `- references/${basename} — ${note}`,
        );
        extra = " (also linked in v" + version + "-draft reasoning.md)";
      }

      return toolResult(await withDiffNote(`attached reference: ${destPath}${extra}`));
    } catch (e) {
      return toolError(e);
    }
  },
);
