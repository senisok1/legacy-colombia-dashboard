import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import type { getBookings, getGuests } from "@/lib/ownerrez";
import { redisGet } from "@/lib/redis";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { effectivePropertyGroupId, PROPERTY_GROUP_COOKIE } from "@/lib/propertyGroups";
import { getUserByEmail } from "@/lib/users";
import { visibleEntriesFor } from "@/lib/navModel";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// Global search (2026-08-22, Seni's ask to build the mock's search icon for
// real). Searches the things an owner actually looks for by name:
//   - GUESTS (name, email, phone) → their CRM profile
//   - STAYS  (guest name, booking id, source) → the guest's profile
//   - PAGES  (module names) → jump straight to a tab
//
// SCOPING, deliberately: bookings and guests come from the Dashboard's
// per-org, per-property Redis snapshot (see the perf note below), which was
// itself built from the property-scoped fetchers — so a search can only
// ever return records for the property currently selected. Page results are
// filtered through
// visibleEntriesFor(role, group) — the SAME function the sidebar uses — so
// search can never surface a module the signed-in role isn't allowed to
// open. A READ_ONLY login searching "bill" gets nothing, exactly as its nav
// shows nothing.
//
// Read-only: this route returns links. It cannot mutate anything.

export type SearchResult = {
  type: "guest" | "stay" | "page";
  title: string;
  subtitle: string;
  href: string;
};

/** Case/accent-insensitive contains — guest names here are routinely
 *  accented (Peñol, Velez/Vélez, Jiménez), and an owner typing plain ASCII
 *  should still find them. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    // Strip combining diacritical marks (U+0300–U+036F).
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const raw = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (raw.length < 2) return NextResponse.json({ results: [] });
  const q = norm(raw);

  const me = await getUserByEmail(session.email).catch(() => null);
  const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, me?.propertyAccess);

  // Pages first — instant, and usually what a two-letter query means.
  const pages: SearchResult[] = [];
  for (const entry of visibleEntriesFor(session.role, groupId)) {
    const items =
      entry.type === "link"
        ? [{ label: entry.label, href: entry.href }]
        : entry.tabs.map((t) => ({ label: t.label, href: t.href }));
    for (const it of items) {
      if (norm(it.label).includes(q)) {
        pages.push({ type: "page", title: it.label, subtitle: "Go to page", href: it.href });
      }
    }
  }

  // PERF, learned the hard way (2026-08-22): calling getBookings/getGuests
  // directly here made search hang for tens of seconds and froze the tab —
  // the cold getGuests path fans out one request per guest through a
  // 1-req/sec queue. Search must never pay that cost.
  //
  // Instead read the SAME Redis snapshot the Dashboard already writes
  // (ssrSnapshotFirst, key below), which holds bookings + guests for this
  // org+property. That makes search an O(1) lookup, adds ZERO OwnerRez
  // load, and is the identical serve-stale pattern the Inbox, Team
  // Management and Commissions tabs all use. If no snapshot exists yet
  // (first visit for this property, or TTL expired), search returns just
  // page matches rather than blocking — the Dashboard seeds the snapshot
  // within one page view.
  let bookings: Awaited<ReturnType<typeof getBookings>> = [];
  let guests: Awaited<ReturnType<typeof getGuests>> = [];
  try {
    const raw = await redisGet(`dashboard:data:${session.organizationId}:${groupId}`);
    if (raw) {
      const snap = JSON.parse(raw) as { bookings?: typeof bookings; guests?: typeof guests };
      bookings = snap.bookings ?? [];
      guests = snap.guests ?? [];
    }
  } catch {
    // Cache miss or hiccup — degrade to page-only results, never hang.
  }
  const guestsById = buildGuestsById(guests);

  const guestResults: SearchResult[] = [];
  for (const g of guests) {
    const hay = norm([g.fullName, g.email ?? "", g.phone ?? "", g.city ?? "", g.country ?? ""].join(" "));
    if (!hay.includes(q)) continue;
    guestResults.push({
      type: "guest",
      title: g.fullName || `Guest ${g.id}`,
      subtitle: [g.email, g.phone, [g.city, g.country].filter(Boolean).join(", ")]
        .filter(Boolean)
        .join(" · ") || "Guest profile",
      href: `/guests/${g.id}`,
    });
    if (guestResults.length >= 8) break;
  }

  const stayResults: SearchResult[] = [];
  // Most recent first: an owner searching a name almost always wants the
  // current or next stay, not one from two years ago.
  const sorted = [...bookings]
    .filter((b) => !b.isBlock)
    .sort((a, b) => (b.arrival ?? "").localeCompare(a.arrival ?? ""));
  for (const b of sorted) {
    const name = resolveGuestName(b, guestsById) || b.guestName || "";
    const hay = norm([name, String(b.id), b.source ?? "", b.status ?? ""].join(" "));
    if (!hay.includes(q)) continue;
    stayResults.push({
      type: "stay",
      title: `${name || "Guest"} — ${fmtDate(b.arrival)}`,
      subtitle: `${b.nights} night${b.nights === 1 ? "" : "s"} · ${b.source || "—"} · ${b.status}`,
      // Stays don't have their own detail route; the guest profile is where
      // a stay's context actually lives, so link there rather than inventing
      // a page.
      href: b.guestId ? `/guests/${b.guestId}` : "/management",
    });
    if (stayResults.length >= 8) break;
  }

  return NextResponse.json({
    results: [...pages.slice(0, 5), ...guestResults, ...stayResults],
  });
}
