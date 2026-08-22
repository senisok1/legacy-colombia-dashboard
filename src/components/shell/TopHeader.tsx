"use client";

import { useState, useSyncExternalStore } from "react";
import { useT } from "@/components/LanguageProvider";
import { useCurrency } from "@/components/CurrencyProvider";
import { useShellVisuals } from "./ShellData";
import { IconRefresh } from "./NavIcons";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import type { NavBadges } from "./useNavBadges";

// Simplified desktop top header (2026-08-22 UI refresh). Now that navigation
// lives in the sidebar, this is just: page title + a compact
// weather · location · local date · local time strip on the left, and the
// existing global controls on the right.
//
// TIMEZONE: the clock deliberately renders in the SELECTED PROPERTY's IANA
// zone (via Intl's timeZone option), not the viewer's browser zone — an
// explicit requirement, since Seni manages Colombian and Florida properties
// from a different zone than either. This is display-only and touches none
// of the app's existing reservation/operations date handling.

/** Maps a WMO weather code (Open-Meteo) to a simple glyph. Grouped rather
 *  than exhaustive — the strip is a glance, not a forecast. */
function weatherGlyph(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code <= 2) return isDay ? "🌤️" : "☁️";
  if (code === 3) return "☁️";
  if (code >= 45 && code <= 48) return "🌫️";
  if (code >= 51 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

// Ticks every 30s. Read through useSyncExternalStore rather than
// useState+useEffect: a clock rendered on the server would hydrate-mismatch
// instantly, and seeding it from inside an effect is a cascading render.
// The server snapshot is null (renders nothing), the client snapshot is the
// current 30-second bucket — stable between ticks, which is what
// getSnapshot requires.
function subscribeClock(onChange: () => void): () => void {
  const id = setInterval(onChange, 30_000);
  return () => clearInterval(id);
}
const clockSnapshot = () => Math.floor(Date.now() / 30_000);
const clockServerSnapshot = () => null;

function LocalClock({ timeZone, locale }: { timeZone: string; locale: string }) {
  const tick = useSyncExternalStore(subscribeClock, clockSnapshot, clockServerSnapshot);
  if (tick === null) return null;
  const now = new Date();
  const date = now.toLocaleDateString(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = now.toLocaleTimeString(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <>
      <span className="opacity-40">·</span>
      <span>{date}</span>
      <span className="opacity-40">·</span>
      <span>{time}</span>
    </>
  );
}

export function TopHeader({
  title,
  locale,
  role,
  badges,
}: {
  title: string;
  locale: string;
  role?: string;
  badges: NavBadges;
}) {
  const t = useT();
  const visuals = useShellVisuals();
  const active = visuals?.active;
  const { secondaryCurrency, displayCurrency, setDisplayCurrency, rate } = useCurrency();
  const [refreshing, setRefreshing] = useState(false);
  // Same role gate the sidebar uses for admin-only modules.
  const isTeam = role === "READ_ONLY" || role === "CONSTRUCTION";

  const currencyTitle = rate
    ? `1 USD ≈ ${rate.usdToTarget.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${secondaryCurrency}${
        rate.source === "fallback" ? ` (${t("nav.fallbackRateNote")})` : ""
      }`
    : t("nav.loadingExchangeRate");

  return (
    <header
      className="sticky top-0 z-20 border-b backdrop-blur"
      style={{
        borderColor: "var(--border-subtle, rgba(255,255,255,0.1))",
        background: "color-mix(in srgb, var(--background) 88%, transparent)",
      }}
    >
      <div className="flex items-center gap-4 px-4 md:px-6 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] md:text-lg font-semibold leading-tight truncate">{title}</h1>
          {active && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-black/50 dark:text-white/50 flex-wrap">
              {active.weather && (
                <>
                  <span aria-hidden>{weatherGlyph(active.weather.weatherCode, active.weather.isDay)}</span>
                  <span>
                    {active.weather.temperature}°{active.weather.unit === "celsius" ? "C" : "F"}
                  </span>
                  <span className="opacity-40">·</span>
                </>
              )}
              <span className="truncate">{active.location}</span>
              <LocalClock timeZone={active.timeZone} locale={locale} />
            </div>
          )}
        </div>

        {/* Search + notifications are ADMIN-ONLY (2026-08-22, built at
            Seni's request). Both are hidden for READ_ONLY and CONSTRUCTION
            logins, and their API routes aren't in proxy.ts's team allowlist,
            so the restriction holds even if someone calls them directly.
            Reason: search surfaces guest profiles under /guests, which is
            in TEAM_BLOCKED_PREFIXES — showing team logins results they
            can't open would be worse than not showing the control. Neither
            role ever had these features, so nothing is taken away. */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!isTeam && <GlobalSearch />}
          {!isTeam && <NotificationBell badges={badges} />}
          {secondaryCurrency && (
            <div
              className="flex items-center rounded-lg bg-black/5 dark:bg-white/10 p-0.5 shrink-0"
              title={currencyTitle}
            >
              {["USD", secondaryCurrency].map((c) => (
                <button
                  key={c}
                  onClick={() => setDisplayCurrency(c)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    displayCurrency === c
                      ? "bg-[var(--accent)] text-[#0E1116]"
                      : "text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              setRefreshing(true);
              window.location.reload();
            }}
            disabled={refreshing}
            title={t("nav.refreshTitle")}
            className="rounded-lg p-2 text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-60"
          >
            <IconRefresh className={`w-[18px] h-[18px] ${refreshing ? "animate-spin" : ""}`} />
            <span className="sr-only">{t("nav.refresh")}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
