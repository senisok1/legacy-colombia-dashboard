import { unstable_cache } from "next/cache";
import { propertyLocationById } from "./propertyLocations";

// Current conditions at a property (2026-08-22, for the UI refresh's header
// strip). Uses Open-Meteo: free, no API key, no account, generous rate
// limits — deliberately chosen so this cosmetic feature can never become a
// billing or credential-rotation problem, and so a failure here degrades to
// "no weather shown" rather than blocking a page that's really about
// bookings and money.
//
// SCOPE: display only. Per Seni's spec this is "visual supplemental
// information" — it must not touch reservation/occupancy/revenue logic or
// the app's existing timezone handling, and it doesn't: nothing else reads
// from this module.

export type PropertyWeather = {
  groupId: string;
  temperature: number;
  unit: "fahrenheit" | "celsius";
  /** WMO weather code from Open-Meteo, mapped to an icon by the client. */
  weatherCode: number;
  isDay: boolean;
};

async function fetchWeather(groupId: string): Promise<PropertyWeather | null> {
  const loc = propertyLocationById(groupId);
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(loc.latitude));
    url.searchParams.set("longitude", String(loc.longitude));
    url.searchParams.set("current", "temperature_2m,weather_code,is_day");
    url.searchParams.set("temperature_unit", loc.unit);
    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number; is_day?: number };
    };
    const cur = json.current;
    if (!cur || typeof cur.temperature_2m !== "number") return null;
    return {
      groupId,
      temperature: Math.round(cur.temperature_2m),
      unit: loc.unit,
      weatherCode: typeof cur.weather_code === "number" ? cur.weather_code : 0,
      isDay: cur.is_day !== 0,
    };
  } catch {
    // Cosmetic feature — never surface an error, just render without it.
    return null;
  }
}

/** Cached 30min: weather barely moves, and this sits in every page render. */
export const getPropertyWeather = unstable_cache(fetchWeather, ["property-weather-v1"], {
  revalidate: 30 * 60,
});
