import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./MarkdownText.js";
import type { StartupContext } from "../../utils/startup-sync.js";

function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

interface StartupDashboardProps {
  ctx: StartupContext | null;  // null = still syncing
  greeting: string | null;     // null = not yet available (generic shown)
}

export function StartupDashboard({ ctx, greeting }: StartupDashboardProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Greeting — generic until Sonnet replaces it */}
      <Greeting text={greeting} loading={!ctx} />

      {/* Data section — appears after sync */}
      {ctx && (
        <>
          <SyncStatus sync={ctx.sync} />
          {ctx.raceCountdowns.length > 0 && <RaceCountdowns races={ctx.raceCountdowns} />}
          {ctx.planExcerpt && <PlanExcerpt plan={ctx.planExcerpt} />}
        </>
      )}
    </Box>
  );
}

function Greeting({ text, loading }: { text: string | null; loading: boolean }) {
  if (text) {
    // Personalized greeting from Sonnet
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="green">Coach</Text>
        <Box marginLeft={1} flexDirection="column">
          <MarkdownText>{text}</MarkdownText>
        </Box>
      </Box>
    );
  }

  // Generic greeting while loading
  return (
    <Box marginBottom={1}>
      <Text bold color="green">Coach</Text>
      <Text> {getTimeGreeting()}! {loading ? "Syncing your training data..." : "Warming up..."}</Text>
    </Box>
  );
}

function SyncStatus({ sync }: { sync: StartupContext["sync"] }) {
  if (sync.status === "error") {
    return (
      <Text color="red">✗ {sync.message}{sync.needsAuth ? " — run /strava-auth" : ""}</Text>
    );
  }
  if (sync.status === "new_activities") {
    return <Text color="green">{"↓"} {sync.message}</Text>;
  }
  return <Text color="green" dimColor>{"✓"} Strava synced — up to date</Text>;
}

function RaceCountdowns({ races }: { races: StartupContext["raceCountdowns"] }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {races.map(r => `${r.name}: ${r.daysAway} days (${r.weeksAway} weeks)`).join(" · ")}
      </Text>
    </Box>
  );
}

function PlanExcerpt({ plan }: { plan: NonNullable<StartupContext["planExcerpt"]> }) {
  const firstLine = plan.currentWeek.split("\n")[0] || "";
  const contentLines = plan.currentWeek
    .split("\n")
    .filter(line => line.startsWith("|") && !line.startsWith("|--") && !line.match(/^\|\s*Day\s*\|/i))
    .map(line => {
      const cols = line.split("|").filter(Boolean).map(c => c.trim());
      if (cols.length >= 3) return `  ${cols[0]}: ${cols[2]}`;
      if (cols.length >= 2) return `  ${cols[0]}: ${cols[1]}`;
      return null;
    })
    .filter(Boolean);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{plan.name} — {firstLine.replace(/^#+\s*/, "")}</Text>
      {contentLines.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
    </Box>
  );
}
