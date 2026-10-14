/**
 * Pure translation from Garmin Connect / FIT shapes into the Strava-shaped
 * records the rest of the app already speaks. Everything downstream — run
 * classification, HR-session and cross-training routing, strength handling,
 * best efforts — keys on Strava's type vocabulary and stream layout, so the
 * Garmin source maps INTO that vocabulary rather than teaching every consumer
 * a second one.
 */
import type { StravaActivity, StravaLap, StravaBestEffort, ActivityStream } from "../types/index.js";

/** One activity as emitted by `garmin_fit.py sync`. */
export interface GarminSyncItem {
  summary: GarminSummary;
  gear_uuid: string | null;
  fit_path: string | null;
  fit_error: string | null;
}

/** The subset of Garmin's activity-list summary we read. */
export interface GarminSummary {
  activityId: number;
  activityName?: string | null;
  description?: string | null;
  activityType?: { typeKey?: string | null } | null;
  eventType?: { typeKey?: string | null } | null;
  startTimeGMT?: string | null;
  startTimeLocal?: string | null;
  distance?: number | null;
  duration?: number | null;
  movingDuration?: number | null;
  elapsedDuration?: number | null;
  elevationGain?: number | null;
  averageSpeed?: number | null;
  maxSpeed?: number | null;
  averageHR?: number | null;
  maxHR?: number | null;
  averageRunningCadenceInStepsPerMinute?: number | null;
  averageBikingCadenceInRevPerMinute?: number | null;
  avgPower?: number | null;
  normPower?: number | null;
  maxPower?: number | null;
  startLatitude?: number | null;
  startLongitude?: number | null;
}

interface MappedType {
  type: string;
  sport_type: string;
  /** Indoor by definition, regardless of GPS. */
  indoor?: boolean;
}

const RUN: MappedType = { type: "Run", sport_type: "Run" };
const RIDE: MappedType = { type: "Ride", sport_type: "Ride" };
// Court, racket and team sports sit under Strava's generic `Workout` type with
// the specific sport in sport_type — that is how Strava stored them, and
// isHrSessionCandidate keys on sport_type.
const court = (sport_type: string): MappedType => ({ type: "Workout", sport_type, indoor: true });

const GARMIN_TYPE_MAP: Record<string, MappedType> = {
  running: RUN,
  street_running: RUN,
  track_running: RUN,
  ultra_run: RUN,
  obstacle_run: RUN,
  trail_running: { type: "Run", sport_type: "TrailRun" },
  treadmill_running: { ...RUN, indoor: true },
  indoor_running: { ...RUN, indoor: true },
  virtual_run: { type: "VirtualRun", sport_type: "VirtualRun", indoor: true },

  cycling: RIDE,
  road_biking: RIDE,
  track_cycling: RIDE,
  recumbent_cycling: RIDE,
  mountain_biking: { type: "Ride", sport_type: "MountainBikeRide" },
  enduro_mtb: { type: "Ride", sport_type: "MountainBikeRide" },
  downhill_biking: { type: "Ride", sport_type: "MountainBikeRide" },
  gravel_cycling: { type: "Ride", sport_type: "GravelRide" },
  cyclocross: { type: "Ride", sport_type: "GravelRide" },
  indoor_cycling: { ...RIDE, indoor: true },
  virtual_ride: { type: "VirtualRide", sport_type: "VirtualRide", indoor: true },
  e_bike_fitness: { type: "EBikeRide", sport_type: "EBikeRide" },
  e_bike_mountain: { type: "EBikeRide", sport_type: "EMountainBikeRide" },
  e_enduro_mtb: { type: "EBikeRide", sport_type: "EMountainBikeRide" },
  hand_cycling: { type: "Handcycle", sport_type: "Handcycle" },
  indoor_hand_cycling: { type: "Handcycle", sport_type: "Handcycle", indoor: true },

  walking: { type: "Walk", sport_type: "Walk" },
  casual_walking: { type: "Walk", sport_type: "Walk" },
  speed_walking: { type: "Walk", sport_type: "Walk" },
  hiking: { type: "Hike", sport_type: "Hike" },
  rucking: { type: "Hike", sport_type: "Hike" },
  mountaineering: { type: "Hike", sport_type: "Hike" },
  snow_shoe_ws: { type: "Snowshoe", sport_type: "Snowshoe" },

  swimming: { type: "Swim", sport_type: "Swim" },
  lap_swimming: { type: "Swim", sport_type: "Swim", indoor: true },
  open_water_swimming: { type: "Swim", sport_type: "Swim" },

  strength_training: { type: "WeightTraining", sport_type: "WeightTraining", indoor: true },
  hiit: { type: "Workout", sport_type: "Workout", indoor: true },
  indoor_cardio: { type: "Workout", sport_type: "Workout", indoor: true },
  fitness_equipment: { type: "Workout", sport_type: "Workout", indoor: true },
  yoga: { type: "Yoga", sport_type: "Yoga", indoor: true },
  pilates: { type: "Workout", sport_type: "Pilates", indoor: true },
  elliptical: { type: "Elliptical", sport_type: "Elliptical", indoor: true },
  stair_climbing: { type: "StairStepper", sport_type: "StairStepper", indoor: true },
  indoor_rowing: { type: "Rowing", sport_type: "Rowing", indoor: true },
  rowing_v2: { type: "Rowing", sport_type: "Rowing" },
  kayaking_v2: { type: "Kayaking", sport_type: "Kayaking" },
  whitewater_rafting_kayaking: { type: "Kayaking", sport_type: "Kayaking" },
  paddling_v2: { type: "Canoeing", sport_type: "Canoeing" },
  stand_up_paddleboarding_v2: { type: "StandUpPaddling", sport_type: "StandUpPaddling" },
  surfing_v2: { type: "Surfing", sport_type: "Surfing" },

  cross_country_skiing_ws: { type: "NordicSki", sport_type: "NordicSki" },
  skate_skiing_ws: { type: "NordicSki", sport_type: "NordicSki" },
  backcountry_skiing: { type: "BackcountrySki", sport_type: "BackcountrySki" },
  resort_skiing: { type: "AlpineSki", sport_type: "AlpineSki" },
  resort_skiing_snowboarding_ws: { type: "AlpineSki", sport_type: "AlpineSki" },
  resort_snowboarding: { type: "Snowboard", sport_type: "Snowboard" },
  inline_skating: { type: "InlineSkate", sport_type: "InlineSkate" },
  skating_ws: { type: "IceSkate", sport_type: "IceSkate" },
  rock_climbing: { type: "RockClimbing", sport_type: "RockClimbing" },
  indoor_climbing: { type: "RockClimbing", sport_type: "RockClimbing", indoor: true },
  bouldering: { type: "RockClimbing", sport_type: "RockClimbing", indoor: true },
  golf: { type: "Golf", sport_type: "Golf" },

  basketball: court("Basketball"),
  tennis: court("Tennis"),
  tennis_v2: court("Tennis"),
  badminton: court("Badminton"),
  paddelball: court("Padel"),
  padel: court("Padel"),
  pickleball: court("Pickleball"),
  squash: court("Squash"),
  table_tennis: court("TableTennis"),
  racquetball: court("Racquetball"),
  volleyball: court("Volleyball"),
  soccer: court("Soccer"),
  ice_hockey: court("IceHockey"),
  rugby: court("Rugby"),
  lacrosse: court("Lacrosse"),
};

/** Garmin typeKey → Strava type/sport_type. Unknown types land in `Workout`. */
export function mapGarminType(typeKey: string | null | undefined): MappedType {
  return GARMIN_TYPE_MAP[(typeKey ?? "").toLowerCase()] ?? { type: "Workout", sport_type: "Workout" };
}

const RUN_TYPES = new Set(["Run", "VirtualRun"]);
const RIDE_TYPES = new Set(["Ride", "VirtualRide", "EBikeRide", "Handcycle"]);
const FOOT_TYPES = new Set(["Run", "VirtualRun", "Walk", "Hike", "Snowshoe"]);

/** Garmin's "2026-10-13 05:19:36" (or ISO with ".0") → Strava's "2026-10-13T05:19:36Z". */
export function toStravaTimestamp(garmin: string | null | undefined): string {
  if (!garmin) return "";
  return garmin.trim().replace(" ", "T").replace(/\.\d+$/, "").replace(/Z$/, "") + "Z";
}

const num = (v: number | null | undefined): number | undefined => (v == null || Number.isNaN(v) ? undefined : v);

/** Garmin activity-list summary → the StravaActivity shape upsertActivities stores. */
export function garminSummaryToActivity(s: GarminSummary, gearUuid: string | null = null): StravaActivity {
  const mapped = mapGarminType(s.activityType?.typeKey);
  const isRun = RUN_TYPES.has(mapped.type);
  const isRide = RIDE_TYPES.has(mapped.type);
  const distance = s.distance ?? 0;
  const elapsed = Math.round(s.elapsedDuration ?? s.duration ?? 0);
  // Garmin's movingDuration on a session without distance counts only active
  // set time on a lift and 0 on a court session; Strava reports the whole
  // session there, and the HR-session and strength reads assume that.
  const moving = distance > 0 && (s.movingDuration ?? 0) > 0 ? Math.round(s.movingDuration!) : elapsed;
  const hasGps = s.startLatitude != null && s.startLongitude != null;

  // Strava flags races per family: 1 for runs, 11 for rides.
  const isRace = s.eventType?.typeKey === "race";
  const workoutType = isRace ? (isRide ? 11 : isRun ? 1 : undefined) : undefined;

  // Strava's foot-sport cadence is per leg (half the step rate); Garmin reports
  // steps/min. Halve it so stored cadence means the same thing for every row.
  const cadence = FOOT_TYPES.has(mapped.type)
    ? num(s.averageRunningCadenceInStepsPerMinute) != null ? s.averageRunningCadenceInStepsPerMinute! / 2 : undefined
    : isRide ? num(s.averageBikingCadenceInRevPerMinute) : undefined;

  const activity: StravaActivity = {
    id: s.activityId,
    name: s.activityName ?? "",
    type: mapped.type,
    sport_type: mapped.sport_type,
    start_date: toStravaTimestamp(s.startTimeGMT),
    start_date_local: toStravaTimestamp(s.startTimeLocal),
    distance,
    moving_time: moving,
    elapsed_time: elapsed,
    total_elevation_gain: s.elevationGain ?? 0,
    average_speed: s.averageSpeed ?? (moving > 0 ? distance / moving : 0),
    max_speed: s.maxSpeed ?? 0,
    average_heartrate: num(s.averageHR),
    max_heartrate: num(s.maxHR),
    average_cadence: cadence,
    workout_type: workoutType,
    description: s.description || undefined,
    trainer: !!mapped.indoor || !hasGps,
    start_latlng: hasGps ? [s.startLatitude!, s.startLongitude!] : null,
    gear_id: gearUuid ? garminGearId(gearUuid) : null,
    source: "garmin",
  };

  // Power fields mirror Strava's summary, which carries them for rides only.
  if (isRide && num(s.avgPower) != null) {
    activity.average_watts = s.avgPower!;
    activity.weighted_average_watts = num(s.normPower);
    activity.max_watts = num(s.maxPower);
    activity.kilojoules = Math.round((s.avgPower! * moving) / 1000);
    activity.device_watts = true;
  }
  return activity;
}

/** Garmin gear ids are namespaced so they never collide with Strava's "g123". */
export function garminGearId(uuid: string): string {
  return `garmin:${uuid}`;
}

// --- FIT → streams / laps ---

/** The subset of a fit-file-parser record we read. */
export interface FitRecord {
  timestamp?: string | Date;
  distance?: number;
  heart_rate?: number;
  enhanced_altitude?: number;
  altitude?: number;
  cadence?: number;
  power?: number;
  position_lat?: number;
  position_long?: number;
}

export interface FitLap {
  start_time?: string | Date;
  timestamp?: string | Date;
  total_elapsed_time?: number;
  total_timer_time?: number;
  total_distance?: number;
  enhanced_avg_speed?: number;
  avg_speed?: number;
  enhanced_max_speed?: number;
  max_speed?: number;
  avg_heart_rate?: number;
  max_heart_rate?: number;
}

const ms = (t: string | Date | undefined): number => (t == null ? NaN : new Date(t).getTime());

/**
 * One column of the stream, forward-filled so every array lines up with
 * `time`. A column with no values at all is omitted (undefined), matching
 * Strava, which leaves out streams the device never recorded.
 */
function column<T>(records: FitRecord[], get: (r: FitRecord) => T | undefined): T[] | undefined {
  const firstDefined = records.find(r => get(r) != null);
  if (!firstDefined) return undefined;
  let last = get(firstDefined) as T;
  return records.map(r => {
    const v = get(r);
    if (v != null) last = v;
    return last;
  });
}

/**
 * Grade (%) from altitude over distance, smoothed across a ±5-sample window.
 * Strava ships `grade_smooth`; FIT has no equivalent, and the run analysis
 * uses it for grade-adjusted pace, so it is derived here.
 */
export function computeGrade(distance: number[], altitude: number[]): number[] {
  const n = Math.min(distance.length, altitude.length);
  const out: number[] = new Array(n).fill(0);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 5);
    const hi = Math.min(n - 1, i + 5);
    const dd = distance[hi] - distance[lo];
    if (dd >= 5) {
      prev = Math.max(-45, Math.min(45, ((altitude[hi] - altitude[lo]) / dd) * 100));
    }
    out[i] = Math.round(prev * 10) / 10;
  }
  return out;
}

/** FIT records → the ActivityStream layout Strava's streams endpoint returns. */
export function fitRecordsToStream(rawRecords: FitRecord[]): ActivityStream | null {
  const records = rawRecords.filter(r => !Number.isNaN(ms(r.timestamp)));
  if (records.length === 0) return null;
  const t0 = ms(records[0].timestamp);

  const distance = column(records, r => r.distance);
  const altitude = column(records, r => r.enhanced_altitude ?? r.altitude);
  const latlng = column(records, r =>
    r.position_lat != null && r.position_long != null ? ([r.position_lat, r.position_long] as [number, number]) : undefined
  );

  const stream: ActivityStream = {
    time: records.map(r => Math.round((ms(r.timestamp) - t0) / 1000)),
    distance,
    heartrate: column(records, r => r.heart_rate),
    altitude,
    cadence: column(records, r => r.cadence),
    watts: column(records, r => r.power),
    latlng,
  };
  if (distance && altitude) stream.grade_smooth = computeGrade(distance, altitude);
  return stream;
}

/**
 * FIT laps → Strava laps. Strava's start/end indices point into the stream,
 * so they are resolved against the record timestamps the stream was built from.
 */
export function fitLapsToStravaLaps(laps: FitLap[], rawRecords: FitRecord[]): StravaLap[] {
  const times = rawRecords.map(r => ms(r.timestamp)).filter(t => !Number.isNaN(t));
  if (times.length === 0) return [];
  const indexAtOrAfter = (t: number): number => {
    const i = times.findIndex(x => x >= t);
    return i === -1 ? times.length - 1 : i;
  };

  return laps.map((lap, i) => {
    const start = ms(lap.start_time);
    const elapsed = lap.total_elapsed_time ?? 0;
    const moving = lap.total_timer_time ?? elapsed;
    const distance = lap.total_distance ?? 0;
    const startIndex = indexAtOrAfter(start);
    const nextStart = i + 1 < laps.length ? ms(laps[i + 1].start_time) : NaN;
    const endIndex = Number.isNaN(nextStart)
      ? times.length - 1
      : Math.max(startIndex, indexAtOrAfter(nextStart) - 1);
    return {
      id: i + 1,
      lap_index: i + 1,
      distance,
      elapsed_time: Math.round(elapsed),
      moving_time: Math.round(moving),
      average_speed: lap.enhanced_avg_speed ?? lap.avg_speed ?? (moving > 0 ? distance / moving : 0),
      max_speed: lap.enhanced_max_speed ?? lap.max_speed ?? 0,
      average_heartrate: lap.avg_heart_rate,
      max_heartrate: lap.max_heart_rate,
      start_index: startIndex,
      end_index: endIndex,
    };
  });
}

// --- Best efforts ---

/** Strava's best-effort names and distances; the names map onto our DB names. */
export const BEST_EFFORT_DISTANCES: Array<{ name: string; meters: number }> = [
  { name: "400m", meters: 400 },
  { name: "1/2 mile", meters: 805 },
  { name: "1K", meters: 1000 },
  { name: "1 mile", meters: 1609 },
  { name: "2 mile", meters: 3219 },
  { name: "5K", meters: 5000 },
  { name: "10K", meters: 10000 },
  { name: "15K", meters: 15000 },
  { name: "10 mile", meters: 16093 },
  { name: "20K", meters: 20000 },
  { name: "Half-Marathon", meters: 21097 },
  { name: "30K", meters: 30000 },
  { name: "Marathon", meters: 42195 },
];

/**
 * Fastest stretch covering each standard distance, from the stream — what
 * Strava computes server-side and the Garmin source has to do itself.
 * Returned in Strava's shape so convertStravaBestEfforts stores it unchanged.
 * Effort ids are derived from the activity id so re-syncs upsert, not duplicate.
 */
export function computeBestEfforts(
  activityId: number,
  startDateLocal: string,
  stream: ActivityStream
): StravaBestEffort[] {
  const d = stream.distance;
  const t = stream.time;
  if (!d?.length || d.length !== t.length) return [];
  const total = d[d.length - 1] - d[0];

  const efforts: StravaBestEffort[] = [];
  BEST_EFFORT_DISTANCES.forEach(({ name, meters }, k) => {
    if (total < meters) return;
    let best = Infinity;
    let bestStart = 0;
    let bestEnd = 0;
    let i = 0;
    for (let j = 0; j < d.length; j++) {
      // Advance the start while the window would still cover the distance.
      while (i + 1 < j && d[j] - d[i + 1] >= meters) i++;
      if (d[j] - d[i] >= meters && t[j] - t[i] < best) {
        best = t[j] - t[i];
        bestStart = i;
        bestEnd = j;
      }
    }
    if (!Number.isFinite(best) || best <= 0) return;
    efforts.push({
      id: activityId * 100 + k,
      name,
      elapsed_time: best,
      moving_time: best,
      distance: meters,
      start_date_local: startDateLocal,
      start_index: bestStart,
      end_index: bestEnd,
      pr_rank: null,
    });
  });
  return efforts;
}
