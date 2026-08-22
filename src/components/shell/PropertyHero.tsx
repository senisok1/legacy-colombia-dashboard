import { getPropertyGroupPhotos } from "@/lib/listingPhotos";
import { propertyGroupById } from "@/lib/propertyGroups";
import { propertyLocationById } from "@/lib/propertyLocations";

// Dashboard hero banner (2026-08-22 UI refresh).
//
// Server component on purpose: the hero is the single most visually
// important image on the page, so it's rendered from the server's own
// cached photo lookup rather than waiting on the client's
// /api/property-visuals round-trip — no empty box, no late image pop-in.
//
// IMAGE RULE: the photo is whatever getPropertyGroupPhotos returns for THIS
// property group, i.e. that property's own OwnerRez listing photo, top of
// its own display order. There is no cross-property fallback anywhere in
// this path — a property with no photos gets a plain gradient panel with
// its name, never someone else's house. See lib/listingPhotos.ts.

export async function PropertyHero({ groupId }: { groupId: string }) {
  const group = propertyGroupById(groupId);
  const loc = propertyLocationById(groupId);
  const { photos } = await getPropertyGroupPhotos(groupId).catch(() => ({
    groupId,
    listingIds: [],
    photos: [],
  }));
  const hero = photos[0] ?? null;

  return (
    <section
      className="relative overflow-hidden rounded-2xl border"
      style={{
        borderColor: "var(--border-subtle, rgba(255,255,255,0.1))",
        // Sits behind the photo, and stands alone when there isn't one.
        background: "linear-gradient(135deg, #171C22 0%, #0E1116 100%)",
      }}
    >
      <div className="relative h-[150px] sm:h-[190px] lg:h-[230px]">
        {hero && (
          // Plain <img>, not next/image: OwnerRez's CDN (uc.orez.io) isn't in
          // next.config's remote patterns, and keeping this a bare tag keeps
          // the refresh a pure presentation change with no config surface.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero.largeUrl}
            alt={hero.caption ?? group.label}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {/* Dark gradient for text legibility over any photo. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(14,17,22,0.92) 0%, rgba(14,17,22,0.65) 45%, rgba(14,17,22,0.15) 100%)",
          }}
        />
        <div className="relative h-full flex flex-col justify-end p-4 sm:p-6">
          <h2
            className="text-xl sm:text-2xl lg:text-3xl font-semibold tracking-tight"
            style={{ color: "#F6F3EB" }}
          >
            {group.label}
          </h2>
          <p className="mt-0.5 text-[12px] sm:text-sm" style={{ color: "#B8B4AA" }}>
            {loc.label}
            {hero?.caption ? <span className="hidden sm:inline"> · {hero.caption}</span> : null}
          </p>
        </div>
      </div>
    </section>
  );
}
