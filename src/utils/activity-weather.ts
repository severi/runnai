export const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};
import type { ActivityWeather } from "./activities-db.js";

interface HourlyWeatherResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    apparent_temperature: number[];
    precipitation: number[];
    wind_speed_10m: number[];
    wind_gusts_10m: number[];
    weather_code: number[];
  };
}

/**
 * Fetch hourly weather for an activity's time window from Open-Meteo archive API.
 * Returns null if the fetch fails or no data is available.
 *
 * The stored record keeps the window average AND the min/max + per-hour profile:
 * on a multi-hour activity the average alone is a compositional artifact (a
 * 17→30°C race day averages to a misleading "25°C").
 *
 * @param durationS - Activity duration in seconds. Pass ELAPSED time, not moving
 *   time — conditions act on the athlete during stops too, and an ultra can have
 *   hours of difference between the two.
 */
export async function fetchActivityWeather(
  activityId: number,
  lat: number,
  lng: number,
  startDateLocal: string,
  durationS: number
): Promise<ActivityWeather | null> {
  // start_date_local is wall-clock local time, but Strava serializes it with a "Z"
  // (e.g. "2026-06-21T14:07:56Z"). Parsing via new Date() reads it as UTC and any
  // later .getHours() re-localizes to the *machine* timezone, shifting the weather
  // window by the host's UTC offset. Open-Meteo's hourly series (timezone=auto) is
  // in the run's local time, so we work on naive local timestamps throughout,
  // using Date.UTC purely as timezone-free calendar arithmetic (for windows that
  // cross midnight).
  const date = startDateLocal.slice(0, 10);
  const startHour = Number(startDateLocal.slice(11, 13));
  const durationHours = Math.ceil(durationS / 3600);

  const [y, mo, d] = date.split("-").map(Number);
  const startMs = Date.UTC(y, mo - 1, d, startHour);
  const endMs = startMs + durationHours * 3_600_000;
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16); // "YYYY-MM-DDTHH:00"
  const startStamp = stamp(startMs);
  const endStamp = stamp(endMs);
  const endDate = endStamp.slice(0, 10);

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&start_date=${date}&end_date=${endDate}&timezone=auto`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as HourlyWeatherResponse;
    const { hourly } = data;
    if (!hourly?.time?.length) return null;

    // Extract hours inside the activity window. hourly.time entries are naive
    // local-time ISO strings ("2026-06-21T14:00"), so lexicographic comparison
    // is chronological — no Date parsing, no host-timezone contamination.
    const indices: number[] = [];
    for (let i = 0; i < hourly.time.length; i++) {
      if (hourly.time[i] >= startStamp && hourly.time[i] <= endStamp) {
        indices.push(i);
      }
    }

    if (indices.length === 0) return null;

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const vals = (arr: number[]) => indices.map(i => arr[i]);

    const temps = vals(hourly.temperature_2m);
    const humidity = vals(hourly.relative_humidity_2m);
    const feelsLike = vals(hourly.apparent_temperature);
    const precip = vals(hourly.precipitation);
    const wind = vals(hourly.wind_speed_10m);
    const gusts = vals(hourly.wind_gusts_10m);
    const codes = vals(hourly.weather_code);

    // Dominant weather code: most frequent
    const codeCounts = new Map<number, number>();
    for (const c of codes) {
      codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1);
    }
    const dominantCode = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const round1 = (v: number) => Math.round(v * 10) / 10;

    return {
      activity_id: activityId,
      temp_c: round1(avg(temps)),
      temp_min_c: round1(Math.min(...temps)),
      temp_max_c: round1(Math.max(...temps)),
      feels_like_c: round1(avg(feelsLike)),
      humidity_pct: Math.round(avg(humidity)),
      wind_speed_kmh: round1(avg(wind)),
      wind_gust_kmh: round1(Math.max(...gusts)),
      precipitation_mm: round1(precip.reduce((s, v) => s + v, 0)),
      weather_code: dominantCode,
      weather_description: WEATHER_CODES[dominantCode] ?? `Code ${dominantCode}`,
      hourly: indices.map((idx, j) => ({
        time: hourly.time[idx],
        temp_c: round1(temps[j]),
        feels_like_c: round1(feelsLike[j]),
        precipitation_mm: round1(precip[j]),
        wind_speed_kmh: round1(wind[j]),
      })),
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
