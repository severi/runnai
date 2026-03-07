import { toDateString } from "./format.js";

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
 */
export async function fetchActivityWeather(
  activityId: number,
  lat: number,
  lng: number,
  startDateLocal: string,
  movingTimeS: number
): Promise<ActivityWeather | null> {
  const startDate = new Date(startDateLocal);
  const date = toDateString(startDate);
  const startHour = startDate.getHours();
  const durationHours = Math.ceil(movingTimeS / 3600);
  const endHour = Math.min(startHour + durationHours, 23);

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&start_date=${date}&end_date=${date}&timezone=auto`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as HourlyWeatherResponse;
    const { hourly } = data;
    if (!hourly?.time?.length) return null;

    // Extract hours matching the activity window
    const indices: number[] = [];
    for (let i = 0; i < hourly.time.length; i++) {
      const hour = new Date(hourly.time[i]).getHours();
      if (hour >= startHour && hour <= endHour) {
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

    return {
      activity_id: activityId,
      temp_c: Math.round(avg(temps) * 10) / 10,
      feels_like_c: Math.round(avg(feelsLike) * 10) / 10,
      humidity_pct: Math.round(avg(humidity)),
      wind_speed_kmh: Math.round(avg(wind) * 10) / 10,
      wind_gust_kmh: Math.round(Math.max(...gusts) * 10) / 10,
      precipitation_mm: Math.round(precip.reduce((s, v) => s + v, 0) * 10) / 10,
      weather_code: dominantCode,
      weather_description: WEATHER_CODES[dominantCode] ?? `Code ${dominantCode}`,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
