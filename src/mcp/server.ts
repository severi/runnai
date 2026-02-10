import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  stravaSyncTool,
  stravaProfileTool,
  stravaAuthTool,
  queryActivitiesTool,
  bestEffortsTool,
  planManagerTool,
  dateCalcTool,
  calculatorTool,
  researchTool,
  saveResearchTool,
  saveRacePredictionTool,
  getPredictionHistoryTool,
  setHrZonesTool,
  getHrZonesTool,
  readMemoryTool,
  writeMemoryTool,
  updateContextTool,
  searchMemoryTool,
  saveSessionSummaryTool,
  getWeatherTool,
} from "../tools/index.js";

export const coachMcpServer = createSdkMcpServer({
  name: "runnai",
  version: "1.0.0",
  tools: [
    // Strava
    stravaSyncTool,
    stravaProfileTool,
    stravaAuthTool,
    queryActivitiesTool,
    bestEffortsTool,
    // Planning & utility
    planManagerTool,
    dateCalcTool,
    calculatorTool,
    // Research
    researchTool,
    saveResearchTool,
    // Analysis
    saveRacePredictionTool,
    getPredictionHistoryTool,
    // HR zones
    setHrZonesTool,
    getHrZonesTool,
    // Weather
    getWeatherTool,
    // Memory
    readMemoryTool,
    writeMemoryTool,
    updateContextTool,
    searchMemoryTool,
    saveSessionSummaryTool,
  ],
});
