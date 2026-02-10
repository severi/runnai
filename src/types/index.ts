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

export type RunType = "easy" | "tempo" | "intervals" | "fartlek" | "long_run" | "race" | "recovery" | "threshold" | "progression" | "unknown";

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
