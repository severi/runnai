import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toDateString, toolResult, toolError } from "../utils/format.js";

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

export const getWeatherTool = tool(
  "get_weather",
  "Fetch weather data for a location and date range. Use for historical conditions on past runs or forecasts for upcoming training. Accepts either coordinates (latitude/longitude) or a city name.",
  {
    latitude: z.number().optional().describe("Latitude (use with longitude, or provide city instead)"),
    longitude: z.number().optional().describe("Longitude (use with latitude, or provide city instead)"),
    city: z.string().optional().describe("City name for geocoding (e.g., 'Espoo', 'Vienna'). Used if lat/lng not provided"),
    start_date: z.string().describe("Start date in YYYY-MM-DD format"),
    end_date: z.string().optional().describe("End date in YYYY-MM-DD (defaults to start_date for single day)"),
  },
  async ({ latitude, longitude, city, start_date, end_date }) => {
    let lat = latitude;
    let lng = longitude;

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

    let url: string;
    if (isFuture) {
      url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=${DAILY_PARAMS}&start_date=${start_date}&end_date=${endDate}&timezone=auto`;
    } else {
      url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&daily=${DAILY_PARAMS}&start_date=${start_date}&end_date=${endDate}&timezone=auto`;
    }

    try {
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

      const header = isFuture ? "Weather Forecast" : "Historical Weather";
      const locationLabel = city || `${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E`;
      return toolResult(`${header} — ${locationLabel}\n${lines.join("\n")}`);
    } catch (error) {
      return toolError(error);
    }
  }
);
