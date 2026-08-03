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
    retired?: boolean;
  }>;
}

/** A pair of gear (shoes) as persisted in the local `gear` table. */
export interface GearRecord {
  id: string;            // Strava gear id, e.g. "g26927403"
  name: string;
  is_primary: boolean;
  distance_m: number;    // Strava's authoritative lifetime distance, in meters
  retired: boolean;
  synced_at: string;
}

/** Gear plus locally-derived usage (from synced activities attributed via gear_id). */
export interface GearWithUsage extends GearRecord {
  runs_in_db: number;        // synced runs attributed to this gear
  km_in_db: number;          // distance of those synced runs, km
  last_used: string | null;  // start_date_local of the most recent attributed run
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
  gear_id?: string | null;
}

export interface SyncResult {
  success: boolean;
  activities?: StravaActivity[];
  allActivities?: StravaActivity[];
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

// --- Training Zones (HR + Pace, single source of truth) ---

export interface PaceRange {
  /** Faster end of the range, sec/km. */
  min_sec: number;
  /** Slower end of the range, sec/km. */
  max_sec: number;
}

export type PaceZoneName = "recovery" | "easy" | "marathon" | "tempo" | "threshold";

export interface PaceZones {
  source: "lactate_test" | "derived_from_training" | "manual";
  recovery: PaceRange;
  easy: PaceRange;
  marathon: PaceRange;
  tempo: PaceRange;
  threshold: PaceRange;
  /** ISO date the zones were last updated. */
  updated_at: string;
  /** Free-text description of how these were derived. */
  derivation_notes: string;
}

export interface TrainingZones {
  hr: HrZones & { updated_at: string };
  pace: PaceZones | null;
}

// --- Fitness Drift Detection ---

export type FitnessDriftDirection = "improving" | "stable" | "declining";
export type FitnessDriftConfidence = "high" | "medium" | "low";

export interface FitnessDriftSignal {
  /** Median observed easy pace (sec/km) at Z2 HR from recent training. */
  observed_easy_pace_sec: number;
  /** Sample count used for the observation. */
  sample_count: number;
  /** First and last sample dates (YYYY-MM-DD). */
  date_range: { start: string; end: string };
  /** The currently stored easy pace range from training-zones.json. */
  stored_easy_pace: PaceRange | null;
  /** Median observed minus midpoint of stored range, sec/km. Negative = faster now. */
  delta_sec_per_km: number | null;
  direction: FitnessDriftDirection;
  confidence: FitnessDriftConfidence;
  /** True only when confidence === "high" — the coach should surface this proactively. */
  should_prompt: boolean;
  /** One-line human-readable explanation. */
  summary: string;
}

// --- Zone History (audit trail) ---

export interface ZoneHistoryEntry {
  /** ISO date the change happened. */
  date: string;
  type: "hr" | "pace";
  source: HrZones["source"] | PaceZones["source"];
  /** The new values written. Shape depends on type. */
  values: Record<string, unknown>;
  /** Supporting context — sample count, prior values, detector confidence, etc. */
  basis?: Record<string, unknown>;
  /** Who approved the change ("athlete", "automatic", "lab_test", etc.) */
  approved_by?: string;
  /** Free-text note. */
  notes?: string;
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
  /**
   * gain - loss. Recovering the terrain shape of a run used to mean subtracting
   * fifteen pairs of numbers by hand, so in practice nobody did it and the whole
   * run got read off the totals — which is how a 14.6km run that opened net -20m
   * and closed net +22m was filed as flat-and-fading (activity 19569913259).
   */
  net_elevation_m: number | null;
  /** Net grade over the lap, percent. net_elevation_m / distance_m * 100. */
  avg_grade_pct: number | null;
  /**
   * Minetti grade-adjusted pace for the lap. Compare THIS across laps before
   * calling a pace change a fade: raw lap pace on rolling terrain mostly tracks
   * the hills.
   */
  grade_adjusted_pace_sec_per_km: number | null;
  avg_heartrate: number | null;
  peak_heartrate: number | null;
}

export interface ActivityAnalysisRecord {
  activity_id: number;
  run_type: RunType;
  run_type_detail: string | null;
  classification_confidence: "high" | "medium" | "low";
  hill_category: "flat" | "rolling" | "hilly" | "hill_repeat" | null;
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

export interface HrTrend {
  /** Shape of HR evolution within the segment */
  pattern: "stable" | "step_then_plateau" | "linear_drift" | "variable";
  /** Avg HR in the initial portion before settling (bpm) */
  initial_hr: number;
  /** Avg HR after settling (bpm) */
  settled_hr: number;
  /** Km into segment where HR reached the plateau (0 = immediate) */
  settle_km: number;
  /** Min/max of per-km HR averages after settling */
  plateau_range: [number, number];
  /** Linear regression slope across full segment (bpm per km) */
  drift_bpm_per_km: number;
}

export interface PhaseSegment {
  phase: "warmup" | "work" | "recovery" | "cooldown" | "stopped";
  start_s: number;
  end_s: number;
  distance_m: number;
  avg_pace_sec_per_km: number | null;
  avg_hr: number | null;
  peak_hr: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  /** HR trend analysis for work phases >= 2km with HR data */
  hr_trend: HrTrend | null;
}

export interface DetectedInterval {
  rep_number: number;
  work_start_s: number;
  work_end_s: number;
  work_distance_m: number;
  work_avg_pace_sec_per_km: number;
  work_avg_hr: number | null;
  /** Max HR observed during the work segment. */
  work_peak_hr: number | null;
  /**
   * Max HR observed in [work_start_s, work_end_s + 15s]. Cardiac response lags
   * effort by 10–20s, so on short reps (<90s) HR often peaks just after the
   * rep ends. This is the more honest effort indicator on short intervals;
   * `work_avg_hr` systematically understates because most of the rep is the
   * ramp-up phase.
   */
  work_peak_hr_lagged: number | null;
  rest_start_s: number | null;
  rest_end_s: number | null;
  rest_distance_m: number | null;
}

// --- Plan Compliance Types ---

export type ComplianceStatus = "completed" | "missed" | "upcoming";

export interface ComplianceActivity {
  id: number;
  name: string;
  distance_km: number;
  pace_sec_per_km: number;
  run_type: string | null;
  start_date_local: string;
  weekday: string;          // Full weekday name of start_date_local (e.g. "Saturday"). Authoritative — do not re-derive.
}

export interface ComplianceEntry {
  planned: {
    date: string;          // "YYYY-MM-DD"
    weekday: string;       // Full weekday name of the planned date (e.g. "Tuesday"). Authoritative — do not re-derive.
    // Calendar days from today to this date (0 = today, positive = future, negative = past).
    // Authoritative for any "N days out/until/ago" claim — the gap between two sessions is
    // the difference of their values. Never derive day distances mentally.
    daysFromToday: number;
    sessionName: string;
    details: string;
    weekNumber: number;
  };
  actual: ComplianceActivity | null;
  // Additional same-day runs beyond `actual` (the "primary" longest run).
  // Empty when 0 or 1 runs on the planned date. Ordered by start_date_local ascending.
  extras: ComplianceActivity[];
  status: ComplianceStatus;
  // 1-based position among COMPLETED runs this week, in date order (null if not completed).
  // Use this for "run N of the week" claims — never count plan rows or list positions.
  completedRunIndex: number | null;
}

export interface WeeklyComplianceResult {
  weekNumber: number;
  planSlug: string;
  entries: ComplianceEntry[];
  summary: {
    completed: number;
    missed: number;
    upcoming: number;
    total: number;
    completedKm: number;
    plannedKm: number | null;
  };
}

/**
 * Signed grade classification. Thresholds (%): descent < -1, flat -1..+1,
 * gentle_up +1..+3, moderate_up +3..+6, steep_up > +6.
 */
export type GradeBand = "descent" | "flat" | "gentle_up" | "moderate_up" | "steep_up";

/** Walk seconds accumulated per grade band (per-sample, not per-segment). */
export type GradeBandSeconds = Record<GradeBand, number>;

/** A surfaced walk or paused-watch segment with its location. */
export interface GaitSegment {
  kind: "walk" | "pause";
  /** Distance into the run where the segment starts (km). */
  start_km: number;
  duration_s: number;
  /** Avg grade over the segment (%). Null for pauses or when grade is absent. */
  avg_grade_pct: number | null;
  /**
   * Signed grade band from the segment's avg grade. A binary climb/flat label
   * hid gentle 1-3% climbs and downhills inside "flat" — bands keep them apart.
   * Null for pauses or when grade is unavailable.
   */
  grade_band: GradeBand | null;
}

/**
 * Run/walk/pause decomposition for a run, with run-only pacing metrics.
 *
 * Exists so a back-half slowdown caused by more walking (terrain, fuel stops)
 * is not misread as a running fade. The headline check is `split_driver`:
 * "walking" means moving pace fell but the running held steady.
 */
export interface MovementBreakdown {
  run_s: number;
  walk_s: number;
  pause_s: number;
  /** Walk time as a share of moving time (run+walk), percent. */
  walk_pct: number;
  /**
   * Split type on running samples only (walks/pauses excluded), computed on
   * grade-adjusted effort speed — a downhill start or uphill finish does not
   * register here as a split.
   */
  run_only_split_type: SplitType | null;
  /**
   * Fatigue index (% effort-speed drop, last 25% vs first 75%) on running
   * samples only. Grade-adjusted, as with run_only_split_type.
   */
  run_only_fatigue_index_pct: number | null;
  /**
   * What drove any back-half slowdown:
   * - "none": nothing slowed — neither moving pace nor run-only pace fell (grade-adjusted)
   * - "running": no walk-driven slowdown (continuous run, or running itself faded with little walking)
   * - "walking": moving pace fell but run-only pace held — slowdown is walk breaks, not a fade
   * - "mixed": running faded AND walking grew
   *
   * "none" is not a formality: it is the only value that lets a fade claim be
   * falsified on a walk-free run. Never read "running" as evidence a fade
   * happened — it means walking did not cause the slowdown, nothing more.
   */
  split_driver: "none" | "running" | "walking" | "mixed" | null;
  /** Walk share (percent of moving time) in [first half, second half] by distance. */
  walk_share_by_half: [number, number];
  /**
   * Time-weighted avg HR over running samples only. On a run-walk session the
   * whole-run avg HR is a compositional artifact (walking deflates it) — this
   * is the number that describes the actual running effort. Null without HR.
   */
  run_avg_hr: number | null;
  /** Time-weighted avg HR over walking samples only. Null without HR or walking. */
  walk_avg_hr: number | null;
  /** Run-only avg HR per distance half — exposes drift within the running itself. */
  run_avg_hr_by_half: [number | null, number | null];
  /**
   * Walk time per signed grade band, whole run — answers "how much of the
   * walking was actually on climbs?" natively. Per-sample accumulation, so a
   * walk spanning an up-then-down roller doesn't average away. Null without grade.
   */
  walk_grade_band_s: GradeBandSeconds | null;
  /** Walk time per grade band in [first half, second half] by distance — walking spreading to flats/descents late is a fatigue/fuel fingerprint. */
  walk_grade_band_s_by_half: [GradeBandSeconds, GradeBandSeconds] | null;
  /** Walk segments (deliberate/terrain), >= 20s, tagged climb vs flat. */
  walks: GaitSegment[];
  /** Paused-watch gaps, >= 10s. Distinct from walking. */
  pauses: GaitSegment[];
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
  /** Run/walk/pause decomposition. Null when run too short for segmentation. */
  movement: MovementBreakdown | null;
  /**
   * Elevation totals from the device altitude stream (smoothed + hysteresis).
   * Consistent algorithm across runs — prefer over the API's DEM-smoothed
   * total_elevation_gain, whose intensity varies per upload. Null without altitude.
   */
  elevation_stream: { gain_m: number; loss_m: number } | null;

  computed_at: string;
  stream_analysis_version: number;
}
