import { test, expect, describe, mock, afterEach } from "bun:test";
import { fetchActivityWeather } from "../activity-weather.js";

// Build a full day of hourly Open-Meteo data where temperature == hour-of-day,
// so the averaged temp directly reveals which hours were sampled.
function hourlyDay() {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, "0");
    time.push(`2026-06-21T${hh}:00`);
    temperature_2m.push(h); // temp encodes the hour
  }
  const zeros = new Array(24).fill(0);
  return {
    hourly: {
      time,
      temperature_2m,
      relative_humidity_2m: zeros,
      apparent_temperature: temperature_2m,
      precipitation: zeros,
      wind_speed_10m: zeros,
      wind_gusts_10m: zeros,
      weather_code: zeros,
    },
  };
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("fetchActivityWeather — local-time window selection", () => {
  // Regression: start_date_local is wall-clock local but carries a "Z" suffix.
  // Routing it through new Date()/.getHours() re-localized it to the host timezone,
  // shifting the sampled window by the machine's UTC offset (on a +3 host the
  // 14:00–17:00 run was read as 17:00–20:00 — the evening, undersampling the peak).
  test("samples the run's wall-clock hours, not the host-offset hours", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(hourlyDay()), { status: 200 }),
    ) as unknown as typeof fetch;

    // 14:07 local for ~3h (moving_time 3*3600) → window hours 14..17.
    const w = await fetchActivityWeather(1, 61.16, 25.6, "2026-06-21T14:07:56Z", 3 * 3600);
    expect(w).not.toBeNull();
    // temp == hour, so avg over hours 14,15,16,17 = 15.5 regardless of host TZ.
    expect(w!.temp_c).toBe(15.5);
  });
});
