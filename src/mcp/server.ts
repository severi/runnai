import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  stravaSyncTool,
  stravaProfileTool,
  stravaAuthTool,
  queryActivitiesTool,
  stravaUpdateActivityTool,
  bestEffortsTool,
  getActivityStreamsTool,
  getRunAnalysisTool,
  saveRunAnalysisTool,
  getSessionAnalysisTool,
  planManagerTool,
  dateCalcTool,
  calculatorTool,
  attachReferenceTool,
  linkResearchTool,
  getPlanComplianceTool,
  getGearTool,
  manageGoalsTool,
  researchTool,
  saveResearchTool,
  saveRacePredictionTool,
  getPredictionHistoryTool,
  generateAerobicChartTool,
  managePersonalRecordsTool,
  setHrZonesTool,
  getHrZonesTool,
  getTrainingZonesTool,
  updatePaceZonesTool,
  getFitnessDriftTool,
  getZoneHistoryTool,
  readMemoryTool,
  writeMemoryTool,
  updateContextTool,
  searchMemoryTool,
  saveSessionSummaryTool,
  getWeatherTool,
  exportToIntervalsTool,
  pushToIntervalsTool,
  listIntervalsEventsTool,
  deleteIntervalsEventTool,
  reconcileIntervalsPlanTool,
  commitDataTool,
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
    stravaUpdateActivityTool,
    bestEffortsTool,
    // Activity streams
    getActivityStreamsTool,
    // Run analysis
    getRunAnalysisTool,
    saveRunAnalysisTool,
    // Heart-rate-only sessions (court and racket sports)
    getSessionAnalysisTool,
    // Planning & utility
    planManagerTool,
    dateCalcTool,
    calculatorTool,
    attachReferenceTool,
    linkResearchTool,
    getPlanComplianceTool,
    getGearTool,
    // Goals
    manageGoalsTool,
    // Research
    researchTool,
    saveResearchTool,
    // Analysis
    saveRacePredictionTool,
    getPredictionHistoryTool,
    generateAerobicChartTool,
    managePersonalRecordsTool,
    // HR zones
    setHrZonesTool,
    getHrZonesTool,
    // Training zones (HR + pace) and fitness drift
    getTrainingZonesTool,
    updatePaceZonesTool,
    getFitnessDriftTool,
    getZoneHistoryTool,
    // Weather
    getWeatherTool,
    // Intervals.icu
    exportToIntervalsTool,
    pushToIntervalsTool,
    listIntervalsEventsTool,
    deleteIntervalsEventTool,
    reconcileIntervalsPlanTool,
    // Data backup
    commitDataTool,
    // Memory
    readMemoryTool,
    writeMemoryTool,
    updateContextTool,
    searchMemoryTool,
    saveSessionSummaryTool,
  ],
});
