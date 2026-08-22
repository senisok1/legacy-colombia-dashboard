import Link from "next/link";
import { listConstructionItems } from "@/lib/construction";
import { getPropertyGroupPhotos } from "@/lib/listingPhotos";
import { getSnapshotThreadSummaries } from "@/lib/inbox";
import { listTeamRequests } from "@/lib/teamRequests";
import { listUsers } from "@/lib/users";
import { DonutRing } from "./MiniCharts";

// Dashboard summary cards (2026-08-22 UI refresh, Seni's ask for "more data
// with images, different charts, graphs, photos").
//
// IMPORTANT SCOPE NOTE: these are read-only VIEWS of data that already
// exists in other modules — no new tables, no new workflows, no new
// business logic, and every card links through to the module that owns the
// data ("View all →"). Nothing here can create, edit or delete anything.
// That keeps the refresh presentation-only as briefed while still making
// the dashboard feel like an operations cockpit.

function Card({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 md:p-4 bg-white dark:bg-white/5 flex flex-col">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {href && (
          <Link href={href} className="text-xs text-[var(--accent)] hover:underline shrink-0">
            {linkLabel ?? "View all"} →
          </Link>
        )}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** Open construction work, grouped by category, with a completion ring.
 *  Reads listConstructionItems — the same source the Construction tab uses. */
export async function ConstructionOverviewCard({
  organizationId,
  groupId,
}: {
  organizationId: string;
  groupId: string;
}) {
  const items = await listConstructionItems(organizationId, groupId).catch(() => []);
  if (items.length === 0) return null;

  const done = items.filter((i) => i.completed).length;
  const pct = Math.round((done / items.length) * 100);

  // Open items per category, biggest first — mirrors how the Construction
  // tab already groups them.
  const byCategory = new Map<string, number>();
  for (const i of items) {
    if (i.completed) continue;
    const key = i.category?.trim() || "Uncategorized";
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  const rows = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <Card title="Construction overview" href="/construction" linkLabel="Go to construction">
      <div className="flex items-center gap-4">
        <div className="shrink-0 text-black/70 dark:text-white/70">
          <DonutRing pct={pct} size={78} stroke={7} label={`${pct}%`} />
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {rows.length === 0 ? (
            <li className="text-sm text-black/50 dark:text-white/50">Everything is complete.</li>
          ) : (
            rows.map(([label, count]) => (
              <li key={label} className="flex items-center gap-2 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="tabular-nums text-black/60 dark:text-white/60">{count}</span>
              </li>
            ))
          )}
        </ul>
      </div>
      <p className="mt-3 text-xs text-black/40 dark:text-white/40">
        {done} of {items.length} items complete · counts are open items per category
      </p>
    </Card>
  );
}

/** Short relative time, e.g. "6m ago" / "3h ago" / "2d ago". */
function timeAgo(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

/** The newest guest conversations, from the SAME Redis snapshot the Inbox
 *  paints from — so this card costs no extra OwnerRez calls and can never
 *  disagree with what the Messaging tab shows. Read-only: it lists and
 *  links, it never sends or drafts anything. Renders nothing (rather than
 *  an empty box) when the snapshot hasn't been built yet. */
export async function RecentMessagesCard({
  organizationId,
  groupId,
}: {
  organizationId: string;
  groupId: string;
}) {
  const threads = await getSnapshotThreadSummaries(organizationId, groupId).catch(() => null);
  if (!threads || threads.length === 0) return null;

  const recent = [...threads]
    .filter((t) => t.lastMessage?.sentAt)
    .sort((a, b) => (b.lastMessage!.sentAt! > a.lastMessage!.sentAt! ? 1 : -1))
    .slice(0, 5);
  if (recent.length === 0) return null;

  return (
    <Card title="Recent messages" href="/messaging" linkLabel="Go to messaging">
      <ul className="space-y-2.5">
        {recent.map((t) => {
          const msg = t.lastMessage!;
          const name = t.guestName || "Guest";
          return (
            <li key={t.threadId} className="flex items-start gap-2.5">
              <span
                className="mt-0.5 shrink-0 grid place-items-center rounded-full text-[11px] font-semibold"
                style={{
                  width: 28,
                  height: 28,
                  background: "rgba(20,184,166,0.16)",
                  color: "var(--accent)",
                }}
                aria-hidden
              >
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-black/40 dark:text-white/40">
                    {timeAgo(msg.sentAt)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-start gap-2">
                  <span className="min-w-0 flex-1 line-clamp-1 text-xs text-black/50 dark:text-white/50">
                    {msg.body?.trim() || "—"}
                  </span>
                  {/* Mirrors the Inbox's own "waiting on a host reply"
                      signal rather than inventing a new status. */}
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${
                      t.awaitingReply
                        ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                        : "bg-black/10 dark:bg-white/10 text-black/50 dark:text-white/50"
                    }`}
                  >
                    {t.awaitingReply ? "Needs reply" : "Replied"}
                  </span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Today's operating picture: who's on the team, how many stays are coming,
 *  open construction work, and team requests still awaiting a decision —
 *  each already owned by another module, counted here and linked out to.
 *  Paired with one of this property's own photos, per the mock. */
export async function TeamOperationsCard({
  organizationId,
  groupId,
  upcomingStays,
}: {
  organizationId: string;
  groupId: string;
  /** Passed in from the page, which has already computed it — avoids a
   *  second pass over bookings just to count them. */
  upcomingStays: number;
}) {
  const [users, requests, items, photos] = await Promise.all([
    listUsers(organizationId).catch(() => []),
    listTeamRequests(organizationId, groupId).catch(() => []),
    listConstructionItems(organizationId, groupId).catch(() => []),
    getPropertyGroupPhotos(groupId).catch(() => ({ groupId, listingIds: [], photos: [] })),
  ]);

  const openTasks = items.filter((i) => !i.completed).length;
  // "Pending" = raised but nobody has accepted or declined it yet, the same
  // state the Team Activity Log surfaces for action.
  const pendingRequests = requests.filter((r) => !r.accepted && !r.declined && !r.completed).length;
  // A photo from further into the set, so this card doesn't repeat the hero
  // or the gallery strip above it.
  const photo = photos.photos[7] ?? photos.photos[photos.photos.length - 1] ?? null;

  const rows = [
    { label: "On the house", value: `${users.length} team member${users.length === 1 ? "" : "s"}` },
    { label: "Upcoming stays", value: `${upcomingStays} reservation${upcomingStays === 1 ? "" : "s"}` },
    { label: "Open tasks", value: `${openTasks} open task${openTasks === 1 ? "" : "s"}` },
    { label: "Pending requests", value: `${pendingRequests} team request${pendingRequests === 1 ? "" : "s"}` },
  ];

  return (
    <Card title="Team operations" href="/management" linkLabel="Go to team">
      <div className="flex gap-4">
        <ul className="min-w-0 flex-1 space-y-2.5">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="text-sm font-medium">{r.label}</div>
              <div className="text-xs text-black/50 dark:text-white/50">{r.value}</div>
            </li>
          ))}
        </ul>
        {photo && (
          <div className="hidden sm:block relative w-[40%] shrink-0 overflow-hidden rounded-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.largeUrl}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        )}
      </div>
    </Card>
  );
}

/** A strip of this property's own OwnerRez photography. Purely visual — the
 *  brief asks for the CRM to feel like the property it manages. Photos come
 *  from getPropertyGroupPhotos, which can only ever return THIS property's
 *  images (see lib/listingPhotos.ts). */
export async function PropertyGalleryCard({ groupId, label }: { groupId: string; label: string }) {
  const { photos } = await getPropertyGroupPhotos(groupId).catch(() => ({
    groupId,
    listingIds: [],
    photos: [],
  }));
  // Skip the first photo — it's already the hero at the top of the page.
  const strip = photos.slice(1, 7);
  if (strip.length < 3) return null;

  return (
    <Card title="The property">
      <div className="grid grid-cols-3 gap-2">
        {strip.map((p, i) => (
          <div key={i} className="relative overflow-hidden rounded-lg aspect-[4/3]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.thumbUrl}
              alt={p.caption ?? label}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-xs text-black/40 dark:text-white/40 truncate">
        {strip[0]?.caption ? `${strip[0].caption} · ` : ""}from this listing&apos;s OwnerRez photos
      </p>
    </Card>
  );
}
