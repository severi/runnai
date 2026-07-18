import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toDateString, toolResult, toolError } from "../utils/format.js";
import { WEATHER_CODES } from "../utils/activity-weather.js";
import { getActivityLocation } from "../utils/activities-db.js";

interface GeocodingResult {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country: string;
  }>;
}

interface WeatherResponse {
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    windspeed_10m_max: number[];
    weathercode: number[];
  };
}

interface HourlyResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    apparent_temperature: number[];
    precipitation: number[];
    wind_speed_10m: number[];
    weather_code: number[];
  };
}

async function geocodeCity(city: string): Promise<{ lat: number; lng: number } | null> {
  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
  );
  if (!response.ok) return null;
  const data = (await response.json()) as GeocodingResult;
  if (!data.results || data.results.length === 0) return null;
  return { lat: data.results[0].latitude, lng: data.results[0].longitude };
}

function formatWeatherDay(
  date: string,
  tempMax: number,
  tempMin: number,
  precip: number,
  wind: number,
  code: number
): string {
  const desc = WEATHER_CODES[code] || `Code ${code}`;
  let line = `${date}: ${desc}, ${tempMin}°C to ${tempMax}°C`;
  if (precip > 0) line += `, ${precip}mm precipitation`;
  if (wind > 30) line += `, wind ${wind} km/h`;
  return line;
}

const DAILY_PARAMS = "temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,weathercode";
const HOURLY_PARAMS = "temperature_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code";
const HOURLY_MAX_DAYS = 3;

export const getWeatherTool = tool(
  "get_weather",
  "Fetch weather data for a location and date range. Use for historical conditions on past runs or forecasts for upcoming training. To get the weather for a specific run, pass its activity_id — this uses the run's actual recorded coordinates (do NOT guess a city for a run you have an activity_id for). Otherwise accepts coordinates (latitude/longitude) or a city name. Pass granularity='hourly' for the per-hour temperature evolution — REQUIRED when analyzing conditions over a multi-hour activity (long run, race): a daily min/max or single reading cannot describe a day where conditions evolved.",
  {
    activity_id: z.number().optional().describe("Activity ID — uses the run's recorded start coordinates. Preferred for weather on a specific run; overrides city/lat/lng"),
    latitude: z.number().optional().describe("Latitude (use with longitude, or provide city instead)"),
    longitude: z.number().optional().describe("Longitude (use with latitude, or provide city instead)"),
    city: z.string().optional().describe("City name for geocoding (e.g., 'Espoo', 'Vienna'). Used if lat/lng not provided"),
    start_date: z.string().describe("Start date in YYYY-MM-DD format"),
    end_date: z.string().optional().describe("End date in YYYY-MM-DD (defaults to start_date for single day)"),
    granularity: z.enum(["daily", "hourly"]).optional().describe("'daily' (default) = min/max per day. 'hourly' = per-hour temps/precip/wind — use for multi-hour activities and race-day timing questions. Max 3 days per hourly call"),
  },
  async ({ activity_id, latitude, longitude, city, start_date, end_date, granularity }) => {
    let lat = latitude;
    let lng = longitude;
    let resolvedLabel: string | undefined;

    // Activity coordinates take precedence — anchors to where the run actually was
    // instead of relying on a guessed city.
    if (activity_id !== undefined) {
      const activity = getActivityLocation(activity_id);
      if (!activity) {
        return toolResult(`No activity found with id ${activity_id}`, true);
      }
      if (activity.start_latitude == null || activity.start_longitude == null) {
        return toolResult(
          `Activity ${activity_id} ("${activity.name}") has no recorded coordinates; provide a city or lat/lng instead`,
          true
        );
      }
      lat = activity.start_latitude;
      lng = activity.start_longitude;
      resolvedLabel = `${activity.name} (${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E)`;
    }

    // Geocode city if no coordinates
    if ((lat === undefined || lng === undefined) && city) {
      const geo = await geocodeCity(city);
      if (!geo) {
        return toolResult(`Could not geocode city: ${city}`, true);
      }
      lat = geo.lat;
      lng = geo.lng;
    }

    if (lat === undefined || lng === undefined) {
      return toolResult("Provide latitude/longitude or a city name", true);
    }

    const endDate = end_date || start_date;

    // Decide: forecast or historical
    const today = toDateString();
    const isFuture = start_date >= today;
    const apiBase = isFuture
      ? "https://api.open-meteo.com/v1/forecast"
      : "https://archive-api.open-meteo.com/v1/archive";
    const header = isFuture ? "Weather Forecast" : "Historical Weather";
    const locationLabel = resolvedLabel || city || `${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E`;

    try {
      if (granularity === "hourly") {
        const spanDays = (Date.parse(endDate) - Date.parse(start_date)) / 86_400_000 + 1;
        if (spanDays > HOURLY_MAX_DAYS) {
          return toolResult(`Hourly granularity is limited to ${HOURLY_MAX_DAYS} days per call (requested ${spanDays}). Narrow the range or use daily.`, true);
        }
        const url = `${apiBase}?latitude=${lat}&longitude=${lng}&hourly=${HOURLY_PARAMS}&start_date=${start_date}&end_date=${endDate}&timezone=auto`;
        const response = await fetch(url);
        if (!response.ok) {
          return toolResult(`Weather API error: ${await response.text()}`, true);
        }
        const data = (await response.json()) as HourlyResponse;
        const h = data.hourly;
        if (!h?.time?.length) {
          return toolResult("No hourly weather data available for this date range", true);
        }
        const lines = h.time.map((t, i) => {
          const desc = WEATHER_CODES[h.weather_code[i]] || `Code ${h.weather_code[i]}`;
          let line = `${t.replace("T", " ")}: ${h.temperature_2m[i]}°C (feels ${h.apparent_temperature[i]}°C), ${desc}`;
          if (h.precipitation[i] > 0) line += `, ${h.precipitation[i]}mm`;
          if (h.wind_speed_10m[i] > 30) line += `, wind ${h.wind_speed_10m[i]} km/h`;
          return line;
        });
        return toolResult(`${header} (hourly, local time) — ${locationLabel}\nNote: temps are shaded-air; full sun feels several degrees hotter.\n${lines.join("\n")}`);
      }

      const url = `${apiBase}?latitude=${lat}&longitude=${lng}&daily=${DAILY_PARAMS}&start_date=${start_date}&end_date=${endDate}&timezone=auto`;
      const response = await fetch(url);
      if (!response.ok) {
        const text = await response.text();
        return toolResult(`Weather API error: ${text}`, true);
      }

      const data = (await response.json()) as WeatherResponse;
      const { daily } = data;

      if (!daily || !daily.time || daily.time.length === 0) {
        return toolResult("No weather data available for this date range", true);
      }

      const lines = daily.time.map((date, i) =>
        formatWeatherDay(
          date,
          daily.temperature_2m_max[i],
          daily.temperature_2m_min[i],
          daily.precipitation_sum[i],
          daily.windspeed_10m_max[i],
          daily.weathercode[i]
        )
      );

      return toolResult(`${header} — ${locationLabel}\n${lines.join("\n")}`);
    } catch (error) {
      return toolError(error);
    }
  }
);
