import chalk from "chalk";
import * as fs from "fs/promises";
import * as path from "path";
import { getSessionUsage, formatTokens } from "../utils/usage-tracker.js";

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "tool_activity" | "debug" | "status" | "error";
  content: string;
}

export interface Command {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[], context: CommandContext) => Promise<void>;
}

export interface CommandContext {
  print: (text: string) => void;
  streamResponse: (input: string) => Promise<void>;
  getMessages: () => Message[];
}

export const commands: Command[] = [
  // Local commands (handled in CLI)
  {
    name: "help",
    description: "Show available commands",
    usage: "/help",
    handler: async (_args, ctx) => {
      let helpText = "\nAvailable Commands:\n";
      commands.forEach((cmd) => {
        helpText += `  ${chalk.yellow(`/${cmd.name}`)}${chalk.gray(` - ${cmd.description}`)}\n`;
      });
      ctx.print(helpText);
    },
  },
  {
    name: "clear",
    description: "Clear messages and reset session",
    usage: "/clear",
    handler: async (_args, ctx) => {
      ctx.print(chalk.dim("Cleared.\n"));
    },
  },
  {
    name: "verbose",
    description: "Toggle debug panel",
    usage: "/verbose",
    handler: async (_args, _ctx) => {
      // Handled in App.tsx
    },
  },
  {
    name: "usage",
    description: "Show session token usage and cost",
    usage: "/usage",
    handler: async (_args, ctx) => {
      const s = getSessionUsage();
      if (s.exchangeCount === 0) {
        ctx.print("No exchanges yet this session.");
        return;
      }

      const line = (label: string, value: string) =>
        `  ${label.padEnd(18)}${value}`;

      const avgCostCents = (s.costUsd / s.exchangeCount) * 100;

      const text = [
        "",
        "Session Usage",
        "────────────────────────────────",
        line("Exchanges:", String(s.exchangeCount)),
        line("Total turns:", String(s.numTurns)),
        "",
        "Tokens",
        line("Input:", formatTokens(s.inputTokens)),
        line("Output:", formatTokens(s.outputTokens)),
        line("Cache read:", formatTokens(s.cacheReadTokens)),
        line("Cache creation:", formatTokens(s.cacheCreationTokens)),
        "",
        "Cost & Time",
        line("Total cost:", `${(s.costUsd * 100).toFixed(1)}¢`),
        line("Avg per exchange:", `${avgCostCents.toFixed(1)}¢`),
        line("Total time:", `${(s.durationMs / 1000).toFixed(1)}s`),
        "",
      ].join("\n");

      ctx.print(text);
    },
  },
  {
    name: "exit",
    description: "Exit the coach",
    usage: "/exit",
    handler: async () => {
      // Handled in App.tsx
    },
  },

  {
    name: "reset-profile",
    description: "Reset profile & memory (keeps Strava data)",
    usage: "/reset-profile",
    handler: async (_args, ctx) => {
      // Handled in App.tsx — needs access to React state
    },
  },

  // Agent commands (sent as prompts to SDK)
  {
    name: "setup",
    description: "Initial setup — connect Strava and create your profile",
    usage: "/setup",
    handler: async (_args, ctx) => {
      await ctx.streamResponse(
        "[Onboarding] Follow the setup command protocol. Start with Phase 1: connect Strava (strava_auth), fetch profile + 180 days of data (strava_profile), analyze my training patterns. Then move to Phase 2: ask me ONE specific question about an anomaly you found in my data. Stop and wait for my response."
      );
    },
  },
  {
    name: "sync",
    description: "Sync activities from Strava",
    usage: "/sync [days] — e.g., /sync 14",
    handler: async (args, ctx) => {
      const days = args[0] || "30";
      await ctx.streamResponse(
        `Sync my Strava activities from the last ${days} days using the strava_sync tool. Show me a summary of what was synced.`
      );
    },
  },
  {
    name: "plan",
    description: "Create or update a training plan",
    usage: "/plan [goal] — e.g., /plan marathon sub-4",
    handler: async (args, ctx) => {
      const goal = args.length > 0 ? args.join(" ") : "";
      const prompt = goal
        ? `Create a training plan for: ${goal}. First assess my current fitness, then build a periodized plan.`
        : `Read data/athlete/CONTEXT.md for my goals and help me create a training plan. First assess my current fitness.`;
      await ctx.streamResponse(prompt);
    },
  },
  {
    name: "progress",
    description: "Review training progress",
    usage: "/progress [period] — e.g., /progress week",
    handler: async (args, ctx) => {
      const period = args[0] || "recent";
      await ctx.streamResponse(
        `Review my ${period} training progress. Compare my actual activities to my plan and give me feedback.`
      );
    },
  },
  {
    name: "race",
    description: "Race prediction and planning",
    usage: "/race [distance] — e.g., /race marathon",
    handler: async (args, ctx) => {
      const distance = args.length > 0 ? args.join(" ") : "";
      const prompt = distance
        ? `Predict my race time for ${distance} based on my recent training data and give me a race strategy.`
        : `Analyze my fitness and predict my race times for common distances (5K, 10K, half marathon, marathon).`;
      await ctx.streamResponse(prompt);
    },
  },
  {
    name: "research",
    description: "Look up running science topics",
    usage: "/research <topic> — e.g., /research tempo runs",
    handler: async (args, ctx) => {
      if (args.length === 0) {
        ctx.print(chalk.yellow("Please specify a topic: /research <topic>"));
        return;
      }
      const topic = args.join(" ");
      await ctx.streamResponse(`Research the topic: ${topic}`);
    },
  },
];

export function getCommandByName(name: string): Command | undefined {
  return commands.find((cmd) => cmd.name === name);
}

export function getCommandNames(): string[] {
  return commands.map((cmd) => cmd.name);
}
