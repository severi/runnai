export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  city: string | null;
  state: string | null;
  country: string | null;
  sex: string;
  weight: number;
  measurement_preference: string;
  shoes: Array<{
    id: string;
    name: string;
    primary: boolean;
    distance: number;
  }>;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  average_cadence?: number;
  workout_type?: number;
  description?: string;
  trainer?: boolean;
  start_latlng?: [number, number] | null;
}

export interface SyncResult {
  success: boolean;
  activities?: StravaActivity[];
  summary?: string;
  error?: string;
  needsAuth?: boolean;
  authUrl?: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  authUrl?: string;
}

export interface AthleteProfileResult {
  success: boolean;
  athlete?: StravaAthlete;
  error?: string;
  needsAuth?: boolean;
  authUrl?: string;
}

export interface BestEffortRecord {
  id?: number;
  activity_id: number;
  distance_name: string;
  distance_meters: number;
  elapsed_time: number;
  pace_per_km: number;
  start_index: number;
  end_index: number;
  computed_at: string;
}

export interface RacePrediction {
  id?: number;
  race_distance: string;
  predicted_time: number;
  confidence: "low" | "medium" | "high";
  basis: string;
  predicted_at: string;
}

export interface MemoryFile {
  path: string;
  content: string;
  lastModified: Date;
}

export interface ActivityStream {
  time: number[];
  distance: number[];
  heartrate?: number[];
  altitude?: number[];
  grade_smooth?: number[];
  cadence?: number[];
}

export interface ActivityStreamRecord {
  activity_id: number;
  time_data: string | null;
  distance_data: string | null;
  heartrate_data: string | null;
  altitude_data: string | null;
  grade_smooth_data: string | null;
  cadence_data: string | null;
  fetched_at: string;
}

export interface BestEffortResult {
  activityId: number;
  activityName: string;
  activityDate: string;
  segmentTimeSeconds: number;
  segmentDistanceMeters: number;
  formattedTime: string;
  pacePerKm: string;
  stravaUrl: string;
  source: "strava" | "computed";
  activityDistance: number;
  workoutType: number | null;
  runType: string | null;
  prRank: number | null;
  compactLaps: string | null;
}

export interface StravaBestEffort {
  id: number;
  name: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  start_date_local: string;
  start_index: number;
  end_index: number;
  pr_rank: number | null;
}

export type RunType = "easy" | "tempo" | "intervals" | "fartlek" | "long_run" | "race" | "recovery" | "threshold" | "progression" | "hill_repeat" | "unknown";

export interface StravaLap {
  id: number;
  lap_index: number;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  start_index: number;
  end_index: number;
}

export interface ActivityLapRecord {
  activity_id: number;
  lap_index: number;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  average_speed: number;
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  start_index: number;
  end_index: number;
  elevation_gain: number | null;
  elevation_loss: number | null;
}

export interface HrZones {
  source: "lactate_test" | "estimated" | "manual";
  lt1: number;
  lt2: number;
  max_hr: number;
  confirmed: boolean;
}

export interface ClassificationResult {
  run_type: RunType;
  run_type_detail: string | null;
  confidence: "high" | "medium" | "low";
}

export interface StravaBestEffortRecord {
  id?: number;
  strava_effort_id: number;
  activity_id: number;
  distance_name: string;
  distance_meters: number;
  elapsed_time: number;
  moving_time: number;
  pace_per_km: number;
  start_index: number;
  end_index: number;
  pr_rank: number | null;
  fetched_at: string;
}

export interface HillProfile {
  category: "flat" | "rolling" | "hilly" | "hill_repeat";
  totalGainM: number;
  totalLossM: number;
  gainPerKm: number;
  maxSegmentGainM: number;
  hillRepeatCount: number | null;
}

export interface LapSummary {
  lap_index: number;
  distance_m: number;
  pace_sec_per_km: number;
  elevation_gain: number | null;
  elevation_loss: number | null;
  avg_heartrate: number | null;
}

export interface ActivityAnalysisRecord {
  activity_id: number;
  run_type: string;
  run_type_detail: string | null;
  classification_confidence: string;
  hill_category: string | null;
  distance_m: number;
  moving_time_s: number;
  pace_sec_per_km: number;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  grade_adjusted_pace_sec_per_km: number | null;
  avg_heartrate: number | null;
  max_heartrate: number | null;
  lap_summaries: LapSummary[];
  similar_runs_7d: number;
  similar_runs_30d: number;
  avg_pace_similar_30d: number | null;
  pace_vs_similar_delta: number | null;
  prose_summary: string | null;
  prose_generated_at: string | null;
  detailed_analysis: string | null;
  strava_title: string | null;
  strava_description: string | null;
  analysis_generated_at: string | null;
  analyzed_at: string;
  analysis_version: number;
}

export interface TrainingContext {
  days_since_last_run: number | null;
  runs_last_7d: number;
  km_last_7d: number;
  runs_last_14d: number;
  km_last_14d: number;
  is_longest_run_30d: boolean;
  is_longest_run_7d: boolean;
  longest_run_30d_km: number | null;
  elevation_rank_30d: number | null;
  moving_time_min: number;
  trimp_7d_total: number | null;
  trimp_percentile_30d: number | null;
}

// --- Stream Analysis Types ---

export interface HrZoneDistribution {
  zone1_s: number;  // recovery (< LT1 * 0.88)
  zone2_s: number;  // aerobic (LT1 * 0.88 to LT1)
  zone3_s: number;  // tempo (LT1 to LT2)
  zone4_s: number;  // threshold (LT2 to maxHR * 0.97)
  zone5_s: number;  // VO2max / anaerobic (> maxHR * 0.97)
  total_hr_s: number;
}

export type SplitType = "negative" | "positive" | "even";

export interface PhaseSegment {
  phase: "warmup" | "work" | "recovery" | "cooldown" | "stopped";
  start_s: number;
  end_s: number;
  distance_m: number;
  avg_pace_sec_per_km: number | null;
  avg_hr: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
}

export interface DetectedInterval {
  rep_number: number;
  work_start_s: number;
  work_end_s: number;
  work_distance_m: number;
  work_avg_pace_sec_per_km: number;
  work_avg_hr: number | null;
  rest_start_s: number | null;
  rest_end_s: number | null;
  rest_distance_m: number | null;
}

export interface StreamAnalysisResult {
  // Tier 1
  hr_zones: HrZoneDistribution | null;
  cardiac_drift_pct: number | null;
  pace_variability_cv: number | null;
  split_type: SplitType | null;
  trimp: number | null;
  // Tier 2
  ngp_sec_per_km: number | null;
  fatigue_index_pct: number | null;
  cadence_drift_spm: number | null;
  efficiency_factor: number | null;
  // Tier 3
  phases: PhaseSegment[];
  intervals: DetectedInterval[];

  computed_at: string;
  stream_analysis_version: number;
}
