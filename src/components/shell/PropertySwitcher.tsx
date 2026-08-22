"use client";

import { useState } from "react";
import { useT } from "@/components/LanguageProvider";
import type { GroupVisual } from "./ShellData";

// Property switcher for the sidebar (2026-08-22 UI refresh). Behavior is
// carried over unchanged from NavBar.tsx's wordmark dropdown: pick a
// property → POST /api/settings/property-group → reload, which re-scopes
// the whole dashboard via the lc_property_group cookie. Only the
// presentation changed (a vertical list with real per-property thumbnails
// instead of a text-only dropdown).
//
// THUMBNAILS: each row shows that property's OWN top OwnerRez photo, passed
// in from /api/property-visuals. Never a stock image, never another
// property's photo — a property whose photos haven't loaded (or that has
// none) gets a neutral monogram tile instead. See lib/listingPhotos.ts.

export function PropertySwitcher({
  groups,
  activeGroupId,
  collapsed,
}: {
  groups: GroupVisual[];
  activeGroupId: string;
  collapsed: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const active = groups.find((g) => g.groupId === activeGroupId) ?? groups[0];

  async function choose(groupId: string) {
    if (groupId === activeGroupId || switching) {
      setOpen(false);
      return;
    }
    setSwitching(groupId);
    try {
      const res = await fetch("/api/settings/property-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      if (res.ok) window.location.reload();
      else setSwitching(null);
    } catch {
      setSwitching(null);
    }
  }

  if (!active) return null;

  // Collapsed rail: just the active property's thumbnail, which reopens the
  // full list on click. Keeps property switching reachable at every width.
  if (collapsed) {
    return (
      <div className="px-2 py-3">
        <button
          onClick={() => setOpen((o) => !o)}
          title={`${active.label} — ${t("nav.switchProperty")}`}
          className="w-full flex items-center justify-center"
        >
          <Thumb group={active} size={36} activeRing />
        </button>
        {open && (
          <div className="mt-2 space-y-1">
            {groups.map((g) => (
              <button
                key={g.groupId}
                onClick={() => void choose(g.groupId)}
                title={g.label}
                className="w-full flex items-center justify-center py-1"
              >
                <Thumb group={g} size={30} activeRing={g.groupId === activeGroupId} />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition-colors"
        style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.1))" }}
      >
        <Thumb group={active} size={38} activeRing />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{active.label}</span>
          <span className="block truncate text-[11px] text-black/50 dark:text-white/50">
            {switching ? t("nav.switching") : active.location}
          </span>
        </span>
        <span className={`text-[10px] opacity-60 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>

      {open && (
        <ul className="mt-1.5 space-y-0.5">
          {groups.map((g) => {
            const isActive = g.groupId === activeGroupId;
            return (
              <li key={g.groupId}>
                <button
                  onClick={() => void choose(g.groupId)}
                  disabled={switching !== null}
                  className={`w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-60 ${
                    isActive ? "bg-[var(--accent)]/12 text-[var(--accent)]" : "hover:bg-black/5 dark:hover:bg-white/10"
                  }`}
                >
                  <Thumb group={g} size={28} activeRing={isActive} />
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  {switching === g.groupId && <span className="text-[10px] opacity-60">…</span>}
                  {isActive && switching === null && <span className="text-[11px]">✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A property's own top OwnerRez photo, or a neutral monogram fallback —
 *  never another property's image. */
function Thumb({ group, size, activeRing }: { group: GroupVisual; size: number; activeRing?: boolean }) {
  const ring = activeRing ? "ring-2 ring-[var(--accent)]" : "ring-1 ring-white/10";
  if (!group.thumbUrl) {
    return (
      <span
        className={`shrink-0 rounded-lg ${ring} flex items-center justify-center bg-white/5 text-[10px] font-semibold tracking-wide`}
        style={{ width: size, height: size }}
      >
        {group.label.replace(/^Legacy\s*/i, "").slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    // Plain <img>, not next/image: OwnerRez's CDN (uc.orez.io) isn't in
    // next.config's remote patterns, and adding a loader for decorative
    // thumbnails isn't worth the config surface on a presentation-only change.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={group.thumbUrl}
      alt=""
      loading="lazy"
      className={`shrink-0 rounded-lg object-cover ${ring}`}
      style={{ width: size, height: size }}
    />
  );
}
