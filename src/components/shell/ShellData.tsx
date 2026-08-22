"use client";

import { createContext, useContext, useEffect, useState } from "react";

// Shared client-side visual data for the new shell (2026-08-22 UI refresh):
// per-property thumbnails, the active property's photo set, its location /
// timezone, and current weather. Fetched ONCE per page load from
// /api/property-visuals and shared through context so the sidebar, the
// header strip and any hero all read the same snapshot instead of each
// firing their own request.
//
// Presentational only — nothing here feeds bookings, revenue, occupancy or
// any existing date logic.

export type GroupVisual = {
  groupId: string;
  label: string;
  location: string;
  thumbUrl: string | null;
  photoCount: number;
};

export type PhotoVisual = {
  caption: string | null;
  thumbUrl: string;
  largeUrl: string;
  originalUrl: string;
};

export type WeatherVisual = {
  groupId: string;
  temperature: number;
  unit: "fahrenheit" | "celsius";
  weatherCode: number;
  isDay: boolean;
};

export type ShellVisuals = {
  activeGroupId: string;
  groups: GroupVisual[];
  active: {
    groupId: string;
    location: string;
    timeZone: string;
    weather: WeatherVisual | null;
    photos: PhotoVisual[];
  } | null;
};

const ShellVisualsContext = createContext<ShellVisuals | null>(null);

export function useShellVisuals(): ShellVisuals | null {
  return useContext(ShellVisualsContext);
}

export function ShellVisualsProvider({
  fallbackGroups,
  activeGroupId,
  children,
}: {
  /** Server-known groups so the sidebar renders labels instantly, before
   *  the (photo-bearing) fetch lands. Avoids an empty nav on first paint. */
  fallbackGroups: { id: string; label: string }[];
  activeGroupId: string;
  children: React.ReactNode;
}) {
  const [visuals, setVisuals] = useState<ShellVisuals>(() => ({
    activeGroupId,
    groups: fallbackGroups.map((g) => ({
      groupId: g.id,
      label: g.label,
      location: "",
      thumbUrl: null,
      photoCount: 0,
    })),
    active: null,
  }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/property-visuals");
        if (!res.ok) return;
        const data = (await res.json()) as ShellVisuals;
        if (!cancelled && data?.groups?.length) setVisuals(data);
      } catch {
        // Purely decorative — keep the label-only fallback on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when the active property changes (a switch reloads the page,
    // so this is really just first-mount, but keeps the two in sync).
  }, [activeGroupId]);

  return <ShellVisualsContext.Provider value={visuals}>{children}</ShellVisualsContext.Provider>;
}
