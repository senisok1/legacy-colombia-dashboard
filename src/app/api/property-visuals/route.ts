import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getPropertyGroupPhotos } from "@/lib/listingPhotos";
import { getPropertyWeather } from "@/lib/weather";
import { propertyLocationById } from "@/lib/propertyLocations";
import { allowedPropertyGroups, effectivePropertyGroupId, PROPERTY_GROUP_COOKIE } from "@/lib/propertyGroups";
import { getUserByEmail } from "@/lib/users";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Feeds the new shell (2026-08-22 UI refresh) with everything visual that
// depends on WHICH property is selected:
//   - a thumbnail per property for the sidebar's property switcher
//   - the active property's photo set (hero + supporting thumbnails)
//   - the active property's location, timezone and current weather
//
// Read-only and presentational. Deliberately a separate client-fetched
// route rather than server-rendered into the root layout: the layout runs on
// EVERY page, and fetching five properties' listing content there would put
// OwnerRez calls in the critical path of every single navigation. Here it's
// one call after paint, and everything underneath is already cached (photos
// 6h, weather 30min), so steady-state cost is ~zero.
//
// PROPERTY SCOPING: groups come from allowedPropertyGroups(user.propertyAccess),
// the same gate the switcher itself uses, and each group's photos are
// fetched per-group — so a login can never be handed imagery for a property
// it isn't allowed to see, and no property can be handed another's photos.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const me = await getUserByEmail(session.email).catch(() => null);
  const groups = allowedPropertyGroups(me?.propertyAccess);
  const activeId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, me?.propertyAccess);

  // Every allowed group's photos, in parallel. Each is independently cached,
  // so this is cheap after the first warm-up and never blocks a page render.
  const perGroup = await Promise.all(
    groups.map(async (g) => {
      const photos = await getPropertyGroupPhotos(g.id).catch(() => ({
        groupId: g.id,
        listingIds: [],
        photos: [],
      }));
      const loc = propertyLocationById(g.id);
      return {
        groupId: g.id,
        label: g.label,
        location: loc.label,
        // photos[0] is OwnerRez's own top photo for the listing — Seni's
        // explicit ask ("use the top photos for each property").
        thumbUrl: photos.photos[0]?.thumbUrl ?? null,
        photoCount: photos.photos.length,
      };
    })
  );

  const active = await getPropertyGroupPhotos(activeId).catch(() => ({
    groupId: activeId,
    listingIds: [],
    photos: [],
  }));
  const weather = await getPropertyWeather(activeId).catch(() => null);
  const loc = propertyLocationById(activeId);

  return NextResponse.json({
    activeGroupId: activeId,
    groups: perGroup,
    active: {
      groupId: activeId,
      location: loc.label,
      timeZone: loc.timeZone,
      weather,
      // A generous slice for hero + supporting cards; the full set can run
      // to 100+ photos and there's no view that needs them all.
      photos: active.photos.slice(0, 12),
    },
  });
}
