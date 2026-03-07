# Weather Integration for Activity Analysis

**Date:** 2026-03-07
**Status:** Approved

## Problem

Run analyses don't consider weather conditions. Running in -30C vs 15C significantly affects effort, pace, and coaching interpretation, but the analysis pipeline has no awareness of weather.

## Design Decisions

- **Sync time** — Weather is fetched during `strava_sync`, not at agent analysis time. Historical weather never changes, and this keeps it always available in `get_run_analysis`.
- **Hourly data** — Fetch hourly weather for the activity's actual time window (not daily min/max) for accurate conditions.
- **Full weather data** — Temperature, feels-like, humidity, wind, gusts, precipitation, weather code. All from the same API call.
- **Separate table** — `activity_weather` table, not columns on `activity_analysis`. Weather is a property of the activity, not a derived metric.
- **Open-Meteo API** — Free, no API key, already used by the existing `get_weather` tool. Hourly archive endpoint for historical data.

## Schema

```sql
CREATE TABLE IF NOT EXISTS activity_weather (
  activity_id INTEGER PRIMARY KEY REFERENCES activities(id),
  temp_c REAL,
  feels_like_c REAL,
  humidity_pct REAL,
  wind_speed_kmh REAL,
  wind_gust_kmh REAL,
  precipitation_mm REAL,
  weather_code INTEGER,
  weather_description TEXT,
  fetched_at TEXT NOT NULL
);
```

## Fetch Logic

During `strava_sync`, for each new activity with location data (`start_latitude`/`start_longitude`):

1. Extract date and hour range from `start_date_local` + `moving_time`
2. Call Open-Meteo hourly archive API with params: `temperature_2m`, `relative_humidity_2m`, `apparent_temperature`, `precipitation`, `wind_speed_10m`, `wind_gusts_10m`, `weather_code`
3. Average numeric fields across the activity hours
4. Pick most frequent `weather_code` for the dominant condition
5. Store in `activity_weather`

API URL pattern:
```
https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lng}
  &hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code
  &start_date={date}&end_date={date}&timezone=auto
```

## Integration

### `get_run_analysis` output

Add a `weather` block:
```typescript
weather: {
  temp_c: number,
  feels_like_c: number,
  humidity_pct: number,
  wind_speed_kmh: number,
  wind_gust_kmh: number,
  precipitation_mm: number,
  description: string,
} | null
```

### Coaching analysis

No explicit skill changes needed. The strava-writeback skill tells the agent to consider all data from `get_run_analysis`. Weather will naturally factor into analysis when relevant (e.g., "cold conditions explain the slower pace", "rain and wind added difficulty").
