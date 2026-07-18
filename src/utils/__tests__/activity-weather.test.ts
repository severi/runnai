import { test, expect, describe, mock, afterEach } from "bun:test";
import { fetchActivityWeather } from "../activity-weather.js";

// Build hourly Open-Meteo data for the given dates where temperature ==
// hour-of-day, so sampled values directly reveal which hours were selected.
function hourlyDays(dates: string[]) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  for (const date of dates) {
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, "0");
      time.push(`${date}T${hh}:00`);
      temperature_2m.push(h); // temp encodes the hour
    }
  }
  const zeros = new Array(time.length).fill(0);
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

function hourlyDay() {
  return hourlyDays(["2026-06-21"]);
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

// The RTTS 100km failure: a 07:09 → 00:25 race spanning 17°C→30°C was stored as
// the single average "25°C", which the analysis quoted as "the temperature".
// Multi-hour conditions need the range and the hourly profile, not one number.
describe("fetchActivityWeather — duration-aware profile", () => {
  test("returns temp min/max and per-hour profile alongside the average", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(hourlyDay()), { status: 200 }),
    ) as unknown as typeof fetch;

    const w = await fetchActivityWeather(1, 61.16, 25.6, "2026-06-21T14:07:56Z", 3 * 3600);
    expect(w).not.toBeNull();
    expect(w!.temp_min_c).toBe(14);
    expect(w!.temp_max_c).toBe(17);
    expect(w!.hourly).not.toBeNull();
    expect(w!.hourly!.length).toBe(4);
    expect(w!.hourly![0].time).toBe("2026-06-21T14:00");
    expect(w!.hourly![0].temp_c).toBe(14);
    expect(w!.hourly![3].temp_c).toBe(17);
  });

  test("window crossing midnight includes next-day hours (fetches both days)", async () => {
    const requested: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify(hourlyDays(["2026-07-11", "2026-07-12"])), { status: 200 });
    }) as unknown as typeof fetch;

    // 19:07 local + 7h elapsed → hours 19..23 plus 00..02 next day.
    const w = await fetchActivityWeather(1, 51.6, -1.0, "2026-07-11T19:07:00Z", 7 * 3600);
    expect(w).not.toBeNull();
    expect(requested[0]).toContain("start_date=2026-07-11");
    expect(requested[0]).toContain("end_date=2026-07-12");
    expect(w!.hourly!.length).toBe(8);
    expect(w!.hourly![0].time).toBe("2026-07-11T19:00");
    expect(w!.hourly![7].time).toBe("2026-07-12T02:00");
    // Min comes from the small hours of the NEXT day — the old hour-of-day
    // clamp at 23 dropped these entirely.
    expect(w!.temp_min_c).toBe(0);
    expect(w!.temp_max_c).toBe(23);
  });
});
