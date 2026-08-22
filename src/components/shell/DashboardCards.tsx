import Link from "next/link";
import { listConstructionItems } from "@/lib/construction";
import { getPropertyGroupPhotos } from "@/lib/listingPhotos";
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
